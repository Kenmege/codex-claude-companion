import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildBridgeRequest } from "./bridge-request.mjs";
import * as defaultStateApi from "./bridge-state.mjs";
import { buildBridgeWorkerPrompt } from "./bridge-worker-protocol.mjs";
import { runCommand, spawnDetached } from "./process.mjs";

const BROKER_SCRIPT = fileURLToPath(new URL("../bridge-broker.mjs", import.meta.url));
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const JOB_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROGRESS_PHASES = new Set(["prepared", "spawn-reserved", "dispatched", "terminal"]);
const DEFAULT_SPAWN_RESERVATION_GRACE_MS = 10_000;

function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error(`unsafe private repair artifact: ${file}`);
  }
}

function readJson(file) {
  privateFile(file);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function writeJsonAtomic(file, payload) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function writeJsonExclusive(file, payload) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, serialized, "utf8");
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    try {
      // The hard link publishes the fully synced inode atomically without ever
      // replacing an existing immutable envelope.
      fs.linkSync(temporary, file);
      syncDirectory(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      privateFile(file);
      if (fs.readFileSync(file, "utf8") !== serialized) {
        throw new Error(`immutable repair correlation conflicts with existing artifact: ${file}`);
      }
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function discoverBrokerProcess(nodeBinary, brokerScript, specFile, listProcesses = runCommand) {
  if (process.platform === "win32") return null;
  const listed = listProcesses("ps", ["-ww", "-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024
  });
  if (listed.status !== 0 || typeof listed.stdout !== "string") {
    throw new Error("unable to inspect process identities for repair broker recovery");
  }
  const expectedCommand = `${nodeBinary} ${brokerScript} --spec ${specFile}`;
  const matches = listed.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || match[2].trimEnd() !== expectedCommand) return [];
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? [pid] : [];
  });
  if (matches.length > 1) {
    throw new Error(`multiple repair brokers match durable spec ${specFile}`);
  }
  return matches[0] ?? null;
}

function safeFailedAttempt(value, stateApi) {
  const redacted = stateApi.redactBridgeValue(structuredClone(value));
  const encoded = JSON.stringify(redacted);
  if (Buffer.byteLength(encoded) > 128 * 1024) {
    throw new Error("failed verification attempt exceeds repair evidence quota");
  }
  return redacted;
}

function agentSelection(request) {
  return {
    ...(request.worker.agent ? { agent: request.worker.agent } : {}),
    ...(request.worker.inlineAgents ? { agents: request.worker.inlineAgents } : {}),
    ...(request.worker.customAgentsFile ? { customAgentsFile: request.worker.customAgentsFile } : {})
  };
}

function buildChildRequest(parent, buildRequest) {
  return buildRequest({
    ...agentSelection(parent),
    model: parent.worker.model,
    effort: parent.worker.effort,
    profile: parent.execution.profile,
    executor: "tmux",
    workspace: "current",
    workspacePath: parent.execution.canonicalWorkspacePath,
    permittedRoot: parent.execution.permittedRoot,
    timeout: parent.execution.timeoutSeconds,
    codexThreadId: parent.origin.codexThreadId,
    codexTurnId: parent.origin.codexTurnId,
    cwd: parent.origin.cwd,
    repoRoot: parent.origin.repoRoot,
    branch: parent.origin.branch,
    head: parent.origin.head,
    resolvedRuntimeVersion: parent.worker.resolvedRuntimeVersion,
    promptFile: "runtime/prompt.txt",
    acceptance: [
      `Repair the concrete independent-verifier findings for parent ${parent.jobId}.`,
      "Stay inside the parent workspace and authority boundary; do not broaden scope.",
      "Return repository-native command and test evidence for the repair."
    ],
    pluginDirs: parent.worker.pluginDirs,
    mcpConfigs: parent.worker.mcpConfigPaths,
    addDirs: parent.worker.addDirs,
    settingSources: parent.worker.settingSources
  });
}

function repairPrompt(parentJobId, failedAttempt) {
  const evidence = JSON.stringify(failedAttempt);
  return [
    `This is bounded repair attempt 1 for parent bridge job ${parentJobId}.`,
    "The parent Codex verifier failed. Fix only the concrete findings below in the existing workspace.",
    "Do not revert pre-existing user changes. Re-run relevant repository-native checks and report exact evidence.",
    "Independent failed-attempt evidence:",
    evidence
  ].join("\n").slice(0, 64 * 1024);
}

