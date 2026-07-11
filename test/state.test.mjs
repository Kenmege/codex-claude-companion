import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  JOB_SCHEMA_VERSION,
  appendLogLine,
  assertValidJobId,
  buildJobRecord,
  createJob,
  generateJobId,
  listJobs,
  migrateJobRecord,
  readJob,
  readJobInput,
  resolveJobFile,
  updateJob,
  writeJob,
  writeJobInput
} from "../scripts/lib/state.mjs";

test("job IDs use a path-safe portable grammar at every artifact boundary", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobDir = path.join(cwd, "private-jobs");
  const options = { jobDir };

  for (const valid of ["a", "review-123", "review_job_ABC", "x".repeat(128)]) {
    assert.equal(assertValidJobId(valid), valid);
  }

  for (const invalid of ["", ".", "..", "../escape", "a/b", "a\\b", "/tmp/escape", "x".repeat(129), "review job", "é"] ) {
    assert.throws(() => assertValidJobId(invalid), /Invalid job id/);
    assert.throws(() => resolveJobFile(cwd, invalid, options), /Invalid job id/);
    assert.throws(() => readJob(cwd, invalid, options), /Invalid job id/);
    assert.throws(() => updateJob(cwd, invalid, { status: "failed" }, options), /Invalid job id/);
    assert.throws(() => writeJobInput(cwd, invalid, {}, options), /Invalid job id/);
    assert.throws(() => appendLogLine(cwd, invalid, "must not escape", "error", options), /Invalid job id/);
  }

  assert.equal(fs.existsSync(path.join(cwd, "escape.job.json")), false);
  assert.equal(fs.existsSync(path.join(cwd, "escape.log")), false);
});

test("state helpers write and update jobs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobId = generateJobId("review");
  writeJob(cwd, jobId, buildJobRecord(cwd, jobId, { kind: "review", title: "test job" }));
  updateJob(cwd, jobId, { status: "completed" });
  const jobs = listJobs(cwd);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].schemaVersion, JOB_SCHEMA_VERSION);
});

test("state helpers create jobs with exclusive O_EXCL semantics", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobId = "review-exclusive";
  const record = buildJobRecord(cwd, jobId, { kind: "review", title: "test job" });
  createJob(cwd, jobId, record);
  assert.throws(
    () => createJob(cwd, jobId, record),
    /EEXIST/
  );
  assert.equal(readJob(cwd, jobId).schemaVersion, JOB_SCHEMA_VERSION);
});

test("state helpers keep job directories and logs private", {
  skip: process.platform === "win32"
}, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-mode-"));
  const jobDir = path.join(cwd, "jobs");
  const jobId = "review-private";
  fs.mkdirSync(jobDir, { mode: 0o777 });
  const logFile = path.join(jobDir, `${jobId}.log`);
  fs.writeFileSync(logFile, "existing\n", { mode: 0o666 });
  fs.chmodSync(jobDir, 0o777);
  fs.chmodSync(logFile, 0o666);

  const previousUmask = process.umask(0);
  try {
    appendLogLine(cwd, jobId, "private diagnostic", "info", { jobDir });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test("state helpers migrate legacy jobs without dropping fields", () => {
  const migrated = migrateJobRecord({
    id: "review-legacy",
    status: "completed",
    result: { verdict: "ok" }
  });
  assert.equal(migrated.schemaVersion, JOB_SCHEMA_VERSION);
  assert.equal(migrated.migratedFromSchemaVersion, 0);
  assert.deepEqual(migrated.result, { verdict: "ok" });
});

test("migrateJobRecord pins schemaVersion after legacy record spread", () => {
  const migrated = migrateJobRecord({
    schemaVersion: -1,
    id: "review-legacy-version"
  });
  assert.equal(migrated.migratedFromSchemaVersion, -1);
  assert.equal(migrated.schemaVersion, JOB_SCHEMA_VERSION);
});

test("writeJobInput uses distinct atomic tmp names within the same millisecond", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const tmpFiles = [];
  const originalDateNow = Date.now;
  const originalWriteFileSync = fs.writeFileSync;

  Date.now = () => 1234567890;
  fs.writeFileSync = function patchedWriteFileSync(file, ...args) {
    if (typeof file === "string" && file.endsWith(".tmp")) {
      tmpFiles.push(file);
    }
    return originalWriteFileSync.call(this, file, ...args);
  };

  try {
    writeJobInput(cwd, "review-input", { value: 1 });
    writeJobInput(cwd, "review-input", { value: 2 });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    Date.now = originalDateNow;
  }

  assert.equal(tmpFiles.length, 2);
  assert.equal(new Set(tmpFiles).size, 2);
});

test("readJobInput reports a clear missing snapshot error", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  assert.throws(
    () => readJobInput(cwd, "review-missing-input"),
    /Job input snapshot missing for review-missing-input; the job record may have been partially deleted/
  );
});

