import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_DIR_NAME = ".claude-review";
const JOBS_DIR_NAME = "jobs";
export const JOB_SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

export function generateJobId(kind = "review") {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveStateDir(cwd) {
  return path.join(resolveWorkspaceRoot(cwd), STATE_DIR_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.job.json`);
}

export function resolveJobInputFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.input.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

function writeJsonAtomic(file, payload) {
  const tmpFile = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(tmpFile, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockFile, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  let delayMs = 5;

  while (true) {
    let handle = null;
    try {
      handle = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n`, "utf8");
      return () => {
        try {
          fs.closeSync(handle);
        } finally {
          try {
            fs.unlinkSync(lockFile);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if (handle != null) {
        try {
          fs.closeSync(handle);
        } catch {}
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for job state lock ${lockFile}`);
      }
      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}

function createJsonExclusive(file, payload) {
  const handle = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(handle);
  }
}

export function migrateJobRecord(record) {
  if (!record || typeof record !== "object") {
    return record;
  }
  if (record.schemaVersion === JOB_SCHEMA_VERSION) {
    return record;
  }
  const previousVersion = record.schemaVersion ?? 0;
  return {
    migratedFromSchemaVersion: previousVersion,
    ...record,
    schemaVersion: JOB_SCHEMA_VERSION
  };
}

export function readJob(cwd, jobId) {
  const file = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(file)) {
    return null;
  }
  return migrateJobRecord(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeJob(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeJsonAtomic(resolveJobFile(cwd, jobId), migrateJobRecord(payload));
}

export function createJob(cwd, jobId, payload) {
  ensureStateDir(cwd);
  createJsonExclusive(resolveJobFile(cwd, jobId), migrateJobRecord(payload));
}

export function updateJob(cwd, jobId, patch) {
  const jobFile = resolveJobFile(cwd, jobId);
  const releaseLock = acquireLock(`${jobFile}.lock`);
  try {
    const current = readJob(cwd, jobId);
    if (!current) {
      throw new Error(`Unknown job ${jobId}`);
    }
    const next = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    writeJob(cwd, jobId, next);
    return next;
  } finally {
    releaseLock();
  }
}

export function writeJobInput(cwd, jobId, payload) {
  writeJsonAtomic(resolveJobInputFile(cwd, jobId), payload);
}

export function readJobInput(cwd, jobId) {
  const file = resolveJobInputFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Job input snapshot missing for ${jobId}; the job record may have been partially deleted.`);
    }
    throw error;
  }
}

export function appendLogLine(cwd, jobId, line, level = "info") {
  const normalizedLevel = String(level || "info").toUpperCase();
  fs.appendFileSync(resolveJobLogFile(cwd, jobId), `[${nowIso()}] [${jobId}] [${normalizedLevel}] ${line}\n`, "utf8");
}

export function readLogTail(cwd, jobId, maxLines = 6) {
  const file = resolveJobLogFile(cwd, jobId);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines);
}

export function listJobs(cwd) {
  ensureStateDir(cwd);
  const jobs = [];
  for (const entry of fs.readdirSync(resolveJobsDir(cwd))) {
    if (!entry.endsWith(".job.json")) {
      continue;
    }
    jobs.push(migrateJobRecord(JSON.parse(fs.readFileSync(path.join(resolveJobsDir(cwd), entry), "utf8"))));
  }
  return jobs.sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)));
}

export function buildJobRecord(cwd, jobId, patch) {
  const timestamp = nowIso();
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    id: jobId,
    cwd: path.resolve(cwd),
    workspaceRoot: resolveWorkspaceRoot(cwd),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "queued",
    ...patch
  };
}
