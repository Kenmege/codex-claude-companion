import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import * as state from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

test("a job update resolves its workspace once and later updates resolve it afresh", (t) => {
  const cwd = makeTempDir();
  const firstRoot = makeTempDir();
  const secondRoot = makeTempDir();
  const originalSpawn = childProcess.spawnSync;
  let root = firstRoot;
  let discoveries = 0;
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
      if (process.platform === "win32") assert.equal(options.shell, false, "native Git discovery must not start PowerShell");
      discoveries++;
      return { status: 0, stdout: root, stderr: "" };
    }
    return originalSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  state.upsertJob(cwd, { id: "first", status: "running" });
  assert.equal(discoveries, 1, "one update must not repeatedly spawn Git");
  root = secondRoot;
  state.upsertJob(cwd, { id: "second", status: "running" });
  assert.equal(discoveries, 2, "a later operation must not reuse stale workspace discovery");
  assert.deepEqual(state.listJobs(cwd).map(job => job.id), ["second"]);
  root = firstRoot;
  assert.deepEqual(state.listJobs(cwd).map(job => job.id), ["first"]);
});

test("loadState skips unparsable records without changing or pruning them", (t) => {
  const cwd = makeTempDir();
  const valid = { id: "task-good", status: "running" };
  state.writeJobFile(cwd, valid.id, valid);
  const diagnostics = [];
  t.mock.method(console, "warn", message => diagnostics.push(message));
  const malformed = ['{"id":"task-bad1","sta', "null", "[]", '"text"', "42", "false", "{}", '{"id":1}'];
  const files = malformed.map((bytes, index) => {
    const file = state.resolveJobFile(cwd, `bad-${index}`);
    fs.writeFileSync(file, bytes);
    return file;
  });

  assert.deepEqual(state.loadState(cwd).jobs, [valid]);
  assert.equal(diagnostics.length, files.length);
  files.forEach(file => assert.equal(diagnostics.filter(message => message.includes(file)).length, 1));
  assert.throws(() => state.readJobFile(files[0]), SyntaxError);
  for (let index = 0; index < 51; index++) {
    const terminal = { id: `terminal-${index}`, status: "completed", updatedAt: String(index).padStart(2, "0") };
    const file = state.resolveJobFile(cwd, terminal.id);
    fs.writeFileSync(file, JSON.stringify(terminal));
    fs.writeFileSync(state.terminalMarkerFile(file), JSON.stringify(terminal));
  }
  // Even a terminal marker cannot make a truncated base record safe to prune.
  fs.writeFileSync(state.terminalMarkerFile(files[0]), JSON.stringify({
    id: "bad-0", status: "completed", updatedAt: "0000"
  }));
  diagnostics.length = 0;
  const saved = state.saveState(cwd, { config: {} });
  assert.equal(saved.jobs.length, 51);
  assert.ok(saved.jobs.some(job => job.id === valid.id));
  assert.equal(fs.existsSync(state.resolveJobFile(cwd, "terminal-0")), false);
  assert.equal(fs.existsSync(state.terminalMarkerFile(files[0])), true);
  assert.equal(diagnostics.length, files.length);
  files.forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), malformed[index]));
});

test("job enumeration ignores a disappearing file but propagates other I/O errors", (t) => {
  const cwd = makeTempDir();
  const valid = { id: "task-good", status: "running" };
  const file = state.writeJobFile(cwd, valid.id, valid);
  const read = fs.readFileSync.bind(fs);
  let failure;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (target === file && failure) throw failure;
    return read(target, ...args);
  });
  failure = Object.assign(new Error("concurrent removal"), { code: "ENOENT" });
  assert.deepEqual(state.loadState(cwd).jobs, []);
  failure = Object.assign(new Error("read failed"), { code: "EIO" });
  assert.throws(() => state.loadState(cwd), error => error === failure);
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: [valid] }));
  assert.throws(() => state.loadState(cwd), error => error === failure);
  assert.equal(JSON.parse(read(state.resolveStateFile(cwd))).jobs.length, 1);
});

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

