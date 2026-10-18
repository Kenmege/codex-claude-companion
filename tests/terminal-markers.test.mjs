import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as state from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { resolveCancelableJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { makeTempDir } from "./helpers.mjs";

const script = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
const execution = { exitStatus: 0, payload: { ok: true }, rendered: "output", summary: "done" };
function fixture(id = "task-marker") {
  const workspaceRoot = makeTempDir();
  const job = { id, workspaceRoot, status: "queued" };
  state.writeJobFile(workspaceRoot, id, job);
  state.upsertJob(workspaceRoot, job);
  return job;
}
function read(job) { return state.readJobFile(state.resolveJobFile(job.workspaceRoot, job.id)); }
function cancel(job) {
  return spawnSync(process.execPath, [script, "cancel", job.id, "--cwd", job.workspaceRoot, "--json"], { encoding: "utf8" });
}

test("cancel then complete keeps the cancellation record and runner output in the log", async () => {
  const job = fixture();
  const logFile = state.resolveJobLogFile(job.workspaceRoot, job.id);
  await runTrackedJob(job, async () => {
    const result = cancel(job);
    assert.equal(result.status, 0, result.stderr);
    return execution;
  }, { logFile });
  assert.equal(read(job).status, "cancelled");
  assert.equal(state.listJobs(job.workspaceRoot)[0].status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /output/);
});

test("complete then cancel reports alreadyTerminal without interrupting", async () => {
  const job = fixture();
  await runTrackedJob(job, async () => execution);
  const before = read(job);
  const result = cancel(job);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.alreadyTerminal, true);
  assert.equal(payload.turnInterruptAttempted, false);
  assert.deepEqual(read(job), before);
});

test("cancel before start never invokes the runner", async () => {
  const job = fixture();
  assert.equal(cancel(job).status, 0);
  let invoked = false;
  const result = await runTrackedJob(job, async () => { invoked = true; return execution; });
  assert.equal(invoked, false);
  assert.equal(result.status, "cancelled");
  assert.equal(result.skipped, true);
});

test("a marker left before index update self-heals on record read and status listing", () => {
  const job = fixture();
  const jobFile = state.resolveJobFile(job.workspaceRoot, job.id);
  const terminal = { ...job, status: "cancelled", pid: null, completedAt: "2026-10-18T00:00:00Z" };
  const temp = `${jobFile}.crash.tmp`;
  fs.writeFileSync(temp, JSON.stringify(terminal));
  fs.linkSync(temp, jobFile.replace(/\.json$/, ".terminal.json"));
  fs.unlinkSync(temp);
  const stale = fs.readFileSync(state.resolveStateFile(job.workspaceRoot), "utf8");
  assert.equal(read(job).status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(state.resolveStateFile(job.workspaceRoot))).jobs[0].status, "cancelled");
  fs.writeFileSync(state.resolveStateFile(job.workspaceRoot), stale);
  assert.equal(state.listJobs(job.workspaceRoot)[0].status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(state.resolveStateFile(job.workspaceRoot))).jobs[0].status, "cancelled");
});

test("concurrent processes publish exactly one terminal winner and all adopt it", async () => {
  const job = fixture();
  const children = Array.from({ length: 6 }, (_, index) => {
    const code = `import { publishTerminalJob } from ${JSON.stringify(stateUrl)};
      process.send('ready'); process.once('message', () => {
        const result = publishTerminalJob(${JSON.stringify(job.workspaceRoot)}, ${JSON.stringify(job.id)},
          ${JSON.stringify({ ...job, status: ["completed", "failed", "cancelled"][index % 3], contender: index })});
        process.send(result); process.disconnect();
      });`;
    return spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  });
  const ready = children.map((child) => new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== 0) reject(new Error(`publisher exited ${code}`)); });
  }));
  const results = children.map((child) => new Promise((resolve, reject) => {
    let result;
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("message", message => { if (message !== "ready") result = message; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(result) : reject(new Error(stderr)));
  }));
  // Attach rejection handlers before waiting for readiness on the unimplemented base.
  const completed = Promise.all(results);
  completed.catch(() => {});
  try {
    await Promise.all(ready);
    children.forEach(child => child.send("publish"));
    const outcomes = await completed;
    assert.equal(outcomes.filter(result => result.won).length, 1);
    for (const result of outcomes) assert.deepEqual(result.record, read(job));
    assert.equal(fs.readdirSync(path.dirname(state.resolveJobFile(job.workspaceRoot, job.id))).filter(name => name.endsWith(".terminal.json")).length, 1);
    assert.equal(fs.readdirSync(path.dirname(state.resolveJobFile(job.workspaceRoot, job.id))).filter(name => name.endsWith(".tmp")).length, 0);
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill(); });
    await Promise.allSettled(results);
  }
});

test("cancel reference prefers active prefixes and preserves active ambiguity", () => {
  const job = fixture("task-prefix");
  state.writeJobFile(job.workspaceRoot, job.id, { ...job, status: "completed" });
  state.upsertJob(job.workspaceRoot, { ...job, status: "completed" });
  state.upsertJob(job.workspaceRoot, { id: "task-prefix-active", status: "running" });
  assert.equal(resolveCancelableJob(job.workspaceRoot, "task-prefix").job.id, "task-prefix-active");
  state.upsertJob(job.workspaceRoot, { id: "task-prefix-another", status: "running" });
  assert.throws(() => resolveCancelableJob(job.workspaceRoot, "task-prefix"), /ambiguous/);
  assert.throws(() => resolveCancelableJob(job.workspaceRoot, "task-pre-no-match"), /No .*job/);
});

test("terminal records survive late progress, failure and repeated cancellation", async () => {
  const job = fixture();
  await assert.rejects(runTrackedJob(job, async () => {
    assert.equal(cancel(job).status, 0);
    throw new Error("runner failed after cancellation");
  }), /runner failed/);
  const before = read(job);
  state.writeJobFile(job.workspaceRoot, job.id, { ...job, status: "running", phase: "late" });
  state.upsertJob(job.workspaceRoot, { id: job.id, status: "running", pid: 123 });
  assert.deepEqual(read(job), before);
  assert.equal(state.listJobs(job.workspaceRoot)[0].status, "cancelled");
  assert.equal(state.listJobs(job.workspaceRoot)[0].pid, null);
  assert.equal(JSON.parse(cancel(job).stdout).alreadyTerminal, true);
});

test("hard-link failure is loud and never falls back to overwriting", (t) => {
  const job = fixture();
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" }); });
  assert.throws(() => state.publishTerminalJob(job.workspaceRoot, job.id, { ...job, status: "failed" }), /hard links unavailable/);
  assert.equal(read(job).status, "queued");
  assert.equal(fs.readdirSync(path.dirname(state.resolveJobFile(job.workspaceRoot, job.id))).some(name => name.endsWith(".tmp")), false);
});
