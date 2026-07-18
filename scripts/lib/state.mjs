import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_DIR_NAME = ".claude-review";
const JOBS_DIR_NAME = "jobs";
export const JOB_SCHEMA_VERSION = 1;
export const JOB_DIR_ENV_VAR = "CODEX_CLAUDE_REVIEW_JOB_DIR";

function nowIso() {
  return new Date().toISOString();
}

export function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const currentStat = fs.lstatSync(dir);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`Job directory must be a real directory: ${dir}`);
    }
    return dir;
  }

  let fd;
  try {
    const flags = fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(dir, flags);
    const openedStat = fs.fstatSync(fd);
    const currentStat = fs.lstatSync(dir);
    if (
      !openedStat.isDirectory() ||
      currentStat.isSymbolicLink() ||
      !currentStat.isDirectory() ||
      !sameFileIdentity(openedStat, currentStat)
    ) {
      throw new Error(`Job directory changed while securing it: ${dir}`);
    }
    fs.fchmodSync(fd, 0o700);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return dir;
}

export function generateJobId(kind = "review") {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertValidJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid job id: expected 1-128 ASCII letters, digits, underscores, or hyphens");
  }
  return jobId;
}

export function resolveStateDir(cwd) {
  return path.join(resolveWorkspaceRoot(cwd), STATE_DIR_NAME);
}

/**
 * Test whether `dir` can be created and written to. Used by the fallback chain
 * to skip un-writable candidates (e.g. sandboxed home dirs on Windows).
 */
