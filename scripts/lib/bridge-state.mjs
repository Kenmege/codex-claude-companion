import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireQueuedLock,
  assertValidJobId,
  ensurePrivateDirectory,
  writeJsonAtomic
} from "./state.mjs";
import {
  BridgeContractValidationError,
  validateBridgeEventContract,
  validateBridgeRequestContract,
  validateBridgeResultContract
} from "./bridge-contracts.mjs";

export const BRIDGE_STATE_SCHEMA_VERSION = 1;
export const BRIDGE_STATE_ENV_VAR = "CODEX_CLAUDE_BRIDGE_STATE_DIR";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENT_COUNT = 10_000;
const MAX_EVENT_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_PERSISTED_STRING_BYTES = 64 * 1024;
const MAX_PERSISTED_ARRAY_ITEMS = 1_000;
const MAX_PERSISTED_DEPTH = 32;
const BROKER_AUTHORITY_KEY_FILE = "broker-authority.key";

const BRIDGE_JOB_ID_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const TRANSITIONS = Object.freeze({
  accepted: new Set(["running", "failed", "cancelled"]),
  running: new Set(["stalled", "completed", "failed", "cancelled"]),
  stalled: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
});
const EVENT_FOR_STATE = Object.freeze({
  accepted: "accepted",
  running: "started",
  stalled: "blocked",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
});
const STATE_FOR_EVENT = Object.freeze(Object.fromEntries(
  Object.entries(EVENT_FOR_STATE).map(([state, event]) => [event, state])
));
const LIFECYCLE_EVENT_TYPES = new Set(["accepted", "started", "blocked", "completed", "failed", "cancelled"]);
const RESERVED_EVENT_TYPES = new Set([...LIFECYCLE_EVENT_TYPES, "cancel_requested"]);
const EVENT_TYPES = new Set([
  "accepted", "started", "progress", "question", "codex_message", "claude_message",
  "blocked", "completed", "failed", "cancel_requested", "cancelled", "verified"
]);
const EVENT_SENDERS = new Set(["bridge", "codex", "claude", "verifier"]);
const SECRET_KEY = /(?:^|_)(?:authorization|api_?key|(?:access_?|refresh_?|capability_?)?token|password|secret)(?:$|_)/i;
const SECRET_VALUE = /\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})\b/gi;

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tokenHashMatches(expectedHash, token) {
  const expected = Buffer.from(String(expectedHash ?? ""), "hex");
  const actual = Buffer.from(hash(String(token ?? "")), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function assertWorkerCapability(state, options = {}) {
  if (!tokenHashMatches(state.capabilityTokenHash, options.capabilityToken)) {
    throw new Error(`Valid worker capability required for bridge job ${state.jobId}`);
  }
}

function assertBrokerAuthority(state, options = {}) {
  const authority = options.brokerAuthority;
  if (
    authority?.kind !== "bridge-broker"
    || authority.jobId !== state.jobId
    || !tokenHashMatches(state.brokerAuthorityTokenHash, authority.token)
  ) {
    throw new Error(`Valid job-bound broker authority required for bridge job ${state.jobId}`);
  }
}

// These authorization gates deliberately return no credential material. They
// let sibling bridge components authorize a mutation against authoritative job
// state without learning or persisting the broker master key.
export function assertBridgeWorkerCapability(jobId, options = {}) {
  const state = getBridgeJob(jobId, options);
  assertWorkerCapability(state, options);
}

export function assertBridgeBrokerAuthority(jobId, options = {}) {
  const state = getBridgeJob(jobId, options);
  assertBrokerAuthority(state, options);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertPersistenceShape(value, label, depth = 0) {
  if (depth > MAX_PERSISTED_DEPTH) {
    throw new Error(`${label} exceeds ${MAX_PERSISTED_DEPTH}-level nesting quota`);
  }
  if (typeof value === "string" && Buffer.byteLength(value) > MAX_PERSISTED_STRING_BYTES) {
    throw new Error(`${label} string exceeds ${MAX_PERSISTED_STRING_BYTES}-byte quota`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PERSISTED_ARRAY_ITEMS) {
      throw new Error(`${label} array exceeds ${MAX_PERSISTED_ARRAY_ITEMS}-item quota`);
    }
    for (const item of value) assertPersistenceShape(item, label, depth + 1);
  } else if (value && typeof value === "object") {
    for (const entryValue of Object.values(value)) assertPersistenceShape(entryValue, label, depth + 1);
  }
}

function assertBridgeJobId(jobId) {
  assertValidJobId(jobId);
  if (!BRIDGE_JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid bridge job id: expected ccb_ followed by a 26-character uppercase ULID");
  }
  return jobId;
}

function stateRootCandidate(options = {}) {
  if (options.stateRoot) return path.resolve(options.stateRoot);
  if (process.env[BRIDGE_STATE_ENV_VAR]) return path.resolve(process.env[BRIDGE_STATE_ENV_VAR]);
  const base = process.env.XDG_STATE_HOME
    ? path.resolve(process.env.XDG_STATE_HOME)
    : path.join(os.homedir(), ".local", "state");
  return path.join(base, "codex-claude-bridge");
}

export function resolveBridgeStateRoot(options = {}) {
  const root = stateRootCandidate(options);
  ensurePrivateDirectory(root);
  for (const child of ["jobs", "leases", "locks"]) {
    ensurePrivateDirectory(path.join(root, child));
  }
  return root;
}

function readBrokerAuthorityKey(options = {}) {
  const root = resolveBridgeStateRoot(options);
  const file = resolveContained(root, BROKER_AUTHORITY_KEY_FILE);
  const readExisting = () => {
    const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(handle);
      const current = fs.lstatSync(file);
      if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error(`Broker authority key changed identity while opening: ${file}`);
      }
      if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
        throw new Error(`Broker authority key must not be accessible by group or other users: ${file}`);
      }
      const encoded = fs.readFileSync(handle, "utf8").trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error(`Broker authority key is malformed: ${file}`);
      return Buffer.from(encoded, "base64url");
    } finally {
      fs.closeSync(handle);
    }
  };
  try {
    return readExisting();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const release = acquireQueuedLock(path.join(root, "locks", "broker-authority-key"));
  let temporaryFile;
  try {
    try {
      return readExisting();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const encoded = crypto.randomBytes(32).toString("base64url");
    temporaryFile = resolveContained(root, `.${BROKER_AUTHORITY_KEY_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const handle = fs.openSync(temporaryFile, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${encoded}\n`, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporaryFile, file);
    temporaryFile = undefined;
    const directoryHandle = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryHandle);
    } finally {
      fs.closeSync(directoryHandle);
    }
    return Buffer.from(encoded, "base64url");
  } finally {
    if (temporaryFile) {
      try { fs.unlinkSync(temporaryFile); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    release();
  }
}

function deriveBridgeBrokerAuthority(jobId, options = {}) {
  assertBridgeJobId(jobId);
  const token = crypto.createHmac("sha256", readBrokerAuthorityKey(options))
    .update(jobId, "utf8")
    .digest("base64url");
  return Object.freeze({ kind: "bridge-broker", jobId, token });
}

function resolveContained(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe bridge state path outside ${resolvedRoot}`);
  }
  return target;
}

export function resolveBridgeJobDir(jobId, options = {}) {
  assertBridgeJobId(jobId);
  return resolveContained(resolveBridgeStateRoot(options), "jobs", jobId);
}

function jobPaths(jobId, options = {}) {
  const dir = resolveBridgeJobDir(jobId, options);
  return {
    dir,
    request: path.join(dir, "request.json"),
    state: path.join(dir, "state.json"),
    events: path.join(dir, "events.jsonl"),
    dispatch: path.join(dir, "dispatch.json"),
    result: path.join(dir, "result.json"),
    lock: path.join(resolveBridgeStateRoot(options), "locks", `job-${jobId}`)
  };
}

function canonicalWorkspace(workspacePath) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw new Error("workspace path must be absolute");
  }
  const canonical = fs.realpathSync(workspacePath);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("workspace path must be a directory");
  return canonical;
}

function leasePath(canonical, options = {}) {
  return path.join(resolveBridgeStateRoot(options), "leases", `${hash(canonical)}.json`);
}

function createExclusiveJson(file, payload) {
  const handle = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function readJson(file, label) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      const current = fs.lstatSync(file);
      if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error(`${label} changed identity while opening: ${file}`);
      }
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} missing: ${file}`);
    throw new Error(`${label} is not parseable: ${file}`, { cause: error });
  }
}

