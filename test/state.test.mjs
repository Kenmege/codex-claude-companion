import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  JOB_SCHEMA_VERSION,
  buildJobRecord,
  createJob,
  generateJobId,
  listJobs,
  migrateJobRecord,
  readJob,
  readJobInput,
  updateJob,
  writeJob,
  writeJobInput
} from "../scripts/lib/state.mjs";

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

test("state helpers lock concurrent updateJob writers so disjoint patches survive", async () => {
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
    runChild("fieldB", "beta")
  ]);

  const job = readJob(cwd, jobId);
  assert.equal(job.fieldA, "alpha");
  assert.equal(job.fieldB, "beta");
});