function assertCorrelation(value, parentRequest) {
  const parentRequestHash = crypto.createHash("sha256")
    .update(JSON.stringify(parentRequest))
    .digest("hex");
  if (!value || value.schemaVersion !== 1 || value.parentJobId !== parentRequest.jobId || value.attempt !== 1 ||
      !JOB_PATTERN.test(value.childJobId ?? "") ||
      value.workspace !== parentRequest.execution.canonicalWorkspacePath ||
      value.parentRequestHash !== parentRequestHash ||
      value.authorityBoundary !== "child-job-bound-capability; parent broker authority not delegated" ||
      value.failedAttempt?.attempt !== 0 || value.failedAttempt?.passed !== false ||
      value.childRequest?.jobId !== value.childJobId ||
      value.childRequest?.execution?.canonicalWorkspacePath !== value.workspace ||
      !CAPABILITY_PATTERN.test(value.capabilityToken ?? "") ||
      crypto.createHash("sha256").update(value.capabilityToken ?? "").digest("hex") !== value.capabilityHash) {
    throw new Error(`invalid durable repair correlation for ${parentRequest.jobId}`);
  }
  return value;
}

function assertProgress(value, correlation, parentJobId) {
  const brokerPidValid = value?.brokerPid == null || (Number.isInteger(value.brokerPid) && value.brokerPid > 0);
  const reservationValid = value?.phase !== "spawn-reserved" ||
    (UUID_PATTERN.test(value.launchReservation ?? "") && Number.isFinite(Date.parse(value.reservedAt ?? "")));
  const dispatchedValid = value?.phase !== "dispatched" || (Number.isInteger(value.brokerPid) && value.brokerPid > 0);
  const terminalValid = value?.phase !== "terminal" ||
    (TERMINAL.has(value.childStatus) && Number.isFinite(Date.parse(value.childTerminalAt ?? "")));
  if (!value || value.schemaVersion !== 1 || value.parentJobId !== parentJobId ||
      value.childJobId !== correlation.childJobId || value.attempt !== 1 ||
      !PROGRESS_PHASES.has(value.phase) || !brokerPidValid || !reservationValid ||
      !dispatchedValid || !terminalValid) {
    throw new Error(`invalid durable repair progress for ${parentJobId}`);
  }
  return value;
}

/**
 * Create the production-only bounded repair lifecycle. A repair is a distinct
 * internal bridge job with its own job-bound capability and tmux/Claude worker.
 * The parent is the sole verification and delivery authority.
 */