function assertSafeJobDirectory(dir) {
  const parent = path.dirname(dir);
  ensurePrivateDirectory(parent);
  const stat = fs.lstatSync(dir);
  const canonicalParent = fs.realpathSync(parent);
  const canonicalDir = fs.realpathSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(canonicalDir) !== canonicalParent) {
    throw new Error(`Bridge job directory must be a real contained directory: ${dir}`);
  }
  return stat;
}

function assertSafeArtifact(file, { allowMissing = false } = {}) {
  assertSafeJobDirectory(path.dirname(file));
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Bridge artifact must be a regular file: ${file}`);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
}

function writeStateAtomic(file, state) {
  assertSafeArtifact(file);
  writeJsonAtomic(file, state);
  assertSafeArtifact(file);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function assertCreationMarker(marker, expectedJobId, expectedStagingName) {
  assertPlainObject(marker, "bridge creation marker");
  assertBridgeJobId(marker.jobId);
  if (marker.jobId !== expectedJobId || marker.stagingName !== expectedStagingName) {
    throw new Error(`Bridge creation marker identity mismatch for ${expectedJobId}`);
  }
  if (typeof marker.workspace !== "string" || !path.isAbsolute(marker.workspace)) {
    throw new Error(`Bridge creation marker workspace is invalid for ${expectedJobId}`);
  }
  if (!Number.isInteger(marker.ownerPid) || marker.ownerPid <= 0) {
    throw new Error(`Bridge creation marker owner is invalid for ${expectedJobId}`);
  }
}

function creationLeaseMatches(lease, marker) {
  return lease.jobId === marker.jobId
    && lease.workspace === marker.workspace
    && lease.stagingName === marker.stagingName
    && lease.ownerPid === marker.ownerPid;
}

function releaseCreationLeaseLocked(marker, options) {
  const file = leasePath(marker.workspace, options);
  if (!fs.existsSync(file)) return true;
  const lease = readJson(file, "workspace lease");
  if (!creationLeaseMatches(lease, marker)) return false;
  fs.unlinkSync(file);
  return true;
}

function preservePublishedCreationLeaseLocked(marker, options) {
  const file = leasePath(marker.workspace, options);
  if (fs.existsSync(file)) {
    const lease = readJson(file, "workspace lease");
    return creationLeaseMatches(lease, marker);
  }
  createExclusiveJson(file, {
    schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
    workspace: marker.workspace,
    jobId: marker.jobId,
    acquiredAt: marker.createdAt,
    ownerPid: marker.ownerPid,
    stagingName: marker.stagingName
  });
  return true;
}

function isReclaimableArtifactFreeCreationLease(lease, canonical, root) {
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) return false;
  if (lease.schemaVersion !== BRIDGE_STATE_SCHEMA_VERSION || lease.workspace !== canonical) return false;
  try {
    assertBridgeJobId(lease.jobId);
  } catch {
    return false;
  }
  if (lease.stagingName !== `.creating-${lease.jobId}`) return false;
  if (!Number.isInteger(lease.ownerPid) || lease.ownerPid <= 0 || isProcessAlive(lease.ownerPid)) return false;

  const jobsRoot = path.join(root, "jobs");
  return !fs.existsSync(path.join(jobsRoot, lease.jobId))
    && !fs.existsSync(path.join(jobsRoot, lease.stagingName))
    && !fs.existsSync(path.join(jobsRoot, `${lease.stagingName}.json`));
}

function reconcileOrphanCreationsLocked(root, options = {}) {
  const jobsRoot = path.join(root, "jobs");
  const releaseLeaseLock = acquireQueuedLock(path.join(root, "locks", "workspace-leases"));
  try {
    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      const sidecarMatch = entry.name.match(/^\.creating-(ccb_[0-9A-HJKMNP-TV-Z]{26})\.json$/);
      if (!sidecarMatch) continue;
      const sidecar = path.join(jobsRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe bridge creation marker entry: ${sidecar}`);
      const jobId = sidecarMatch[1];
      const stagingName = `.creating-${jobId}`;
      const marker = readJson(sidecar, "bridge creation marker");
      assertCreationMarker(marker, jobId, stagingName);
      if (isProcessAlive(marker.ownerPid)) continue;
      const staging = path.join(jobsRoot, stagingName);
      const finalDir = path.join(jobsRoot, jobId);
      if (fs.existsSync(finalDir)) continue;
      if (!releaseCreationLeaseLocked(marker, options)) continue;
      if (fs.existsSync(staging)) {
        const stat = fs.lstatSync(staging);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe bridge creation staging entry: ${staging}`);
        fs.rmSync(staging, { recursive: true });
      }
      fs.unlinkSync(sidecar);
    }

    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith(".creating-") || entry.name.endsWith(".json")) continue;
      const staging = path.join(jobsRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe bridge creation staging entry: ${staging}`);
      const markerFile = path.join(staging, "creation.json");
      let marker;
      try {
        marker = readJson(markerFile, "bridge creation marker");
      } catch {
        continue;
      }
      assertCreationMarker(marker, entry.name.slice(".creating-".length), entry.name);
      if (isProcessAlive(marker.ownerPid)) continue;
      const finalDir = path.join(jobsRoot, marker.jobId);
      if (fs.existsSync(finalDir)) continue;
      if (!releaseCreationLeaseLocked(marker, options)) continue;
      fs.rmSync(staging, { recursive: true });
    }

    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      let jobId;
      try { jobId = assertBridgeJobId(entry.name); } catch { continue; }
      const finalDir = path.join(jobsRoot, jobId);
      const markerFile = path.join(finalDir, "creation.json");
      if (!fs.existsSync(markerFile)) continue;
      const marker = readJson(markerFile, "bridge creation marker");
      assertCreationMarker(marker, jobId, `.creating-${jobId}`);
      if (isProcessAlive(marker.ownerPid)) continue;
      for (const artifact of ["request.json", "state.json", "events.jsonl"]) {
        assertSafeArtifact(path.join(finalDir, artifact));
      }
      if (!preservePublishedCreationLeaseLocked(marker, options)) continue;
      fs.unlinkSync(markerFile);
    }
  } finally {
    releaseLeaseLock();
  }
}

