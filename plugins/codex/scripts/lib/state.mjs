// Modified by Kennedy Umege for Codex-Claude Bridge, 2026.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function terminalMarkerFile(jobFile) {
  return jobFile.replace(/\.json$/, ".terminal.json");
}

function readTerminalMarker(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(terminalMarkerFile(jobFile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    }
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function loadConfiguration(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return defaultState();
  }
  const state = {
    ...defaultState(),
    config: { ...defaultState().config, ...(parsed.config ?? {}) }
  };
  if (Array.isArray(parsed.jobs)) {
    // Legacy summaries and timestamps sometimes existed only in the index. Keep those fields,
    // but prefer an existing per-job record for fields present in both places. Finish every file
    // before retiring the legacy array; a failed migration can safely be retried.
    ensureStateDir(cwd);
    for (const legacy of parsed.jobs) {
      const jobFile = resolveJobFile(cwd, legacy.id);
      let existing;
      try { existing = JSON.parse(fs.readFileSync(jobFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing) {
        const merged = { ...legacy, ...existing };
        if (JSON.stringify(merged) !== JSON.stringify(existing)) writeJsonAtomic(jobFile, merged);
      } else {
        writeJsonAtomic(jobFile, legacy, { exclusive: true });
      }
    }
    writeJsonAtomic(stateFile, state);
  }
  return state;
}

function readJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  let names;
  try { names = fs.readdirSync(jobsDir); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".terminal.json")) continue;
    try { jobs.push(readJobFile(path.join(jobsDir, name))); }
    catch (error) { if (error.code !== "ENOENT") throw error; } // A concurrent prune may remove it.
  }
  return jobs.sort((left, right) =>
    String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? "")) ||
    String(left.id).localeCompare(String(right.id)));
}

export function loadState(cwd) {
  const state = loadConfiguration(cwd);
  return { ...state, jobs: readJobs(cwd) };
}

function pruneJobs(cwd) {
  const jobs = readJobs(cwd);
  removeJobs(cwd, jobs.slice(MAX_JOBS));
  return jobs.slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Every JSON record another process may read while it is rewritten goes through here: readers see the
// old record or the new one, never a truncated file.
export function writeJsonAtomic(filePath, payload, { exclusive = false } = {}) {
  const temporaryFile = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    if (exclusive) {
      try { fs.linkSync(temporaryFile, filePath); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } else {
      fs.renameSync(temporaryFile, filePath);
    }
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Closing after a failed write or flush is best-effort so the original error survives.
      }
    }
    try {
      removeFileIfExists(temporaryFile);
    } catch {
      // Cleanup is best-effort so it cannot mask the original write or rename error.
    }
  }
}

export function saveState(cwd, state) {
  loadConfiguration(cwd);
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    }
  };
  // Configuration remains an atomic, last-writer-wins snapshot. Concurrent configuration edits
  // (including migration's retirement of the legacy array) are not serialized. Job updates never
  // rewrite this snapshot after migration.
  writeJsonAtomic(resolveStateFile(cwd), nextState);
  return { ...nextState, jobs: pruneJobs(cwd) };
}

export function updateState(cwd, mutate) {
  const state = loadConfiguration(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  const state = loadConfiguration(cwd);
  const jobFile = resolveJobFile(cwd, jobPatch.id);
  let existing = {};
  try { existing = readJobFile(jobFile); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const timestamp = nowIso();
  writeJobFile(cwd, jobPatch.id, {
    createdAt: timestamp,
    ...existing,
    ...jobPatch,
    updatedAt: jobPatch.updatedAt ?? timestamp
  });
  return { ...state, jobs: pruneJobs(cwd) };
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadConfiguration(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  if (TERMINAL_STATUSES.has(payload.status)) {
    publishTerminalJob(cwd, jobId, payload);
    return jobFile;
  }
  if (readTerminalMarker(jobFile)) {
    readJobFile(jobFile);
    return jobFile;
  }
  writeJsonAtomic(jobFile, payload);
  if (readTerminalMarker(jobFile)) readJobFile(jobFile);
  return jobFile;
}

export function readJobFile(jobFile) {
  let record;
  try { record = JSON.parse(fs.readFileSync(jobFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const marker = readTerminalMarker(jobFile);
  if (marker) return { ...record, ...marker };
  if (record) return record;
  throw Object.assign(new Error(`Job record not found: ${jobFile}`), { code: "ENOENT" });
}

// link is the single first-writer-wins operation. No overwrite fallback is safe.
export function publishTerminalJob(cwd, jobId, payload) {
  if (!TERMINAL_STATUSES.has(payload.status)) throw new Error("Expected a terminal job status.");
  const jobFile = resolveJobFile(cwd, jobId);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(jobFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const terminal = {
    ...existing,
    ...payload,
    updatedAt: payload.completedAt ?? payload.updatedAt ?? nowIso()
  };
  // A terminal-only job must also have an enumerable base record. Never replace an existing record
  // here: another publisher may already have won the terminal marker.
  if (!fs.existsSync(jobFile)) writeJsonAtomic(jobFile, terminal, { exclusive: true });
  const marker = terminalMarkerFile(jobFile);
  const temporaryFile = `${marker}.${process.pid}.${randomUUID()}.tmp`;
  let won = false;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(terminal, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporaryFile, marker);
      won = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeFileIfExists(temporaryFile);
  }
  const record = readJobFile(jobFile);
  return { won, record };
}

function removeJobFile(jobFile) {
  for (const file of [jobFile, terminalMarkerFile(jobFile)]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// Delete only the selected records, never the complement of a possibly stale snapshot.
export function removeJobs(cwd, jobs) {
  for (const job of jobs) {
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile ?? path.join(resolveJobsDir(cwd), `${job.id}.log`));
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