export function createProductionBridgeRepairLifecycle(options = {}) {
  const parentSpec = options.parentSpec;
  const stateApi = options.stateApi ?? defaultStateApi;
  const buildRequest = options.buildRequest ?? buildBridgeRequest;
  const buildPrompt = options.buildPrompt ?? buildBridgeWorkerPrompt;
  const persistBrokerSpec = options.persistBrokerSpec;
  const spawn = options.spawnDetached ?? spawnDetached;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const alive = options.processAlive ?? processAlive;
  const discoverBroker = options.discoverBrokerPid ?? discoverBrokerProcess;
  const afterPreparePersist = options.afterPreparePersist ?? (() => {});
  const afterBrokerSpawn = options.afterBrokerSpawn ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const spawnReservationGraceMs = options.spawnReservationGraceMs ?? DEFAULT_SPAWN_RESERVATION_GRACE_MS;
  const onProgress = options.onProgress ?? (() => {});
  const brokerScript = options.brokerScript ?? BROKER_SCRIPT;
  if (!parentSpec || parentSpec.maxRepairs !== 1 || parentSpec.internalRepair) {
    throw new Error("production repair lifecycle requires a maxRepairs=1 parent broker spec");
  }
  if (typeof persistBrokerSpec !== "function") {
    throw new Error("production repair lifecycle requires durable broker-spec persistence");
  }
  const stateOptions = Object.freeze({ stateRoot: parentSpec.stateRoot });
  const parentRequest = stateApi.readBridgeRequest(parentSpec.jobId, stateOptions);
  const runtimeDir = path.join(parentSpec.jobDir, "runtime");
  const correlationFile = path.join(runtimeDir, "repair-attempt-1.json");
  const progressFile = path.join(runtimeDir, "repair-attempt-1-state.json");

  function readCorrelation() {
    if (!fs.existsSync(correlationFile)) return null;
    const correlation = assertCorrelation(readJson(correlationFile), parentRequest);
    if (!fs.existsSync(progressFile)) return correlation;
    const progress = assertProgress(readJson(progressFile), correlation, parentSpec.jobId);
    return { ...correlation, ...progress };
  }

  function writeProgress(correlation, updates) {
    writeJsonAtomic(progressFile, {
      schemaVersion: 1,
      parentJobId: correlation.parentJobId,
      childJobId: correlation.childJobId,
      attempt: 1,
      phase: updates.phase,
      ...(updates.brokerPid ? { brokerPid: updates.brokerPid } : {}),
      ...(updates.launchReservation ? { launchReservation: updates.launchReservation } : {}),
      ...(updates.reservedAt ? { reservedAt: updates.reservedAt } : {}),
      ...(updates.childStatus ? { childStatus: updates.childStatus } : {}),
      ...(updates.childTerminalAt ? { childTerminalAt: updates.childTerminalAt } : {})
    });
    return { ...correlation, ...updates };
  }

  function capabilityFor(correlation) {
    const token = correlation.capabilityToken;
    if (!CAPABILITY_PATTERN.test(token ?? "") ||
        crypto.createHash("sha256").update(token ?? "").digest("hex") !== correlation.capabilityHash) {
      throw new Error("durable repair capability does not match correlation evidence");
    }
    return token;
  }

  function createCorrelation(failedAttempt) {
    const childRequest = buildChildRequest(parentRequest, buildRequest);
    const capabilityToken = crypto.randomBytes(32).toString("base64url");
    const correlation = {
      schemaVersion: 1,
      parentJobId: parentSpec.jobId,
      childJobId: childRequest.jobId,
      attempt: 1,
      workspace: parentRequest.execution.canonicalWorkspacePath,
      parentRequestHash: crypto.createHash("sha256").update(JSON.stringify(parentRequest)).digest("hex"),
      capabilityToken,
      capabilityHash: crypto.createHash("sha256").update(capabilityToken).digest("hex"),
      authorityBoundary: "child-job-bound-capability; parent broker authority not delegated",
      failedAttempt: safeFailedAttempt(failedAttempt, stateApi),
      childRequest
    };
    writeJsonExclusive(correlationFile, correlation);
    afterPreparePersist({ correlationFile, childJobId: correlation.childJobId });
    return writeProgress(correlation, { phase: "prepared" });
  }

  function ensureChild(correlation) {
    const childJobDir = stateApi.resolveBridgeJobDir(correlation.childJobId, stateOptions);
    const childSpecFile = path.join(childJobDir, "broker-spec.json");
    const childHeartbeat = path.join(childJobDir, "broker-heartbeat.json");
    const childLog = path.join(childJobDir, "broker.log");
    const capabilityToken = capabilityFor(correlation);
    const childExists = fs.existsSync(childJobDir);
    if (!childExists) {
      stateApi.createBridgeJob(correlation.childRequest, { ...stateOptions, capabilityToken });
    } else if (JSON.stringify(stateApi.readBridgeRequest(correlation.childJobId, stateOptions)) !== JSON.stringify(correlation.childRequest)) {
      throw new Error("durable repair child request conflicts with parent correlation");
    }
    if (!fs.existsSync(childSpecFile)) {
      persistBrokerSpec(childSpecFile, {
        schemaVersion: 1,
        jobId: correlation.childJobId,
        stateRoot: parentSpec.stateRoot,
        jobDir: childJobDir,
        prompt: buildPrompt({
          request: correlation.childRequest,
          userPrompt: repairPrompt(parentSpec.jobId, correlation.failedAttempt)
        }),
        workerCapabilityToken: capabilityToken,
        tmuxBinary: parentSpec.tmuxBinary,
        claudeBinary: parentSpec.claudeBinary,
        codexBinary: parentSpec.codexBinary,
        nodeBinary: parentSpec.nodeBinary,
        envBinary: parentSpec.envBinary,
        heartbeatFile: childHeartbeat,
        intervalMs: parentSpec.intervalMs,
        maxRepairs: 0,
        verificationCommands: parentSpec.verificationCommands,
        securityRequirements: parentSpec.securityRequirements ?? {},
        internalRepair: { parentJobId: parentSpec.jobId, attempt: 1 }
      });
    }
    const childState = stateApi.getBridgeJob(correlation.childJobId, stateOptions);
    if (TERMINAL.has(childState.status)) {
      const childResult = stateApi.readBridgeResult(correlation.childJobId, stateOptions);
      if (!childResult) {
        throw new Error(`terminal repair child ${correlation.childJobId} is missing its durable result`);
      }
      return writeProgress(correlation, {
        phase: "terminal",
        childStatus: childState.status,
        childTerminalAt: childState.terminalAt
      });
    }
    let brokerPid = correlation.brokerPid;
    const discoveredPid = discoverBroker(parentSpec.nodeBinary, brokerScript, childSpecFile);
    if (alive(discoveredPid)) {
      // Process discovery proves both liveness and the complete expected argv.
      // A heartbeat or persisted PID is never authoritative on kill(0) alone:
      // it may be stale, corrupted, or reused by an unrelated process.
      brokerPid = discoveredPid;
    } else {
      let reservedNow = false;
      if (correlation.phase !== "spawn-reserved") {
        correlation = writeProgress(correlation, {
          phase: "spawn-reserved",
          launchReservation: crypto.randomUUID(),
          reservedAt: new Date(now()).toISOString()
        });
        reservedNow = true;
      }
      const reservedAt = Date.parse(correlation.reservedAt ?? "");
      if (!reservedNow && Number.isFinite(reservedAt) && now() - reservedAt < spawnReservationGraceMs) {
        return correlation;
      }
      brokerPid = spawn(parentSpec.nodeBinary, [brokerScript, "--spec", childSpecFile], {
        cwd: childJobDir,
        logFile: childLog,
        env: process.env
      });
      afterBrokerSpawn({ brokerPid, childSpecFile, childJobId: correlation.childJobId });
    }
    return writeProgress(correlation, { phase: "dispatched", brokerPid });
  }

  async function awaitRepair(childJobId) {
    let correlation = readCorrelation();
    if (!correlation || correlation.childJobId !== childJobId) {
      throw new Error(`repair child ${childJobId} is not correlated to parent ${parentSpec.jobId}`);
    }
    const deadline = Date.now() + parentRequest.execution.timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      correlation = ensureChild(correlation);
      const childState = stateApi.getBridgeJob(childJobId, stateOptions);
      const result = stateApi.readBridgeResult(childJobId, stateOptions);
      onProgress({
        parentJobId: parentSpec.jobId,
        childJobId,
        attempt: 1,
        phase: childState.status,
        brokerPid: correlation.brokerPid ?? null
      });
      if (TERMINAL.has(childState.status) && result) {
        writeProgress(correlation, {
          phase: "terminal",
          childStatus: childState.status,
          childTerminalAt: childState.terminalAt
        });
        onProgress({
          parentJobId: parentSpec.jobId,
          childJobId,
          attempt: 1,
          phase: "terminal",
          childStatus: childState.status,
          brokerPid: correlation.brokerPid ?? null
        });
        return result;
      }
      await sleep(Math.max(100, Math.min(1_000, parentSpec.intervalMs ?? 500)));
    }
    throw new Error(`timed out awaiting bounded repair child ${childJobId}`);
  }

  return Object.freeze({
    async dispatchRepair({ parentJobId, failedAttempt }) {
      if (parentJobId !== parentSpec.jobId) throw new Error("repair dispatch parent identity mismatch");
      let correlation = readCorrelation() ?? createCorrelation(failedAttempt);
      correlation = ensureChild(correlation);
      onProgress({
        parentJobId: parentSpec.jobId,
        childJobId: correlation.childJobId,
        attempt: 1,
        phase: correlation.phase,
        brokerPid: correlation.brokerPid ?? null
      });
      return Object.freeze({ jobId: correlation.childJobId, attempt: 1 });
    },
    awaitRepair,
    async resumePendingRepair() {
      let correlation = readCorrelation();
      if (!correlation) return null;
      correlation = ensureChild(correlation);
      const outcome = await awaitRepair(correlation.childJobId);
      return Object.freeze({
        repair: { jobId: correlation.childJobId, attempt: 1 },
        failedAttempt: structuredClone(correlation.failedAttempt),
        outcome
      });
    }
  });
}
