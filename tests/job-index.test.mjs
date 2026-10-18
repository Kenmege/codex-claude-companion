import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import * as state from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

test("concurrent processes retain every distinct job's latest update", { timeout: 30000 }, async () => {
  const cwd = makeTempDir();
  const barrier = makeTempDir();
  state.saveState(cwd, { config: { stopReviewGate: true }, jobs: [] });
  const count = 4;
  const rounds = 20;
  const children = Array.from({ length: count }, (_, index) => {
    const code = `import fs from 'node:fs';
      import * as state from ${JSON.stringify(stateUrl)};
      const cwd = ${JSON.stringify(cwd)}, barrier = ${JSON.stringify(barrier)};
      const stateFile = state.resolveStateFile(cwd);
      const read = fs.readFileSync.bind(fs);
      let armed = false, round = 0;
      fs.readFileSync = function(file, ...args) {
        const value = read(file, ...args);
        if (armed && String(file) === stateFile) {
          armed = false;
          fs.writeFileSync(barrier + '/' + round + '-${index}', 'ready');
          const deadline = Date.now() + 10000;
          while (Array.from({length: ${count}}, (_, i) => barrier + '/' + round + '-' + i).some(p => !fs.existsSync(p))) {
            if (Date.now() > deadline) throw new Error('read barrier timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          }
        }
        return value;
      };
      for (round = 1; round <= ${rounds}; round++) {
        armed = true;
        state.upsertJob(cwd, {id: 'worker-${index}', status: 'running', progress: round, summary: 'round-' + round});
      }`;
    return spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
  });
  await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const jobs = state.listJobs(cwd);
  assert.equal(jobs.length, count);
  for (let index = 0; index < count; index++) {
    const job = jobs.find(item => item.id === `worker-${index}`);
    assert.equal(job?.progress, rounds, `worker-${index} lost its latest update`);
    assert.equal(job.summary, `round-${rounds}`);
    assert.ok(job.createdAt);
    assert.ok(job.updatedAt);
    assert.deepEqual(state.readJobFile(state.resolveJobFile(cwd, job.id)), job);
  }
});

test("legacy index migrates missing files and metadata once without replacing newer records", () => {
  const cwd = makeTempDir();
  const existing = { id: "existing", status: "running", progress: 5 };
  state.writeJobFile(cwd, existing.id, existing);
  const legacy = [
    { ...existing, progress: 1, summary: "legacy summary", createdAt: "2020-01-01", updatedAt: "2020-01-02" },
    { id: "missing", status: "completed", summary: "legacy result", updatedAt: "2020-01-03" }
  ];
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ config: { stopReviewGate: true }, jobs: legacy }));
  const loaded = state.loadState(cwd);
  assert.equal(loaded.jobs.length, 2);
  assert.equal(loaded.config.stopReviewGate, true);
  assert.equal(state.readJobFile(state.resolveJobFile(cwd, "missing")).summary, "legacy result");
  const migrated = state.readJobFile(state.resolveJobFile(cwd, "existing"));
  assert.equal(migrated.progress, 5);
  assert.equal(migrated.summary, "legacy summary");
  assert.equal(migrated.createdAt, "2020-01-01");
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(state.resolveStateFile(cwd))), "jobs"), false);
  fs.unlinkSync(state.resolveJobFile(cwd, "missing"));
  assert.deepEqual(state.listJobs(cwd).map(job => job.id), ["existing"]);
});

test("directory listing ignores markers and temporary files and overlays terminal state", () => {
  const cwd = makeTempDir();
  const file = state.writeJobFile(cwd, "visible", { id: "visible", status: "running", summary: "kept" });
  fs.writeFileSync(state.terminalMarkerFile(file), JSON.stringify({ id: "visible", status: "completed" }));
  fs.writeFileSync(path.join(state.resolveJobsDir(cwd), "orphan.terminal.json"), "not a job");
  fs.writeFileSync(`${file}.tmp`, "partial");
  assert.deepEqual(state.listJobs(cwd), [{ id: "visible", status: "completed", summary: "kept" }]);
  assert.equal(fs.existsSync(state.resolveStateFile(cwd)), false);
});

test("terminal publication preserves metadata and advances retention ordering", () => {
  const cwd = makeTempDir();
  state.upsertJob(cwd, { id: "older", status: "running", createdAt: "2020-01-01", updatedAt: "2020-01-01", summary: "keep" });
  state.upsertJob(cwd, { id: "newer", status: "running", updatedAt: "2020-01-02" });
  state.publishTerminalJob(cwd, "older", { id: "older", status: "completed", completedAt: "2020-01-03" });
  const jobs = state.listJobs(cwd);
  assert.deepEqual(jobs.map(job => job.id), ["older", "newer"]);
  assert.equal(jobs[0].summary, "keep");
  assert.equal(jobs[0].createdAt, "2020-01-01");
  assert.equal(jobs[0].updatedAt, "2020-01-03");
});

test("saving a stale configuration snapshot does not remove a later job", () => {
  const cwd = makeTempDir();
  const stale = state.loadState(cwd);
  state.upsertJob(cwd, { id: "later", status: "running" });
  state.saveState(cwd, { ...stale, config: { stopReviewGate: true } });
  assert.deepEqual(state.listJobs(cwd).map(job => job.id), ["later"]);
  assert.equal(state.getConfig(cwd).stopReviewGate, true);
});
