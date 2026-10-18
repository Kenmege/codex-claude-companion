import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { loadState, readJobFile, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, writeJobFile, writeJsonAtomic } from "../plugins/codex/scripts/lib/state.mjs";

// A live Claude Code session exports CLAUDE_PLUGIN_DATA, which resolveStateDir
// prefers over the temp-backed default. Scrub it at module load so the default
// case is exercised regardless of the host environment; the test that asserts
// the CLAUDE_PLUGIN_DATA branch sets and restores it locally.
const hadPluginDataDir = Object.hasOwn(process.env, "CLAUDE_PLUGIN_DATA");
const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_PLUGIN_DATA;

after(() => {
  if (hadPluginDataDir) process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
  else delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState atomically replaces the state snapshot", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  saveState(workspace, { config: { stopReviewGate: false } });
  const previousSnapshot = fs.openSync(stateFile, "r");

  try {
    saveState(workspace, { config: { stopReviewGate: true } });

    const oldState = JSON.parse(fs.readFileSync(previousSnapshot, "utf8"));
    const newState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(oldState.config.stopReviewGate, false);
    assert.equal(newState.config.stopReviewGate, true);
    assert.equal(Object.hasOwn(newState, "jobs"), false);
  } finally {
    fs.closeSync(previousSnapshot);
  }
});

// A reader such as `cancel` parses the job record while the background worker rewrites it. An
// in-place write lets that reader see a truncated file ("Unexpected end of JSON input").
test("writeJobFile atomically replaces the job record", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir();
  const jobFile = writeJobFile(workspace, "job-atomic", { id: "job-atomic", status: "running", progress: "first" });
  const previousRecord = fs.openSync(jobFile, "r");

  try {
    writeJobFile(workspace, "job-atomic", { id: "job-atomic", status: "cancelled", progress: "second" });

    assert.equal(JSON.parse(fs.readFileSync(previousRecord, "utf8")).progress, "first");
    assert.equal(readJobFile(jobFile).progress, "second");
  } finally {
    fs.closeSync(previousRecord);
  }
});

test("saveState flushes the temporary snapshot before atomic replacement", (t) => {
  const workspace = makeTempDir();
  const originalFsyncSync = fs.fsyncSync.bind(fs);
  const originalRenameSync = fs.renameSync.bind(fs);
  const operations = [];

  t.mock.method(fs, "fsyncSync", function mockedFsyncSync(fileDescriptor) {
    operations.push("fsync");
    return originalFsyncSync(fileDescriptor);
  });
  t.mock.method(fs, "renameSync", function mockedRenameSync(source, destination) {
    operations.push("rename");
    return originalRenameSync(source, destination);
  });

  saveState(workspace, { jobs: [] });
  assert.deepEqual(operations, ["fsync", "rename"]);
});

test("Windows atomic replacement retries transient sharing errors without losing the old snapshot", { skip: process.platform !== "win32" }, (t) => {
  const root = makeTempDir();
  const file = path.join(root, "shared.json");
  writeJsonAtomic(file, { progress: 1 });
  const rename = fs.renameSync;
  const transient = ["EPERM", "EBUSY", "EACCES"];
  let attempts = 0;
  const waits = [];
  t.mock.method(Atomics, "wait", (_buffer, _index, _value, delay) => { waits.push(delay); });
  t.mock.method(fs, "renameSync", (source, destination) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), { progress: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(source, "utf8")), { progress: 2 });
    const code = transient[attempts++];
    if (code) throw Object.assign(new Error("Windows reader temporarily holds the destination"), { code });
    return rename(source, destination);
  });
  writeJsonAtomic(file, { progress: 2 });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [5, 10, 15]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { progress: 2 });
  assert.deepEqual(fs.readdirSync(root), ["shared.json"]);
});

test("Windows atomic replacement bounds persistent sharing errors and propagates other failures immediately", { skip: process.platform !== "win32" }, (t) => {
  const root = makeTempDir();
  const file = path.join(root, "shared.json");
  writeJsonAtomic(file, { progress: 1 });
  let attempts = 0;
  let failure = Object.assign(new Error("persistent sharing failure"), { code: "EPERM" });
  const waits = [];
  t.mock.method(Atomics, "wait", (_buffer, _index, _value, delay) => { waits.push(delay); });
  t.mock.method(fs, "renameSync", () => { attempts++; throw failure; });
  assert.throws(() => writeJsonAtomic(file, { progress: 2 }), error => error === failure);
  assert.equal(attempts, 10);
  assert.deepEqual(waits, [5, 10, 15, 20, 25, 30, 35, 40, 45]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { progress: 1 });
  assert.deepEqual(fs.readdirSync(root), ["shared.json"]);
  attempts = 0;
  waits.length = 0;
  failure = Object.assign(new Error("storage failure"), { code: "EIO" });
  assert.throws(() => writeJsonAtomic(file, { progress: 3 }), error => error === failure);
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(fs.readdirSync(root), ["shared.json"]);
});

test("POSIX atomic replacement propagates sharing-like errors without retrying", { skip: process.platform === "win32" }, (t) => {
  const file = path.join(makeTempDir(), "shared.json");
  let attempts = 0;
  const failure = Object.assign(new Error("permission failure"), { code: "EPERM" });
  t.mock.method(fs, "renameSync", () => { attempts++; throw failure; });
  t.mock.method(Atomics, "wait", () => assert.fail("POSIX errors must not be retried"));
  assert.throws(() => writeJsonAtomic(file, { progress: 1 }), error => error === failure);
  assert.equal(attempts, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test("saveState preserves an atomic rename error when temporary cleanup also fails", (t) => {
  const workspace = makeTempDir();
  const originalUnlinkSync = fs.unlinkSync.bind(fs);
  let temporaryFile;

  t.mock.method(fs, "renameSync", function mockedRenameSync(source) {
    temporaryFile = String(source);
    const error = new Error("rename failed");
    error.code = "EACCES";
    throw error;
  });
  t.mock.method(fs, "unlinkSync", function mockedUnlinkSync() {
    const error = new Error("cleanup failed");
    error.code = "EPERM";
    throw error;
  });

  try {
    assert.throws(() => saveState(workspace, { jobs: [] }), /rename failed/);
  } finally {
    if (temporaryFile && fs.existsSync(temporaryFile)) originalUnlinkSync(temporaryFile);
  }
});

test("saveState prunes marked terminal job artifacts when terminal jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    const job = {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
    writeJobFile(workspace, jobId, job);
    return job;
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = loadState(workspace);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(stateFile, "utf8")), "jobs"), false);
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`, `${jobId}.terminal.json`])
      .sort()
  );
});