function canWriteDir(dir) {
  try {
    ensurePrivateDirectory(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now().toString(36)}`);
    fs.writeFileSync(probe, "ok", { mode: 0o600 });
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the jobs directory using the configured fallback chain. Order:
 *   1. options.jobDir (explicit --job-dir)
 *   2. process.env[CODEX_CLAUDE_REVIEW_JOB_DIR]
 *   3. <project>/.claude-review/jobs (legacy default — preserves existing flows)
 *   4. <home>/.claude-review/jobs
 *
 * Returns the first candidate that can be created + written to. Persistent job
 * records never fall back to a shared OS temporary directory; callers can use
 * the explicit option or environment variable when both defaults are read-only.
 */
export function resolveJobsDir(cwd, options = {}) {
  const explicit = options.jobDir ? path.resolve(options.jobDir) : null;
  const envOverride = process.env[JOB_DIR_ENV_VAR]
    ? path.resolve(process.env[JOB_DIR_ENV_VAR])
    : null;

  if (explicit) {
    if (!canWriteDir(explicit)) {
      throw new Error(`Explicit job directory is not writable: ${explicit}`);
    }
    return explicit;
  }
  if (envOverride) {
    if (!canWriteDir(envOverride)) {
      throw new Error(`${JOB_DIR_ENV_VAR} job directory is not writable: ${envOverride}`);
    }
    return envOverride;
  }

  let projectDefault = null;
  try {
    projectDefault = path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
  } catch {
    // resolveWorkspaceRoot fails outside a git repo; that branch is fine for
    // snapshot mode where cwd is a fresh git repo, but be defensive anyway.
    projectDefault = null;
  }

  const homeDefault = path.join(os.homedir(), ".claude-review", "jobs");
  const candidates = [projectDefault, homeDefault].filter(Boolean);
  for (const candidate of candidates) {
    if (canWriteDir(candidate)) return candidate;
  }
  throw new Error(
    `Could not find a writable job directory. Tried: ${candidates.join(", ")}. ` +
    `Set ${JOB_DIR_ENV_VAR}=<path> or pass --job-dir <path> to override.`
  );
}

export function ensureStateDir(cwd, options = {}) {
  ensurePrivateDirectory(resolveJobsDir(cwd, options));
}

function resolveJobArtifact(cwd, jobId, suffix, options = {}) {
  assertValidJobId(jobId);
  ensureStateDir(cwd, options);
  const jobsDir = path.resolve(resolveJobsDir(cwd, options));
  const artifact = path.resolve(jobsDir, `${jobId}${suffix}`);
  if (path.dirname(artifact) !== jobsDir) {
    throw new Error(`Unsafe job artifact path for ${jobId}`);
  }
  return artifact;
}

export function resolveJobFile(cwd, jobId, options = {}) {
  return resolveJobArtifact(cwd, jobId, ".job.json", options);
}

export function resolveJobInputFile(cwd, jobId, options = {}) {
  return resolveJobArtifact(cwd, jobId, ".input.json", options);
}

export function resolveJobLogFile(cwd, jobId, options = {}) {
  return resolveJobArtifact(cwd, jobId, ".log", options);
}

export function resolveJobPromptFile(cwd, jobId, options = {}) {
  return resolveJobArtifact(cwd, jobId, ".prompt.md", options);
}

export function writeJsonAtomic(file, payload) {
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const MALFORMED_LOCK_GRACE_MS = 1_000;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectContender(contenderDir) {
  const ownerFile = path.join(contenderDir, "owner");
  let ownerFd;
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(contenderDir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
    ownerFd = fs.openSync(ownerFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const ownerStat = fs.fstatSync(ownerFd);
    const contents = fs.readFileSync(ownerFd, "utf8");
    const currentOwner = fs.lstatSync(ownerFile);
    const currentDirectory = fs.lstatSync(contenderDir);
    if (
      !ownerStat.isFile() ||
      currentOwner.isSymbolicLink() ||
      currentDirectory.isSymbolicLink() ||
      !sameFileIdentity(ownerStat, currentOwner) ||
      !sameFileIdentity(directoryStat, currentDirectory)
    ) {
      return null;
    }
    return { contents, directoryStat, ownerStat };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return directoryStat
        ? { contents: "", directoryStat, ownerStat: null, malformed: true }
        : { missing: true };
    }
    return null;
  } finally {
    if (ownerFd !== undefined) fs.closeSync(ownerFd);
  }
}

function removeContenderIfUnchanged(contenderDir, expected) {
  const ownerFile = path.join(contenderDir, "owner");
  if (!expected.ownerStat) {
    try {
      const currentDirectory = fs.lstatSync(contenderDir);
      if (!sameFileIdentity(currentDirectory, expected.directoryStat)) return false;
      fs.rmdirSync(contenderDir);
      return true;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }
  const current = inspectContender(contenderDir);
  if (
    !current ||
    current.missing ||
    !sameFileIdentity(current.directoryStat, expected.directoryStat) ||
    !sameFileIdentity(current.ownerStat, expected.ownerStat)
  ) {
    return Boolean(current?.missing);
  }
  try {
    fs.unlinkSync(ownerFile);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  try {
    fs.rmdirSync(contenderDir);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function contenderIsStale(contenderDir, inspected) {
  const contents = inspected.contents.trim();
  const ownerMatch = contents.match(/^(\d+)(?::[A-Za-z0-9_-]+)?$/);
  const holderPid = ownerMatch ? Number(ownerMatch[1]) : null;
  if (!Number.isInteger(holderPid) || holderPid <= 0) {
    try {
      return Date.now() - fs.lstatSync(contenderDir).mtimeMs >= MALFORMED_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  return holderPid !== process.pid && !isProcessAlive(holderPid);
}

function listLiveContenders(queueDir, prefix) {
  const names = [];
  for (const entry of fs.readdirSync(queueDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const contenderDir = path.join(queueDir, entry.name);
    const inspected = inspectContender(contenderDir);
    if (inspected?.missing) continue;
    if (!inspected) {
      names.push(entry.name);
      continue;
    }
    if (contenderIsStale(contenderDir, inspected) && removeContenderIfUnchanged(contenderDir, inspected)) {
      continue;
    }
    names.push(entry.name);
  }
  return names.sort();
}

export function acquireQueuedLock(lockFile, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  let delayMs = 5;
  const queueDir = `${lockFile}.queue`;
  const nonce = Math.random().toString(36).slice(2, 12);
  const token = `${String(process.pid).padStart(10, "0")}-${nonce}`;
  const owner = `${process.pid}:${nonce}\n`;
  let contenderDir = path.join(queueDir, `choosing-${token}`);

  fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
  const queueStat = fs.lstatSync(queueDir);
  if (queueStat.isSymbolicLink() || !queueStat.isDirectory()) {
    throw new Error(`Unsafe job state lock queue ${queueDir}`);
  }
  fs.mkdirSync(contenderDir, { mode: 0o700 });
  fs.writeFileSync(path.join(contenderDir, "owner"), owner, { encoding: "utf8", mode: 0o600, flag: "wx" });

  try {
    const tickets = listLiveContenders(queueDir, "ticket-");
    const maxTicket = tickets.reduce((maximum, name) => {
      const match = name.match(/^ticket-(\d+)-/);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0);
    const ticket = String(maxTicket + 1).padStart(16, "0");
    const ticketDir = path.join(queueDir, `ticket-${ticket}-${token}`);
    fs.renameSync(contenderDir, ticketDir);
    contenderDir = ticketDir;

    while (true) {
      const choosing = listLiveContenders(queueDir, "choosing-");
      const liveTickets = listLiveContenders(queueDir, "ticket-");
      if (choosing.length === 0 && liveTickets[0] === path.basename(contenderDir)) {
        return () => {
          const inspected = inspectContender(contenderDir);
          if (!inspected || inspected.missing || inspected.contents !== owner) return;
          removeContenderIfUnchanged(contenderDir, inspected);
        };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for job state lock ${lockFile}`);
      }
      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  } catch (error) {
    const inspected = inspectContender(contenderDir);
    if (inspected && !inspected.missing && inspected.contents === owner) {
      removeContenderIfUnchanged(contenderDir, inspected);
    }
    throw error;
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

export function readJob(cwd, jobId, options = {}) {
  const file = resolveJobFile(cwd, jobId, options);
  if (!fs.existsSync(file)) {
    return null;
  }
  return migrateJobRecord(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeJob(cwd, jobId, payload, options = {}) {
  ensureStateDir(cwd, options);
  writeJsonAtomic(resolveJobFile(cwd, jobId, options), migrateJobRecord(payload));
}

export function createJob(cwd, jobId, payload, options = {}) {
  ensureStateDir(cwd, options);
  createJsonExclusive(resolveJobFile(cwd, jobId, options), migrateJobRecord(payload));
}

export function updateJob(cwd, jobId, patch, options = {}) {
  const jobFile = resolveJobFile(cwd, jobId, options);
  const releaseLock = acquireQueuedLock(`${jobFile}.lock`);
  try {
    const current = readJob(cwd, jobId, options);
    if (!current) {
      throw new Error(`Unknown job ${jobId}`);
    }
    const next = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    writeJob(cwd, jobId, next, options);
    return next;
  } finally {
    releaseLock();
  }
}

export function writeJobInput(cwd, jobId, payload, options = {}) {
  writeJsonAtomic(resolveJobInputFile(cwd, jobId, options), payload);
}

export function readJobInput(cwd, jobId, options = {}) {
  const file = resolveJobInputFile(cwd, jobId, options);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Job input snapshot missing for ${jobId}; the job record may have been partially deleted.`);
    }
    throw error;
  }
}

export function appendLogLine(cwd, jobId, line, level = "info", options = {}) {
  const normalizedLevel = String(level || "info").toUpperCase();
  const logFile = resolveJobLogFile(cwd, jobId, options);
  let fd;
  try {
    const flags = fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(logFile, flags, 0o600);
    const openedStat = fs.fstatSync(fd);
    const currentStat = fs.lstatSync(logFile);
    if (
      !openedStat.isFile() ||
      currentStat.isSymbolicLink() ||
      !sameFileIdentity(openedStat, currentStat)
    ) {
      throw new Error(`Job log changed while opening it: ${logFile}`);
    }
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `[${nowIso()}] [${jobId}] [${normalizedLevel}] ${line}\n`, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readLogTail(cwd, jobId, maxLines = 6, options = {}) {
  const file = resolveJobLogFile(cwd, jobId, options);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines);
}

export function listJobs(cwd, options = {}) {
  ensureStateDir(cwd, options);
  const jobsDir = resolveJobsDir(cwd, options);
  const jobs = [];
  for (const entry of fs.readdirSync(jobsDir)) {
    if (!entry.endsWith(".job.json")) {
      continue;
    }
    jobs.push(migrateJobRecord(JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8"))));
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