test("legacy migration skips an unparsable base file and retires the array after other entries", (t) => {
  const cwd = makeTempDir();
  const diagnostics = [];
  t.mock.method(console, "warn", message => diagnostics.push(message));
  const badFile = state.resolveJobFile(cwd, "task-bad1");
  const bytes = '{"id":"task-bad1","sta';
  fs.writeFileSync(badFile, bytes);
  const good = { id: "task-good", status: "completed", summary: "kept" };
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: [
    { id: "task-bad1", status: "completed" }, good
  ] }));

  assert.deepEqual(state.loadState(cwd).jobs, [good]);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(state.resolveStateFile(cwd))), "jobs"), false);
  assert.equal(fs.readFileSync(badFile, "utf8"), bytes);
  assert.equal(fs.existsSync(state.terminalMarkerFile(badFile)), false);
  assert.equal(fs.existsSync(state.terminalMarkerFile(state.resolveJobFile(cwd, good.id))), true);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].includes(badFile));
});

test("legacy terminal migration carries index-only fields without rewriting the job file", () => {
  const cwd = makeTempDir();
  const fileRecord = {
    id: "legacy-finished", status: "completed", summary: "creation summary",
    createdAt: "2020-01-01", completedAt: "2020-01-02", result: { stdout: "kept" }
  };
  const jobFile = state.resolveJobFile(cwd, fileRecord.id);
  fs.writeFileSync(jobFile, JSON.stringify(fileRecord));
  fs.utimesSync(jobFile, new Date("2020-01-01"), new Date("2020-01-01"));
  const bytes = fs.readFileSync(jobFile);
  const before = fs.statSync(jobFile);
  const legacy = { ...fileRecord, summary: "completion summary", updatedAt: "2020-01-03", result: { stdout: "stale" } };
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: [legacy] }));

  const loaded = state.loadState(cwd);
  const expected = { ...fileRecord, summary: "completion summary", updatedAt: "2020-01-03" };
  assert.deepEqual(loaded.jobs, [expected]);
  assert.deepEqual(state.readJobFile(jobFile), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.terminalMarkerFile(jobFile))), expected);
  assert.deepEqual(fs.readFileSync(jobFile), bytes);
  assert.equal(fs.statSync(jobFile).ino, before.ino);
  assert.equal(fs.statSync(jobFile).mtimeMs, before.mtimeMs);
});

test("legacy index creates missing files once and never rewrites authoritative existing records", () => {
  const cwd = makeTempDir();
  const existing = { id: "existing", status: "running", progress: 5 };
  state.writeJobFile(cwd, existing.id, existing);
  const existingFile = state.resolveJobFile(cwd, existing.id);
  const before = fs.statSync(existingFile);
  const bytes = fs.readFileSync(existingFile);
  const legacy = [
    { ...existing, progress: 1, summary: "legacy summary", createdAt: "2020-01-01", updatedAt: "2020-01-02" },
    { id: "missing", status: "completed", summary: "legacy result", updatedAt: "2020-01-03" }
  ];
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ config: { stopReviewGate: true }, jobs: legacy }));
  const loaded = state.loadState(cwd);
  assert.equal(loaded.jobs.length, 2);
  assert.equal(loaded.config.stopReviewGate, true);
  assert.equal(state.readJobFile(state.resolveJobFile(cwd, "missing")).summary, "legacy result");
  assert.equal(fs.existsSync(state.terminalMarkerFile(state.resolveJobFile(cwd, "missing"))), true);
  const migrated = state.readJobFile(state.resolveJobFile(cwd, "existing"));
  assert.deepEqual(migrated, existing);
  assert.deepEqual(fs.readFileSync(existingFile), bytes);
  assert.equal(fs.existsSync(state.terminalMarkerFile(existingFile)), false);
  assert.equal(fs.statSync(existingFile).ino, before.ino);
  assert.equal(fs.statSync(existingFile).mtimeMs, before.mtimeMs);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(state.resolveStateFile(cwd))), "jobs"), false);
  fs.unlinkSync(state.resolveJobFile(cwd, "missing"));
  assert.deepEqual(state.listJobs(cwd).map(job => job.id), ["existing"]);
});