function acquireWorkspaceLease(canonical, jobId, options = {}, creation = null) {
  const root = resolveBridgeStateRoot(options);
  const file = leasePath(canonical, options);
  const release = acquireQueuedLock(path.join(root, "locks", "workspace-leases"));
  try {
    if (fs.existsSync(file)) {
      const current = readJson(file, "workspace lease");
      if (current.jobId !== jobId) {
        if (isReclaimableArtifactFreeCreationLease(current, canonical, root)) {
          fs.unlinkSync(file);
        } else {
          throw new Error(`Workspace already leased by ${current.jobId}: ${canonical}`);
        }
      } else {
        return file;
      }
    }
    createExclusiveJson(file, {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      workspace: canonical,
      jobId,
      acquiredAt: nowIso(options.clock),
      ownerPid: creation?.ownerPid ?? null,
      stagingName: creation?.stagingName ?? null
    });
    return file;
  } finally {
    release();
  }
}

function releaseWorkspaceLease(state, options = {}) {
  if (!state?.workspace) return false;
  const root = resolveBridgeStateRoot(options);
  const file = leasePath(state.workspace, options);
  const release = acquireQueuedLock(path.join(root, "locks", "workspace-leases"));
  try {
    if (!fs.existsSync(file)) return false;
    const current = readJson(file, "workspace lease");
    if (current.jobId !== state.jobId || current.workspace !== state.workspace) return false;
    fs.unlinkSync(file);
    return true;
  } finally {
    release();
  }
}

export function redactBridgeValue(value, key = "", seen = new WeakSet()) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new BridgeContractValidationError("Bridge value contains a cycle and cannot be persisted.", { phase: "semantics" });
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const result = value.map((item) => redactBridgeValue(item, "", seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    const result = Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactBridgeValue(entryValue, entryKey, seen)
    ]));
    seen.delete(value);
    return result;
  }
  return value;
}

