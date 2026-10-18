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

function reconcileJobs(state, stateDir) {
  let changed = false;
  state.jobs = state.jobs.map((job) => {
    const marker = readTerminalMarker(path.join(stateDir, JOBS_DIR_NAME, `${job.id}.json`));
    if (!marker) return job;
    const next = { ...job, ...marker };
    if (JSON.stringify(next) !== JSON.stringify(job)) changed = true;
    return next;
  });
  return changed;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
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

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let state;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state = {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
  if (reconcileJobs(state, path.dirname(stateFile))) writeJsonAtomic(stateFile, state);
  return state;
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Every JSON record another process may read while it is rewritten goes through here: readers see the
// old record or the new one, never a truncated file.
export function writeJsonAtomic(filePath, payload) {
  const temporaryFile = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryFile, filePath);
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
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  reconcileJobs(state, resolveStateDir(cwd));
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  if (TERMINAL_STATUSES.has(jobPatch.status)) {
    const jobFile = resolveJobFile(cwd, jobPatch.id);
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(jobFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    publishTerminalJob(cwd, jobPatch.id, { ...existing, ...jobPatch });
  }
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  const state = loadState(cwd);
  if (reconcileJobs(state, resolveStateDir(cwd))) writeJsonAtomic(resolveStateFile(cwd), state);
  return state.jobs;
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
  return loadState(cwd).config;
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
  const marker = readTerminalMarker(jobFile);
  if (marker) {
    const stateFile = path.join(path.dirname(path.dirname(jobFile)), STATE_FILE_NAME);
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (state && Array.isArray(state.jobs) && reconcileJobs(state, path.dirname(stateFile))) {
      writeJsonAtomic(stateFile, state);
    }
    return marker;
  }
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

// link is the single first-writer-wins operation. No overwrite fallback is safe.
export function publishTerminalJob(cwd, jobId, payload) {
  if (!TERMINAL_STATUSES.has(payload.status)) throw new Error("Expected a terminal job status.");
  const jobFile = resolveJobFile(cwd, jobId);
  const marker = terminalMarkerFile(jobFile);
  const temporaryFile = `${marker}.${process.pid}.${randomUUID()}.tmp`;
  let won = false;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
