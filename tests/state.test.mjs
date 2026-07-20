import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState } from "../plugins/codex/scripts/lib/state.mjs";

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
  const firstJob = {
    id: "job-first",
    status: "completed",
    updatedAt: "2026-07-11T15:00:00.000Z"
  };
  const secondJob = {
    id: "job-second",
    status: "completed",
    updatedAt: "2026-07-11T15:01:00.000Z"
  };

  saveState(workspace, { jobs: [firstJob] });
  const previousSnapshot = fs.openSync(stateFile, "r");

  try {
    saveState(workspace, { jobs: [secondJob] });

    const oldState = JSON.parse(fs.readFileSync(previousSnapshot, "utf8"));
    const newState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(oldState.jobs[0].id, firstJob.id);
    assert.equal(newState.jobs[0].id, secondJob.id);
  } finally {
    fs.closeSync(previousSnapshot);
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

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
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

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});