test("legacy migration preserves an existing terminal marker exactly", () => {
  const cwd = makeTempDir();
  const jobFile = state.writeJobFile(cwd, "winner", {
    id: "winner", status: "failed", summary: "marker winner", completedAt: "2020-01-04"
  });
  const winner = state.readJobFile(jobFile);
  const marker = state.terminalMarkerFile(jobFile);
  const bytes = fs.readFileSync(marker);
  const before = fs.statSync(marker);
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: [
    { id: "winner", status: "completed", summary: "stale legacy", updatedAt: "2020-01-05" }
  ] }));
  assert.deepEqual(state.loadState(cwd).jobs, [winner]);
  assert.deepEqual(fs.readFileSync(marker), bytes);
  assert.equal(fs.statSync(marker).ino, before.ino);
  assert.equal(fs.statSync(marker).mtimeMs, before.mtimeMs);
});

test("legacy migration adopts a marker published between its check and exclusive link", (t) => {
  const cwd = makeTempDir();
  const record = { id: "race", status: "completed", summary: "file summary", createdAt: "2020-01-01" };
  const jobFile = state.resolveJobFile(cwd, record.id);
  fs.writeFileSync(jobFile, JSON.stringify(record));
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: [
    { ...record, summary: "legacy summary", updatedAt: "2020-01-02" }
  ] }));
  const marker = state.terminalMarkerFile(jobFile);
  const winner = { ...record, summary: "concurrent winner", updatedAt: "2020-01-03" };
  const temporary = `${marker}.winner.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(winner));
  const link = fs.linkSync.bind(fs);
  let raced = false;
  t.mock.method(fs, "linkSync", (source, target) => {
    if (target === marker && !raced) {
      raced = true;
      link(temporary, marker);
    }
    return link(source, target);
  });
  assert.deepEqual(state.loadState(cwd).jobs, [winner]);
  assert.equal(raced, true);
  assert.deepEqual(state.readJobFile(jobFile), winner);
  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile)), record);
  fs.unlinkSync(temporary);
  assert.deepEqual(fs.readdirSync(state.resolveJobsDir(cwd)).sort(), ["race.json", "race.terminal.json"]);
});

test("legacy terminal migration uses file outcomes and timestamp fallbacks", () => {
  const cwd = makeTempDir();
  const records = [
    { id: "failed", status: "failed", summary: "file failure", completedAt: "2020-01-03", createdAt: "2020-01-01" },
    { id: "cancelled", status: "cancelled", summary: "file cancellation", createdAt: "2020-01-02" }
  ];
  for (const record of records) fs.writeFileSync(state.resolveJobFile(cwd, record.id), JSON.stringify(record));
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: [
    { id: "failed", status: "completed", summary: "wrong outcome", updatedAt: null },
    { id: "cancelled", status: "cancelled", summary: "legacy cancellation" }
  ] }));
  assert.deepEqual(state.loadState(cwd).jobs, [
    { ...records[0], updatedAt: "2020-01-03" },
    { ...records[1], summary: "legacy cancellation", updatedAt: "2020-01-02" }
  ]);
});

test("migrated legacy terminal jobs are pruned by index recency while running jobs survive", () => {
  const cwd = makeTempDir();
  const legacy = [];
  for (let index = 0; index < 52; index++) {
    const record = {
      id: `legacy-${index}`, status: "completed", summary: "creation summary",
      createdAt: new Date(Date.UTC(2020, 0, 52 - index)).toISOString()
    };
    fs.writeFileSync(state.resolveJobFile(cwd, record.id), JSON.stringify(record));
    legacy.push({ ...record, summary: "completion summary", updatedAt: new Date(Date.UTC(2021, 0, index + 1)).toISOString() });
  }
  const running = { id: "running-old", status: "running", createdAt: "2000-01-01" };
  fs.writeFileSync(state.resolveJobFile(cwd, running.id), JSON.stringify(running));
  legacy.push({ ...running, status: "completed", summary: "stale terminal index" });
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs: legacy }));
  assert.equal(state.loadState(cwd).jobs.length, 53);
  const saved = state.saveState(cwd, { config: {} });
  assert.equal(saved.jobs.length, 51);
  assert.deepEqual(saved.jobs.slice(0, 2).map(job => job.id), ["legacy-51", "legacy-50"]);
  for (const index of [0, 1]) {
    const file = state.resolveJobFile(cwd, `legacy-${index}`);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(state.terminalMarkerFile(file)), false);
  }
  for (let index = 2; index < 52; index++) {
    const file = state.resolveJobFile(cwd, `legacy-${index}`);
    assert.equal(state.readJobFile(file).summary, "completion summary");
    assert.equal(fs.existsSync(state.terminalMarkerFile(file)), true);
  }
  assert.deepEqual(state.readJobFile(state.resolveJobFile(cwd, running.id)), running);
  assert.equal(fs.existsSync(state.terminalMarkerFile(state.resolveJobFile(cwd, running.id))), false);
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

test("retention keeps every active and unmarked record plus the newest fifty terminal jobs", () => {
  const cwd = makeTempDir();
  const protectedJobs = [
    { id: "active-old", status: "running", updatedAt: "2000-01-01" },
    { id: "queued-old", status: "queued", updatedAt: "2000-01-02" },
    { id: "legacy-unmarked", status: "completed", updatedAt: "2000-01-03" }
  ];
  for (const job of protectedJobs) {
    fs.writeFileSync(state.resolveJobFile(cwd, job.id), JSON.stringify(job));
  }
  for (let index = 0; index < 52; index++) {
    state.publishTerminalJob(cwd, `terminal-${index}`, {
      id: `terminal-${index}`, status: "completed", updatedAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString()
    });
  }
  const saved = state.saveState(cwd, { config: {} });
  assert.equal(saved.jobs.length, 53);
  for (const job of protectedJobs) assert.deepEqual(state.readJobFile(state.resolveJobFile(cwd, job.id)), job);
  assert.equal(fs.existsSync(state.resolveJobFile(cwd, "terminal-0")), false);
  assert.equal(fs.existsSync(state.resolveJobFile(cwd, "terminal-1")), false);
  for (let index = 2; index < 52; index++) {
    assert.equal(state.readJobFile(state.resolveJobFile(cwd, `terminal-${index}`)).status, "completed");
  }
});

test("job paths reject unsafe ids and accept generated tokens", () => {
  const cwd = makeTempDir();
  for (const id of ["../escape", "a/b", "a\\b", "/absolute", "C:\\absolute", "..", "a..b", ".hidden",
    "", "a b", "line\n", "nul\0", "a".repeat(129), null, undefined, 123]) {
    assert.throws(() => state.resolveJobFile(cwd, id), /Invalid job id/);
    assert.throws(() => state.resolveJobLogFile(cwd, id), /Invalid job id/);
  }
  for (const id of ["abc", "A_b-9", state.generateJobId("task"), state.generateJobId("review")]) {
    assert.equal(path.dirname(state.resolveJobFile(cwd, id)), state.resolveJobsDir(cwd));
  }
});

test("legacy migration skips invalid ids with diagnostics and never writes outside jobs", (t) => {
  const cwd = makeTempDir();
  const diagnostics = [];
  t.mock.method(console, "warn", message => diagnostics.push(message));
  const outside = path.join(state.resolveStateDir(cwd), "escape.json");
  const jobs = [
    { id: "../escape", status: "running" }, { id: "/absolute", status: "completed" },
    { id: "a\\b", status: "running" }, { status: "queued" }, null,
    { id: "safe-legacy", status: "running" }
  ];
  state.ensureStateDir(cwd);
  fs.writeFileSync(state.resolveStateFile(cwd), JSON.stringify({ jobs }));
  assert.deepEqual(state.loadState(cwd).jobs.map(job => job.id), ["safe-legacy"]);
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readdirSync(state.resolveJobsDir(cwd)), ["safe-legacy.json"]);
  assert.equal(diagnostics.length, 5);
  for (const diagnostic of diagnostics) assert.match(diagnostic, /Skipping legacy job.*invalid.*id/i);
});