function makeQueuedContender(jobFile, name, contents) {
  const contenderDir = path.join(`${jobFile}.lock.queue`, name);
  fs.mkdirSync(contenderDir, { recursive: true });
  if (contents !== null) {
    fs.writeFileSync(path.join(contenderDir, "owner"), contents, { encoding: "utf8", mode: 0o600 });
  }
  return contenderDir;
}

test("state helpers recover stale job locks owned by dead processes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobId = "review-stale-lock";
  writeJob(cwd, jobId, buildJobRecord(cwd, jobId, { kind: "review", title: "stale lock job" }));

  const jobFile = path.join(cwd, ".claude-review", "jobs", `${jobId}.job.json`);
  const contenderDir = makeQueuedContender(
    jobFile,
    "ticket-0000000000000001-dead-owner",
    "2147483647:dead\n"
  );

  updateJob(cwd, jobId, { status: "completed" });

  assert.equal(readJob(cwd, jobId).status, "completed");
  assert.equal(fs.existsSync(contenderDir), false);
});

test("job locks use immutable per-contender entries instead of replacing a shared owner path", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobId = "review-immutable-contenders";
  writeJob(cwd, jobId, buildJobRecord(cwd, jobId, { kind: "review", title: "immutable queue" }));
  const jobFile = path.join(cwd, ".claude-review", "jobs", `${jobId}.job.json`);
  const originalRenameSync = fs.renameSync;
  let renamedSharedOwner = false;
  fs.renameSync = function patchedRenameSync(source, destination, ...args) {
    if (path.resolve(String(source)) === `${jobFile}.lock`) renamedSharedOwner = true;
    return originalRenameSync.call(this, source, destination, ...args);
  };

  try {
    updateJob(cwd, jobId, { status: "completed" });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(renamedSharedOwner, false);
  assert.equal(readJob(cwd, jobId).status, "completed");
});

test("state helpers recover old malformed job locks", () => {
  for (const [index, contents] of ["", "not-a-pid\n"].entries()) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
    const jobId = `review-malformed-lock-${index}`;
    writeJob(cwd, jobId, buildJobRecord(cwd, jobId, { kind: "review", title: "malformed lock job" }));
    const jobFile = path.join(cwd, ".claude-review", "jobs", `${jobId}.job.json`);
    const contenderDir = makeQueuedContender(
      jobFile,
      `ticket-0000000000000001-malformed-${index}`,
      contents
    );
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(contenderDir, old, old);

    updateJob(cwd, jobId, { status: "completed" });

    assert.equal(readJob(cwd, jobId).status, "completed");
    assert.equal(fs.existsSync(contenderDir), false);
  }
});

test("state helpers do not steal a newly created malformed lock inside the grace window", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobId = "review-fresh-malformed-lock";
  writeJob(cwd, jobId, buildJobRecord(cwd, jobId, { kind: "review", title: "fresh malformed lock job" }));
  const jobFile = path.join(cwd, ".claude-review", "jobs", `${jobId}.job.json`);
  const contenderDir = makeQueuedContender(
    jobFile,
    "choosing-0000000000-fresh-malformed",
    null
  );

  const moduleUrl = pathToFileURL(path.resolve("scripts/lib/state.mjs")).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { updateJob } from ${JSON.stringify(moduleUrl)}; updateJob(process.argv[1], process.argv[2], { status: "completed" });`,
    cwd,
    jobId
  ], { cwd: path.resolve("."), stdio: ["ignore", "ignore", "pipe"] });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(contenderDir), true, "fresh malformed contender was stolen without a grace period");
  assert.equal(child.exitCode, null, "waiting updater unexpectedly completed inside grace period");

  fs.rmdirSync(contenderDir);
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => status === 0 ? resolve() : reject(new Error(`child exited ${status}`)));
  });
  assert.equal(readJob(cwd, jobId).status, "completed");
});

test("state helpers lock three concurrent updateJob writers so disjoint patches survive", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-state-"));
  const jobId = "review-concurrent";
  writeJob(cwd, jobId, buildJobRecord(cwd, jobId, { kind: "review", title: "concurrent job" }));
  writeJobInput(cwd, jobId, { reviewKind: "review" });

  const moduleUrl = pathToFileURL(path.resolve("scripts/lib/state.mjs")).href;
  const childScript = `
    import { updateJob } from ${JSON.stringify(moduleUrl)};
    const [, cwd, jobId, field, value] = process.argv;
    updateJob(cwd, jobId, { [field]: value });
  `;
  const runChild = (field, value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, cwd, jobId, field, value], {
      cwd: path.resolve("."),
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `child exited ${status}`));
      }
    });
  });

  await Promise.all([
    runChild("fieldA", "alpha"),
    runChild("fieldB", "beta"),
    runChild("fieldC", "gamma")
  ]);

  const job = readJob(cwd, jobId);
  assert.equal(job.fieldA, "alpha");
  assert.equal(job.fieldB, "beta");
  assert.equal(job.fieldC, "gamma");
});