function appendEventLocked(paths, state, eventInput, options = {}) {
  assertPlainObject(eventInput, "event");
  const deduplicationKey = String(eventInput.deduplicationKey ?? "");
  if (!deduplicationKey || deduplicationKey.length > 256) {
    throw new Error("event deduplicationKey must contain 1-256 characters");
  }
  const type = String(eventInput.type ?? "");
  const sender = String(eventInput.sender ?? "bridge");
  if (!EVENT_TYPES.has(type)) throw new Error(`Unknown bridge event type ${type}`);
  if (!EVENT_SENDERS.has(sender)) throw new Error(`Unknown bridge event sender ${sender}`);
  assertPlainObject(eventInput.payload ?? {}, "event payload");
  const journal = readEventFile(paths.events, state.jobId);
  for (const recorded of journal) {
    state.lastEventSequence = Math.max(state.lastEventSequence, recorded.sequence);
    state.eventDeduplication = {
      ...state.eventDeduplication,
      [recorded.deduplicationKey]: recorded.sequence
    };
  }
  const priorSequence = state.eventDeduplication?.[deduplicationKey];
  if (priorSequence) {
    return journal.find((event) => event.sequence === priorSequence);
  }
  if (journal.length >= MAX_EVENT_COUNT) {
    throw new Error(`Bridge event journal exceeds ${MAX_EVENT_COUNT}-event quota for ${state.jobId}`);
  }
  const event = redactBridgeValue({
    schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
    jobId: state.jobId,
    sequence: state.lastEventSequence + 1,
    timestamp: eventInput.timestamp ?? nowIso(options.clock),
    type,
    sender,
    deduplicationKey,
    payload: eventInput.payload ?? {}
  });
  assertPersistenceShape(event, "Bridge event");
  validateBridgeEventContract(event);
  const priorEvent = journal.at(-1);
  if (priorEvent && Date.parse(event.timestamp) < Date.parse(priorEvent.timestamp)) {
    throw new Error(`Event timestamp regression for ${state.jobId} at sequence ${event.sequence}`);
  }
  const line = `${JSON.stringify(event)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > MAX_EVENT_BYTES) {
    throw new Error(`Bridge event exceeds ${MAX_EVENT_BYTES}-byte quota for ${state.jobId}`);
  }
  assertSafeArtifact(paths.events, { allowMissing: true });
  const handle = fs.openSync(paths.events, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    const eventStat = fs.fstatSync(handle);
    const currentEventStat = fs.lstatSync(paths.events);
    if (!eventStat.isFile() || currentEventStat.isSymbolicLink() || eventStat.dev !== currentEventStat.dev || eventStat.ino !== currentEventStat.ino) {
      throw new Error(`Bridge event journal changed identity while opening: ${paths.events}`);
    }
    if (eventStat.size + lineBytes > MAX_EVENT_JOURNAL_BYTES) {
      throw new Error(`Bridge event journal exceeds ${MAX_EVENT_JOURNAL_BYTES}-byte quota for ${state.jobId}`);
    }
    if (eventStat.size > 0) {
      const lastByte = Buffer.alloc(1);
      fs.readSync(handle, lastByte, 0, 1, eventStat.size - 1);
      if (lastByte[0] !== 0x0a) {
        const journalBytes = Buffer.alloc(eventStat.size);
        fs.readSync(handle, journalBytes, 0, eventStat.size, 0);
        const lastNewline = journalBytes.lastIndexOf(0x0a);
        fs.ftruncateSync(handle, lastNewline + 1);
      }
    }
    fs.writeFileSync(handle, line, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  state.lastEventSequence = event.sequence;
  state.eventDeduplication = { ...state.eventDeduplication, [deduplicationKey]: event.sequence };
  state.updatedAt = event.timestamp;
  return event;
}

export function createBridgeJob(request, options = {}) {
  assertPlainObject(request, "request");
  validateBridgeRequestContract(request);
  if (request.execution?.profile === "sandbox-autonomous") {
    throw new BridgeContractValidationError(
      "sandbox-autonomous creation is unavailable until a trusted executor-owned authority and freshness verifier is implemented.",
      { phase: "semantics" }
    );
  }
  const jobId = assertBridgeJobId(request.jobId);
  const workspace = canonicalWorkspace(
    request.execution?.canonicalWorkspacePath ?? request.origin?.repoRoot ?? request.origin?.cwd
  );
  const finalPaths = jobPaths(jobId, options);
  const root = resolveBridgeStateRoot(options);
  const releaseCreationLock = acquireQueuedLock(path.join(root, "locks", "job-creations"));
  const stagingName = `.creating-${jobId}`;
  const stagingDir = resolveContained(root, "jobs", stagingName);
  const sidecarMarker = resolveContained(root, "jobs", `${stagingName}.json`);
  const paths = {
    ...finalPaths,
    dir: stagingDir,
    request: path.join(stagingDir, "request.json"),
    state: path.join(stagingDir, "state.json"),
    events: path.join(stagingDir, "events.jsonl"),
    dispatch: path.join(stagingDir, "dispatch.json"),
    result: path.join(stagingDir, "result.json")
  };
  let lease;
  let published = false;
  try {
    reconcileOrphanCreationsLocked(root, options);
    if (fs.existsSync(finalPaths.dir)) {
      const error = new Error(`EEXIST: bridge job already exists: ${jobId}`);
      error.code = "EEXIST";
      throw error;
    }
    createExclusiveJson(sidecarMarker, {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      jobId,
      workspace,
      ownerPid: process.pid,
      stagingName,
      createdAt: nowIso(options.clock)
    });
    fs.mkdirSync(stagingDir, { mode: 0o700 });
    fs.renameSync(sidecarMarker, path.join(stagingDir, "creation.json"));
    lease = acquireWorkspaceLease(workspace, jobId, options, { ownerPid: process.pid, stagingName });
    const capabilityToken = options.capabilityToken ?? crypto.randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(capabilityToken)) {
      throw new Error("precommitted worker capability must be a 43-character base64url token");
    }
    const brokerAuthority = deriveBridgeBrokerAuthority(jobId, options);
    const timestamp = nowIso(options.clock);
    const persistedRequest = redactBridgeValue(structuredClone(request));
    validateBridgeRequestContract(persistedRequest);
    createExclusiveJson(paths.request, persistedRequest);
    const state = {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      jobId,
      provider: request.worker?.provider ?? "unknown",
      workspace,
      status: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalAt: null,
      cancelRequestedAt: null,
      resultStatus: null,
      dispatch: null,
      lastEventSequence: 0,
      eventDeduplication: {},
      capabilityTokenHash: hash(capabilityToken),
      brokerAuthorityTokenHash: hash(brokerAuthority.token),
      requestHash: hash(JSON.stringify(persistedRequest))
    };
    appendEventLocked(paths, state, {
      type: "accepted",
      sender: "bridge",
      timestamp,
      deduplicationKey: "lifecycle:accepted",
      payload: { acceptedAt: timestamp }
    }, options);
    createExclusiveJson(paths.state, state);
    fs.renameSync(stagingDir, finalPaths.dir);
    published = true;
    fs.unlinkSync(path.join(finalPaths.dir, "creation.json"));
    return {
      job: structuredClone(state),
      capabilityToken,
      brokerAuthority
    };
  } catch (error) {
    if (!published && lease && fs.existsSync(lease)) {
      let releaseLeaseLock;
      try {
        releaseLeaseLock = acquireQueuedLock(path.join(root, "locks", "workspace-leases"));
        const current = readJson(lease, "workspace lease");
        if (current.jobId === jobId) fs.unlinkSync(lease);
      } catch {
        // Recovery will reconcile an unreadable lease; preserve the original error.
      } finally {
        releaseLeaseLock?.();
      }
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    try { fs.unlinkSync(sidecarMarker); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  } finally {
    releaseCreationLock();
  }
}

export function readBridgeRequest(jobId, options = {}) {
  const paths = jobPaths(jobId, options);
  assertSafeArtifact(paths.request);
  const request = readJson(paths.request, "immutable request");
  validateBridgeRequestContract(request);
  const state = readJson(paths.state, "authoritative job state");
  if (hash(JSON.stringify(request)) !== state.requestHash) throw new Error(`Immutable request identity mismatch for ${jobId}`);
  return request;
}

export function getBridgeJob(jobId, options = {}) {
  const paths = jobPaths(jobId, options);
  assertSafeArtifact(paths.state);
  const state = readJson(paths.state, "authoritative job state");
  if (state.jobId !== jobId || !BRIDGE_JOB_ID_PATTERN.test(state.jobId)) throw new Error(`Authoritative job state identity mismatch for ${jobId}`);
  return structuredClone(state);
}

export function getBridgeBrokerAuthority(jobId, options = {}) {
  const authority = deriveBridgeBrokerAuthority(jobId, options);
  const state = getBridgeJob(jobId, options);
  if (!tokenHashMatches(state.brokerAuthorityTokenHash, authority.token)) {
    throw new Error(`Broker authority key does not match bridge job ${jobId}`);
  }
  return authority;
}

export function verifyBridgeCapability(jobId, capabilityToken, options = {}) {
  return tokenHashMatches(getBridgeJob(jobId, options).capabilityTokenHash, capabilityToken);
}

function readEventFile(file, jobId) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  assertSafeArtifact(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let contents;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_EVENT_JOURNAL_BYTES) {
      throw new Error(`Bridge event journal exceeds ${MAX_EVENT_JOURNAL_BYTES}-byte quota for ${jobId}`);
    }
    contents = fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
  const complete = contents.endsWith("\n") ? contents : contents.slice(0, contents.lastIndexOf("\n") + 1);
  const events = [];
  const keys = new Set();
  let expectedSequence = 1;
  let priorTimestamp = -Infinity;
  for (const line of complete.split("\n").filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new BridgeContractValidationError(`Complete bridge event line is not valid JSON for ${jobId}.`, { phase: "schema", errors: [{ message: error.message }] });
    }
    validateBridgeEventContract(event);
    if (event.jobId !== jobId) throw new Error(`Event job identity mismatch for ${jobId}`);
    if (event.sequence !== expectedSequence) throw new Error(`Event sequence gap for ${jobId}: expected ${expectedSequence}`);
    if (keys.has(event.deduplicationKey)) throw new Error(`Duplicate event deduplication key for ${jobId}: ${event.deduplicationKey}`);
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < priorTimestamp) throw new Error(`Event timestamp regression for ${jobId} at sequence ${event.sequence}`);
    keys.add(event.deduplicationKey);
    events.push(event);
    if (events.length > MAX_EVENT_COUNT) {
      throw new Error(`Bridge event journal exceeds ${MAX_EVENT_COUNT}-event quota for ${jobId}`);
    }
    expectedSequence += 1;
    priorTimestamp = timestamp;
  }
  return events;
}

function assertStateOperationEventProvenance(event) {
  if (LIFECYCLE_EVENT_TYPES.has(event.type) && event.sender !== "bridge") {
    throw new Error(`Invalid lifecycle event sender ${event.sender} for ${event.type} at sequence ${event.sequence}`);
  }
}

export function readBridgeEvents(jobId, options = {}) {
  return readEventFile(jobPaths(jobId, options).events, jobId);
}

export function appendBridgeEvent(jobId, eventInput, options = {}) {
  if (RESERVED_EVENT_TYPES.has(String(eventInput?.type ?? "")) || String(eventInput?.deduplicationKey ?? "").startsWith("lifecycle:")) {
    throw new Error("Reserved lifecycle/control events may only be emitted by bridge state operations");
  }
  if (eventInput?.sender !== undefined && eventInput.sender !== "claude") {
    throw new Error("Worker events must use sender claude");
  }
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertWorkerCapability(state, options);
    const event = appendEventLocked(paths, state, { ...eventInput, sender: "claude" }, options);
    writeStateAtomic(paths.state, state);
    return structuredClone(event);
  } finally {
    release();
  }
}

export function appendBridgeCodexMessage(jobId, messageInput, options = {}) {
  assertPlainObject(messageInput, "Codex message");
  const messageId = String(messageInput.messageId ?? "");
  const text = String(messageInput.text ?? "");
  const replyTo = messageInput.replyTo == null ? null : String(messageInput.replyTo);
  if (!messageId || messageId.length > 256) throw new Error("Codex message id must contain 1-256 characters");
  if (!text || text.length > 64 * 1024) throw new Error("Codex message text must contain 1-65536 characters");
  if (replyTo !== null && (!replyTo || replyTo.length > 256)) throw new Error("Codex replyTo must contain 1-256 characters");
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertBrokerAuthority(state, options);
    if (TERMINAL_STATES.has(state.status)) throw new Error(`Cannot message terminal job ${jobId} (${state.status})`);
    const event = appendEventLocked(paths, state, {
      type: "codex_message",
      sender: "codex",
      deduplicationKey: `codex-message:${messageId}`,
      payload: { messageId, text, ...(replyTo ? { replyTo } : {}) }
    }, options);
    writeStateAtomic(paths.state, state);
    return structuredClone(event);
  } finally {
    release();
  }
}

function validatedDispatchIdentity(jobId, identity, request) {
  assertPlainObject(identity, "dispatch identity");
  const allowed = new Set([
    "executor", "tmuxSession", "paneId", "panePid", "workerPid", "claudeSessionId",
    "requestedPermissionMode", "effectivePermissionMode", "permissionVerification",
    "origin", "recordedAt"
  ]);
  for (const key of Object.keys(identity)) {
    if (!allowed.has(key)) throw new Error(`Unknown dispatch identity field: ${key}`);
  }
  if (identity.executor !== request.execution.executor || identity.executor !== "tmux") {
    throw new Error(`Dispatch executor mismatch for ${jobId}`);
  }
  if (identity.tmuxSession !== request.execution.tmuxSession) {
    throw new Error(`Dispatch tmux session mismatch for ${jobId}`);
  }
  if (typeof identity.paneId !== "string" || !/^%[0-9]+$/.test(identity.paneId)) {
    throw new Error("dispatch identity paneId must be an exact tmux pane id");
  }
  if (!Number.isInteger(identity.panePid) || identity.panePid <= 0) {
    throw new Error("dispatch identity panePid must be a positive integer");
  }
  if (!Number.isInteger(identity.workerPid) || identity.workerPid <= 0) {
    throw new Error("dispatch identity workerPid must be a positive integer");
  }
  if (identity.claudeSessionId !== request.execution.claudeSessionId) {
    throw new Error(`Dispatch Claude session mismatch for ${jobId}`);
  }
  const attestationFields = [
    identity.requestedPermissionMode,
    identity.effectivePermissionMode,
    identity.permissionVerification
  ];
  const hasAttestation = attestationFields.some((value) => value !== undefined);
  if (hasAttestation && attestationFields.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`Dispatch permission attestation is incomplete for ${jobId}`);
  }
  if (hasAttestation && identity.permissionVerification !== "verified") {
    throw new Error(`Dispatch permission attestation is not verified for ${jobId}`);
  }
  if (hasAttestation && identity.requestedPermissionMode !== identity.effectivePermissionMode) {
    throw new Error(`Dispatch permission attestation mismatch for ${jobId}`);
  }
  if (JSON.stringify(identity.origin) !== JSON.stringify(request.origin)) {
    throw new Error(`Dispatch origin mismatch for ${jobId}`);
  }
  if (typeof identity.recordedAt !== "string" || !Number.isFinite(Date.parse(identity.recordedAt))) {
    throw new Error("dispatch identity recordedAt must be an RFC 3339 timestamp");
  }
  const persisted = redactBridgeValue(structuredClone(identity));
  assertPersistenceShape(persisted, "Dispatch identity");
  return persisted;
}

export function recordDispatch(jobId, identity, options = {}) {
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertBrokerAuthority(state, options);
    const request = readBridgeRequest(jobId, options);
    const persistedIdentity = validatedDispatchIdentity(jobId, identity, request);
    assertSafeArtifact(paths.dispatch, { allowMissing: true });
    if (fs.existsSync(paths.dispatch)) {
      const durableIdentity = validatedDispatchIdentity(
        jobId,
        readJson(paths.dispatch, "immutable dispatch identity"),
        request
      );
      if (JSON.stringify(durableIdentity) !== JSON.stringify(persistedIdentity)) {
        throw new Error(`Dispatch identity is immutable for ${jobId}`);
      }
    } else {
      createExclusiveJson(paths.dispatch, persistedIdentity);
      assertSafeArtifact(paths.dispatch);
    }
    if (state.dispatch !== null && state.dispatch !== undefined) {
      if (JSON.stringify(state.dispatch) !== JSON.stringify(persistedIdentity)) {
        throw new Error(`Dispatch identity is immutable for ${jobId}`);
      }
      if (state.status !== "running") {
        throw new Error(`Recorded dispatch for ${jobId} has inconsistent state ${state.status}`);
      }
      return structuredClone(state);
    }
    if (state.status !== "accepted") {
      throw new Error(`Cannot record dispatch for ${jobId} in state ${state.status}`);
    }
    const timestamp = nowIso(options.clock);
    state.status = "running";
    state.dispatch = persistedIdentity;
    state.updatedAt = timestamp;
    appendEventLocked(paths, state, {
      type: "started",
      sender: "bridge",
      timestamp,
      deduplicationKey: `lifecycle:running:${state.lastEventSequence + 1}`,
      payload: { executor: request.execution.executor }
    }, options);
    writeStateAtomic(paths.state, state);
    return structuredClone(state);
  } finally {
    release();
  }
}

export function transitionBridgeJob(jobId, nextStatus, details = {}, options = {}) {
  if (!(nextStatus in TRANSITIONS)) throw new Error(`Unknown bridge job state ${nextStatus}`);
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertBrokerAuthority(state, options);
    if (state.status === nextStatus) return structuredClone(state);
    if (!TRANSITIONS[state.status]?.has(nextStatus)) {
      throw new Error(`Invalid bridge job transition ${state.status} -> ${nextStatus}`);
    }
    if (nextStatus === "cancelled") {
      const events = readEventFile(paths.events, jobId);
      const requestEvent = events.find((event) => event.type === "cancel_requested");
      if (!state.cancelRequestedAt || !requestEvent || requestEvent.payload.requestedAt !== state.cancelRequestedAt) {
        throw new Error(`Cannot confirm cancellation of ${jobId} without prior durable cancel_requested intent`);
      }
    }
    const timestamp = nowIso(options.clock);
    const request = readBridgeRequest(jobId, options);
    const payload = (() => {
      if (nextStatus === "running") return { executor: request.execution.executor };
      if (nextStatus === "stalled") return { reason: String(details.reason ?? "Worker is blocked") };
      if (nextStatus === "completed") return { resultPath: paths.result };
      if (nextStatus === "failed") return { error: String(details.error ?? details.reason ?? "Worker failed") };
      if (nextStatus === "cancelled") return { reason: String(details.reason ?? "Executor confirmed cancellation") };
      throw new Error(`No lifecycle event contract for ${nextStatus}`);
    })();
    state.status = nextStatus;
    state.updatedAt = timestamp;
    if (TERMINAL_STATES.has(nextStatus)) state.terminalAt = timestamp;
    appendEventLocked(paths, state, {
      type: EVENT_FOR_STATE[nextStatus],
      sender: "bridge",
      timestamp,
      deduplicationKey: `lifecycle:${nextStatus}:${state.lastEventSequence + 1}`,
      payload
    }, options);
    writeStateAtomic(paths.state, state);
    if (TERMINAL_STATES.has(nextStatus)) releaseWorkspaceLease(state, options);
    return structuredClone(state);
  } finally {
    release();
  }
}

export function requestBridgeCancellation(jobId, reason = "Cancellation requested by caller", options = {}) {
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertBrokerAuthority(state, options);
    if (state.status === "cancelled") {
      const events = readEventFile(paths.events, jobId);
      const requestIndex = events.findIndex((event) => event.type === "cancel_requested");
      const confirmationIndex = events.findIndex((event) => event.type === "cancelled");
      if (requestIndex >= 0 && confirmationIndex > requestIndex) return structuredClone(state);
      throw new Error(`Cancelled job ${jobId} lacks durable request and confirmation evidence`);
    }
    if (TERMINAL_STATES.has(state.status)) throw new Error(`Cannot request cancellation of terminal job ${jobId} (${state.status})`);
    if (state.cancelRequestedAt) return structuredClone(state);
    const requestedAt = nowIso(options.clock);
    appendEventLocked(paths, state, {
      type: "cancel_requested",
      sender: "codex",
      timestamp: requestedAt,
      deduplicationKey: "control:cancel-requested",
      payload: { reason: String(reason), requestedAt }
    }, options);
    state.cancelRequestedAt = requestedAt;
    writeStateAtomic(paths.state, state);
    return structuredClone(state);
  } finally {
    release();
  }
}

// Compatibility alias. This records durable intent only; executors must later
// confirm termination with transitionBridgeJob(jobId, "cancelled", ...).
export function cancelBridgeJob(jobId, reason = "Cancellation requested by caller", options = {}) {
  return requestBridgeCancellation(jobId, reason, options);
}

export function writeBridgeResult(jobId, result, options = {}) {
  assertPlainObject(result, "result");
  validateBridgeResultContract(result);
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertBrokerAuthority(state, options);
    if (!TERMINAL_STATES.has(state.status)) throw new Error("Cannot write result before a terminal job state");
    if (result.jobId !== jobId || result.status !== state.status) {
      throw new Error("Result identity and status must match the terminal job");
    }
    const redacted = redactBridgeValue(result);
    assertPersistenceShape(redacted, "Bridge result");
    if (Buffer.byteLength(JSON.stringify(redacted)) > MAX_RESULT_BYTES) {
      throw new Error(`Bridge result exceeds ${MAX_RESULT_BYTES}-byte quota`);
    }
    validateBridgeResultContract(redacted);
    assertSafeArtifact(paths.result, { allowMissing: true });
    if (fs.existsSync(paths.result)) {
      const current = readJson(paths.result, "bridge result");
      if (JSON.stringify(current) !== JSON.stringify(redacted)) throw new Error("Bridge result is immutable once written");
      return current;
    }
    createExclusiveJson(paths.result, redacted);
    assertSafeArtifact(paths.result);
    state.resultStatus = result.status;
    state.updatedAt = nowIso(options.clock);
    writeStateAtomic(paths.state, state);
    return structuredClone(redacted);
  } finally {
    release();
  }
}

export function readBridgeResult(jobId, options = {}) {
  const file = jobPaths(jobId, options).result;
  if (!fs.existsSync(file)) return null;
  assertSafeArtifact(file);
  const result = readJson(file, "bridge result");
  validateBridgeResultContract(result);
  if (result.jobId !== jobId) throw new Error(`Bridge result identity mismatch for ${jobId}`);
  return result;
}

export function recoverBridgeJob(jobId, options = {}) {
  const paths = jobPaths(jobId, options);
  const release = acquireQueuedLock(paths.lock);
  try {
    const state = readJson(paths.state, "authoritative job state");
    assertBrokerAuthority(state, options);
    const request = readBridgeRequest(jobId, options);
    const events = readEventFile(paths.events, jobId);
    if (events[0]?.type !== "accepted" || events[0]?.sender !== "bridge") {
      throw new Error(`Bridge journal for ${jobId} must begin with accepted`);
    }
    const deduplication = {};
    let replayStatus = "accepted";
    let terminalAt = null;
    let cancelRequestedAt = null;
    for (const event of events) {
      assertStateOperationEventProvenance(event);
      deduplication[event.deduplicationKey] = event.sequence;
      if (event.type === "cancel_requested") cancelRequestedAt = event.payload.requestedAt;
      const target = STATE_FOR_EVENT[event.type];
      if (target && event.type !== "accepted") {
        if (target === "cancelled" && !cancelRequestedAt) {
          throw new Error(`Invalid bridge journal cancellation without prior cancel_requested at sequence ${event.sequence}`);
        }
        if (!TRANSITIONS[replayStatus]?.has(target)) {
          throw new Error(`Invalid bridge journal transition ${replayStatus} -> ${target} at sequence ${event.sequence}`);
        }
        replayStatus = target;
        terminalAt = TERMINAL_STATES.has(target) ? event.timestamp : null;
      }
    }
    let dispatch = null;
    if (fs.existsSync(paths.dispatch)) {
      assertSafeArtifact(paths.dispatch);
      dispatch = validatedDispatchIdentity(
        jobId,
        readJson(paths.dispatch, "immutable dispatch identity"),
        request
      );
      if (replayStatus === "accepted") {
        const timestamp = nowIso(options.clock);
        state.lastEventSequence = events.length;
        state.eventDeduplication = deduplication;
        const startedEvent = appendEventLocked(paths, state, {
          type: "started",
          sender: "bridge",
          timestamp,
          deduplicationKey: `lifecycle:running:${state.lastEventSequence + 1}`,
          payload: { executor: request.execution.executor }
        }, options);
        events.push(startedEvent);
        deduplication[startedEvent.deduplicationKey] = startedEvent.sequence;
        replayStatus = "running";
      }
    } else if (state.dispatch !== null && state.dispatch !== undefined) {
      throw new Error(`Authoritative state for ${jobId} references a missing dispatch identity`);
    }
    state.status = replayStatus;
    state.dispatch = dispatch;
    state.terminalAt = terminalAt;
    state.cancelRequestedAt = cancelRequestedAt;
    state.lastEventSequence = events.length;
    state.eventDeduplication = deduplication;
    state.updatedAt = events.at(-1)?.timestamp ?? state.createdAt;
    state.resultStatus = null;
    if (fs.existsSync(paths.result)) {
      const result = readBridgeResult(jobId, options);
      if (result.jobId !== jobId || result.status !== state.status) {
        throw new Error(`Result does not match recovered job state for ${jobId}`);
      }
      state.resultStatus = result.status;
    }
    writeStateAtomic(paths.state, state);
    if (TERMINAL_STATES.has(state.status)) releaseWorkspaceLease(state, options);
    else acquireWorkspaceLease(state.workspace, jobId, options);
    return structuredClone(state);
  } finally {
    release();
  }
}

export function collectBridgeJobs(options = {}) {
  if (typeof options.brokerAuthorityForJob !== "function") {
    throw new Error("collectBridgeJobs requires brokerAuthorityForJob(jobId)");
  }
  const root = resolveBridgeStateRoot(options);
  const jobsRoot = path.join(root, "jobs");
  const olderThanMs = options.olderThanMs ?? 30 * 24 * 60 * 60 * 1_000;
  const now = options.nowMs ?? Date.now();
  const removed = [];
  const entries = options.candidateJobIds
    ? options.candidateJobIds.map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false }))
    : fs.readdirSync(jobsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const jobId = entry.name;
    let releaseJobLock;
    try {
      assertBridgeJobId(jobId);
      const paths = jobPaths(jobId, options);
      releaseJobLock = acquireQueuedLock(paths.lock);
      const state = readJson(paths.state, "authoritative job state");
      if (!TERMINAL_STATES.has(state.status) || !state.terminalAt) continue;
      if (now - Date.parse(state.terminalAt) < olderThanMs) continue;
      assertBrokerAuthority(state, {
        ...options,
        brokerAuthority: options.brokerAuthorityForJob(jobId)
      });
      releaseWorkspaceLease(state, options);
      fs.rmSync(paths.dir, { recursive: true });
      removed.push(jobId);
    } catch (error) {
      if (options.onError) options.onError(error, jobId);
    } finally {
      releaseJobLock?.();
    }
  }
  return removed;
}
