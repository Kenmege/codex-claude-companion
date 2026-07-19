import fs from "node:fs";
import path from "node:path";

import * as bridgeState from "./bridge-state.mjs";
import { deliverBridgeResult, drainBridgeInbox } from "./bridge-delivery.mjs";
import { createBridgeCoordinationOperations } from "./bridge-messaging.mjs";
import { superviseBridgeJob } from "./bridge-supervisor.mjs";
import { runBridgeVerification } from "./bridge-verification.mjs";
import { createProductionBridgeVerificationDependencies } from "./bridge-production-verifier.mjs";
import * as tmuxExecutor from "./tmux-executor.mjs";
import { normalizeClaudeWorkerResult } from "./bridge-worker-protocol.mjs";

const REQUIRED_IDENTITY_FIELDS = Object.freeze([
  "executor",
  "tmuxSession",
  "paneId",
  "panePid",
  "workerPid",
  "claudeSessionId"
]);

const PERSISTED_IDENTITY_FIELDS = Object.freeze([
  ...REQUIRED_IDENTITY_FIELDS,
  "origin",
  "recordedAt",
  "requestedPermissionMode",
  "effectivePermissionMode",
  "permissionVerification"
]);

const CURRENT_LEDGER_IDENTITY_FIELDS = REQUIRED_IDENTITY_FIELDS;

const RUNTIME_SECURITY_MODEL = Object.freeze({
  trustedAutonomous: Object.freeze({
    available: true,
    containment: "cooperative-host-trust-only",
    brokerAuthorityIsolation: false
  }),
  sandboxAutonomous: Object.freeze({
    available: false,
    containment: "requires-verified-separate-uid-or-os-sandbox",
    brokerAuthorityIsolation: false
  })
});

function hasFunctions(value, names) {
  return names.every((name) => typeof value?.[name] === "function");
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function missingCapability(code, detail) {
  return Object.freeze({ code, detail });
}

export function inspectBridgeRuntimeCompatibility(options = {}) {
  const stateApi = options.stateApi ?? bridgeState;
  const executorApi = options.executorApi ?? tmuxExecutor;
  const coordination = options.coordination ?? createBridgeCoordinationOperations({
    ...(options.stateOptions ?? {}),
    brokerAuthorityForJob: (jobId) => stateApi.getBridgeBrokerAuthority(jobId, options.stateOptions ?? {})
  });
  const processInspector = options.processInspector ?? executorApi.inspectProcess;
  const normalizeResult = options.normalizeResult ?? normalizeClaudeWorkerResult;
  const identityFields = new Set(options.identityFields ?? CURRENT_LEDGER_IDENTITY_FIELDS);
  const missing = [];

  if (options.maxRepairs === 1 && !hasFunctions(options.repairLifecycle, [
    "dispatchRepair", "awaitRepair", "resumePendingRepair"
  ])) {
    missing.push(missingCapability(
      "bounded-production-repair",
      "maxRepairs=1 requires durable dispatch, await, and crash-resume repair operations"
    ));
  }

  if (!options.verificationDependencies && typeof options.codexBinary !== "string") {
    missing.push(missingCapability(
      "independent-codex-verifier",
      "an absolute Codex executable or explicit production verification dependencies are required"
    ));
  }

  if (!hasFunctions(stateApi, [
    "getBridgeBrokerAuthority",
    "getBridgeJob",
    "readBridgeRequest",
    "readBridgeResult",
    "recordDispatch",
    "transitionBridgeJob",
    "writeBridgeResult"
  ])) {
    missing.push(missingCapability(
      "broker-state-primitives",
      "authoritative broker state, dispatch, lifecycle, and result operations are required"
    ));
  }

  if (!hasFunctions(coordination, ["claimSupervisor", "releaseSupervisor"])) {
    missing.push(missingCapability(
      "durable-supervisor-lease",
      "broker-owned claimSupervisor and releaseSupervisor operations are required"
    ));
  }
  if (!hasFunctions(coordination, ["markStarting", "clearStartingReservation", "readStartingReservation"])) {
    missing.push(missingCapability(
      "durable-starting-reservation",
      "a crash-recoverable starting reservation must bracket launch and dispatch recording"
    ));
  }
  if (!hasFunctions(coordination, ["claimCancellation", "confirmCancellation", "readCancellationClaim"])) {
    missing.push(missingCapability(
      "durable-cancellation-claim",
      "cancellation observation requires broker-owned claim and confirmation state"
    ));
  }
  if (!hasFunctions(coordination, [
    "claimDelivery",
    "acknowledgeDelivery",
    "failDeliveryToInbox",
    "readDelivery",
    "readReceipt"
  ])) {
    missing.push(missingCapability(
      "durable-delivery-state",
      "delivery deduplication, acknowledgement, receipt, and fallback inbox state are required"
    ));
  }
  if (!hasFunctions(coordination, [
    "recordVerification",
    "claimInbox",
    "acknowledgeInboxDelivery",
    "failInboxDelivery"
  ])) {
    missing.push(missingCapability(
      "durable-verification-and-inbox",
      "verification finalization and fallback inbox draining require broker-owned durable operations"
    ));
  }
  if (typeof executorApi?.discover !== "function") {
    missing.push(missingCapability(
      "worker-discovery",
      "the executor must discover workers after a crash between launch and dispatch persistence"
    ));
  }
  if (typeof processInspector !== "function") {
    missing.push(missingCapability(
      "attributing-process-inspector",
      "a process inspector must classify concrete identities as live, dead, missing, or stale"
    ));
  }
  if (typeof normalizeResult !== "function") {
    missing.push(missingCapability(
      "worker-result-normalizer",
      "terminal worker evidence requires a supervisor-compatible result normalizer"
    ));
  }
  if (!REQUIRED_IDENTITY_FIELDS.every((field) => identityFields.has(field))) {
    missing.push(missingCapability(
      "concrete-pane-identity",
      `durable dispatch identity must include ${REQUIRED_IDENTITY_FIELDS.join(", ")}`
    ));
  }

  const statePrimitivesPresent = hasFunctions(stateApi, [
    "getBridgeBrokerAuthority",
    "getBridgeJob",
    "readBridgeRequest",
    "readBridgeResult",
    "recordDispatch",
    "transitionBridgeJob",
    "writeBridgeResult"
  ]);
  const launchPresent = typeof executorApi?.launchTmuxClaudeWorker === "function";
  if (!launchPresent) {
    missing.push(missingCapability(
      "worker-launch",
      "a tmux worker launch operation is required"
    ));
  }
  const ready = missing.length === 0 && statePrimitivesPresent && launchPresent;

  return Object.freeze({
    ready,
    missing: Object.freeze(missing),
    securityModel: RUNTIME_SECURITY_MODEL,
    guarantees: Object.freeze({
      recordDispatchBeforeRunning: typeof stateApi?.recordDispatch === "function",
      safeUntrackedLaunchRecovery: ready &&
        typeof executorApi.discover === "function" &&
        typeof processInspector === "function"
    }),
    prerequisites: Object.freeze({
      brokerState: statePrimitivesPresent,
      executorLaunch: launchPresent
    })
  });
}

function deriveCancellation(ledger, claim) {
  if (claim != null) return clone(claim);
  if (ledger.status === "cancelled") return Object.freeze({ state: "confirmed" });
  if (ledger.cancelRequestedAt) {
    return Object.freeze({ state: "requested", requestedAt: ledger.cancelRequestedAt });
  }
  return Object.freeze({ state: "none" });
}

export async function adaptBridgeLedgerSnapshot(jobId, options = {}) {
  const stateApi = options.stateApi ?? bridgeState;
  const coordination = options.coordination;
  const stateOptions = options.stateOptions ?? {};
  const ledger = await stateApi.getBridgeJob(jobId, stateOptions);
  if (!ledger || ledger.jobId !== jobId || typeof ledger.status !== "string") {
    throw new Error("bridge ledger returned an invalid job snapshot");
  }

  const [request, result, reservation, cancellationClaim, delivery, receipt] = await Promise.all([
    stateApi.readBridgeRequest(jobId, stateOptions),
    stateApi.readBridgeResult(jobId, stateOptions),
    coordination?.readStartingReservation?.(jobId),
    coordination?.readCancellationClaim?.(jobId),
    coordination?.readDelivery?.(jobId),
    coordination?.readReceipt?.(jobId)
  ]);
  const phase = ledger.status === "accepted" && reservation != null ? "starting" : ledger.status;

  return Object.freeze({
    jobId,
    phase,
    prompt: options.prompt,
    request: clone(request),
    origin: clone(request?.origin ?? null),
    result: clone(result),
    dispatch: clone(ledger.dispatch ?? null),
    cancellation: deriveCancellation(ledger, cancellationClaim),
    delivery: clone(delivery),
    receipt: clone(receipt)
  });
}

function assertRunInput(input) {
  if (!input || typeof input.jobId !== "string" || input.jobId.length === 0) {
    throw new Error("bridge runtime requires jobId");
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new Error("bridge runtime requires the caller-supplied durable prompt");
  }
}

function securityBoundaryReceipt(jobId, request, input) {
  const profile = request?.execution?.profile;
  if (profile === "sandbox-autonomous") {
    return Object.freeze({
      jobId,
      action: "blocked",
      classification: "security-boundary-unavailable",
      safeToLaunch: false,
      trustProfile: profile,
      reason: "sandbox-autonomous requires verified separate-UID or OS-sandbox containment"
    });
  }
  if (profile === "trusted-autonomous" &&
      input.securityRequirements?.brokerAuthorityIsolation === true) {
    return Object.freeze({
      jobId,
      action: "blocked",
      classification: "security-boundary-unavailable",
      safeToLaunch: false,
      trustProfile: profile,
      reason: "trusted-autonomous is cooperative-host trust and cannot isolate broker authority from a same-UID unrestricted worker"
    });
  }
  return null;
}

function cancellationTransport(identity, jobId, jobDir, executorOptions) {
  if (typeof jobDir !== "string" || !path.isAbsolute(jobDir)) {
    throw new Error("worker cancellation requires an absolute bridge job directory");
  }
  const runtimeDir = path.join(jobDir, "runtime");
  return Object.freeze({
    ...clone(identity),
    jobId,
    artifacts: Object.freeze({
      identityFile: path.join(runtimeDir, "identity.json"),
      cancelFile: path.join(runtimeDir, "cancel.json"),
      exitFile: path.join(runtimeDir, "exit.json")
    }),
    tmuxSocketName: executorOptions.tmuxSocketName ?? null
  });
}

function readBoundedPrivateFile(file, label, maximumBytes = 16 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error(`${label} is not a bounded private regular file`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readPrivateWorkspaceSnapshot(file) {
  const value = JSON.parse(readBoundedPrivateFile(file, "verification baseline"));
  if (!value || !Array.isArray(value.entries)) throw new Error("verification baseline is invalid");
  return value;
}

function writePrivateWorkspaceSnapshot(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

function writePrivateImmutableJson(file, value) {
  const normalized = bridgeState.redactBridgeValue(value);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readBoundedPrivateFile(file, "immutable verification attempt evidence") !== serialized) {
      throw new Error("immutable verification attempt evidence conflicts with existing artifact");
    }
  }
  return normalized;
}

function readPrivateVerificationAttempts(file, jobId) {
  const value = JSON.parse(readBoundedPrivateFile(file, "verification attempt evidence"));
  if (!value || value.schemaVersion !== 1 || value.jobId !== jobId ||
      !["passed", "failed"].includes(value.verification?.state) ||
      !Array.isArray(value.verification.evidence) || value.verification.evidence.length === 0 ||
      !value.verification.evidence.every((item) => typeof item === "string" && item.trim().length > 0) ||
      !Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 2 ||
      !value.attempts.every((attempt, index) => attempt?.attempt === index && typeof attempt.passed === "boolean") ||
      value.result?.jobId !== jobId || value.result?.status !== "completed") {
    throw new Error("verification attempt evidence is invalid");
  }
  return value;
}

export function createBridgeRuntime(options = {}) {
  const stateApi = options.stateApi ?? bridgeState;
  const executorApi = options.executorApi ?? tmuxExecutor;
  const coordination = options.coordination ?? createBridgeCoordinationOperations({
    ...(options.stateOptions ?? {}),
    brokerAuthorityForJob: (jobId) => stateApi.getBridgeBrokerAuthority(jobId, options.stateOptions ?? {})
  });
  const supervisorFn = options.supervisorFn ?? superviseBridgeJob;
  const deliveryFn = options.deliveryFn ?? deliverBridgeResult;
  const verificationFn = options.verificationFn ?? runBridgeVerification;
  const compatibility = inspectBridgeRuntimeCompatibility({
    stateApi,
    coordination,
    executorApi,
    identityFields: options.identityFields,
    processInspector: options.processInspector,
    normalizeResult: options.normalizeResult,
    stateOptions: options.stateOptions,
    verificationDependencies: options.verificationDependencies,
    codexBinary: options.codexBinary,
    maxRepairs: options.maxRepairs,
    repairLifecycle: options.repairLifecycle
  });

  return Object.freeze({
    compatibility,
    async run(input) {
      if (!compatibility.ready) {
        return Object.freeze({
          jobId: input?.jobId ?? null,
          action: "blocked",
          classification: "incompatible-runtime",
          safeToLaunch: false,
          missing: compatibility.missing
        });
      }
      assertRunInput(input);

      const immutableRequest = await stateApi.readBridgeRequest(input.jobId, options.stateOptions ?? {});
      const securityBlock = securityBoundaryReceipt(input.jobId, immutableRequest, input);
      if (securityBlock) return securityBlock;

      const brokerAuthority = await stateApi.getBridgeBrokerAuthority(input.jobId, options.stateOptions ?? {});
      const stateOptions = Object.freeze({ ...(options.stateOptions ?? {}), brokerAuthority });
      const jobDir = input.executorOptions?.jobDir ?? options.executorOptions?.jobDir ??
        stateApi.resolveBridgeJobDir?.(input.jobId, stateOptions);
      const executorOptions = Object.freeze({
        ...(options.executorOptions ?? {}),
        ...(input.executorOptions ?? {}),
        ...(jobDir ? { jobDir } : {})
      });
      const durableJobDir = stateApi.resolveBridgeJobDir?.(input.jobId, stateOptions) ?? null;
      const baseVerificationDependencies = options.verificationDependencies ?? createProductionBridgeVerificationDependencies({
        codexBinary: options.codexBinary,
        verificationCommands: options.verificationCommands,
        verifierTimeoutMs: Math.min(3_600_000, Math.max(
          30_000,
          immutableRequest.execution.timeoutSeconds * 1_000
        )),
        ...(options.verifierHeartbeatMs == null
          ? {}
          : { verifierHeartbeatMs: options.verifierHeartbeatMs }),
        ...(typeof options.onVerificationProgress === "function"
          ? {
              onVerifierHeartbeat: ({ attempt }) => options.onVerificationProgress(Object.freeze({
                jobId: input.jobId,
                stage: "codex-review",
                attempt,
                pulse: true
              }))
            }
          : {}),
        recordVerification: (jobId, verification) => coordination.recordVerification(jobId, verification),
        recordVerificationAttempts: (jobId, evidence) => {
          if (!durableJobDir) throw new Error(`Cannot persist verification attempts without a durable job directory for ${jobId}`);
          return writePrivateImmutableJson(path.join(durableJobDir, "runtime", "verification-attempts.json"), evidence);
        },
        ...(options.repairLifecycle
          ? {
              dispatchRepair: (repairInput) => options.repairLifecycle.dispatchRepair(repairInput),
              awaitRepair: (repairJobId) => options.repairLifecycle.awaitRepair(repairJobId)
            }
          : {})
      });
      const verificationDependencies = typeof options.onVerificationProgress === "function"
        ? Object.freeze({
            ...baseVerificationDependencies,
            onProgress: (progress) => options.onVerificationProgress(Object.freeze({
              jobId: input.jobId,
              ...clone(progress)
            }))
          })
        : baseVerificationDependencies;
      const baselineFile = durableJobDir ? path.join(durableJobDir, "runtime", "verification-before.json") : null;
      let beforeWorkspace = input.beforeWorkspace ?? null;
      let activeLeaseToken = null;
      const snapshot = (overrides = {}) => adaptBridgeLedgerSnapshot(input.jobId, {
        prompt: input.prompt,
        stateApi,
        stateOptions,
        coordination,
        ...overrides
      });

      const stateOperations = {
        async claimSupervisor(jobId, claimOptions) {
          const claim = await coordination.claimSupervisor(jobId, claimOptions);
          if (!claim?.acquired) return { ...claim, snapshot: await snapshot() };
          return { ...claim, snapshot: await snapshot() };
        },
        releaseSupervisor(jobId, leaseToken) {
          return coordination.releaseSupervisor(jobId, leaseToken);
        },
        async markStarting(jobId, leaseToken) {
          await coordination.markStarting(jobId, leaseToken);
          activeLeaseToken = leaseToken;
          const updated = await snapshot();
          return Object.freeze({ ...updated, phase: "starting" });
        },
        async recordDispatch(jobId, leaseTokenOrIdentity, suppliedIdentity) {
          // tmux-executor records before returning; the supervisor records the
          // same identity again. Support both call shapes without weakening the
          // broker-owned lease used to clear the launch reservation.
          const identity = suppliedIdentity ?? leaseTokenOrIdentity;
          const leaseToken = suppliedIdentity === undefined ? activeLeaseToken : leaseTokenOrIdentity;
          if (typeof leaseToken !== "string" || leaseToken.length === 0) {
            throw new Error("dispatch recording requires the active supervisor lease");
          }
          await stateApi.recordDispatch(jobId, clone(identity), stateOptions);
          await coordination.clearStartingReservation(jobId, leaseToken);
          return snapshot();
        },
        async recordWorkerTerminal(jobId, leaseToken, terminal) {
          await stateApi.transitionBridgeJob(
            jobId,
            terminal.status,
            { ...clone(terminal), supervisorLeaseToken: leaseToken },
            stateOptions
          );
          return snapshot();
        },
        async persistResult(jobId, leaseToken, result) {
          await stateApi.writeBridgeResult(jobId, clone(result), stateOptions);
          return snapshot();
        },
        claimCancellation(jobId, leaseToken) {
          return coordination.claimCancellation(jobId, leaseToken);
        },
        async confirmCancellation(jobId, leaseToken, claimId, confirmation) {
          await stateApi.transitionBridgeJob(
            jobId,
            "cancelled",
            { ...clone(confirmation), supervisorLeaseToken: leaseToken },
            stateOptions
          );
          await coordination.confirmCancellation(jobId, leaseToken, claimId, clone(confirmation));
          return snapshot();
        },
        claimDelivery(jobId, deliveryOptions) {
          return coordination.claimDelivery(jobId, deliveryOptions);
        },
        acknowledgeDelivery(jobId, claimId, acknowledgement) {
          return coordination.acknowledgeDelivery(jobId, claimId, acknowledgement);
        },
        failDeliveryToInbox(jobId, claimId, item) {
          return coordination.failDeliveryToInbox(jobId, claimId, item);
        }
      };

      const initialSnapshot = await snapshot();
      if (options.internalRepair && initialSnapshot.result &&
          ["completed", "failed", "cancelled"].includes(initialSnapshot.result.status)) {
        return Object.freeze({
          jobId: input.jobId,
          action: "repair-terminal",
          classification: initialSnapshot.result.status,
          result: clone(initialSnapshot.result)
        });
      }
      if (!options.internalRepair && !beforeWorkspace && baselineFile && fs.existsSync(baselineFile)) {
        beforeWorkspace = readPrivateWorkspaceSnapshot(baselineFile);
      }
      if (!options.internalRepair && !beforeWorkspace && initialSnapshot.phase === "accepted") {
        beforeWorkspace = await verificationDependencies.captureWorkspace(
          immutableRequest.execution.canonicalWorkspacePath
        );
        if (baselineFile) writePrivateWorkspaceSnapshot(baselineFile, beforeWorkspace);
      }

      if (!options.internalRepair) {
        await (options.inboxDrainFn ?? drainBridgeInbox)({
          origin: immutableRequest.origin,
          stateOperations: coordination,
          waiter: input.waiter ?? options.waiter,
          originAdapter: input.originAdapter ?? options.originAdapter
        });
      }

      const executor = {
        async launch(launchOptions) {
          const launched = await executorApi.launchTmuxClaudeWorker({
            ...executorOptions,
            ...launchOptions,
            stateOperations
          });
          return Object.freeze(Object.fromEntries(
            PERSISTED_IDENTITY_FIELDS
              .filter((field) => launched?.[field] !== undefined)
              .map((field) => [field, clone(launched[field])])
          ));
        },
        discover(jobId, currentSnapshot) {
          return executorApi.discover(jobId, currentSnapshot, {
            ...executorOptions
          });
        },
        cancel(identity, reason) {
          const cancel = executorApi.cancel ?? executorApi.cancelTmuxClaudeWorker;
          return cancel(cancellationTransport(
            identity,
            input.jobId,
            jobDir,
            executorOptions
          ), reason, {
            ...executorOptions,
            // The supervisor already owns durable intent and confirmation.
            // The legacy tmux executor hooks therefore acknowledge those two
            // steps without attempting a second lifecycle transition.
            stateOperations: {
              requestCancellation: async () => snapshot(),
              confirmCancellation: async () => snapshot()
            }
          });
        }
      };

      const supervised = await supervisorFn({
        jobId: input.jobId,
        ownerId: input.ownerId ?? options.ownerId,
        leaseMs: input.leaseMs ?? options.leaseMs,
        stateOperations,
        executor,
        inspectProcess: options.processInspector ?? ((identity) => executorApi.inspectProcess(identity, {
          ...executorOptions,
          jobId: input.jobId
        })),
        normalizeResult: options.normalizeResult ?? ((exit, context) => {
          if (typeof jobDir !== "string") throw new Error("worker result normalization requires jobDir");
          const stdoutFile = path.join(jobDir, "runtime", "stdout.jsonl");
          return normalizeClaudeWorkerResult({
            request: context.request,
            stdout: readBoundedPrivateFile(stdoutFile, "worker stdout artifact"),
            exit,
            artifactPaths: input.artifactPaths ?? options.artifactPaths ?? []
          });
        }),
        delivery: options.internalRepair
          ? async () => Object.freeze({ state: "suppressed-internal-repair" })
          : (deliveryOptions) => deliveryFn({
              ...deliveryOptions,
              stateOperations,
              waiter: input.waiter ?? options.waiter,
              originAdapter: input.originAdapter ?? options.originAdapter
            })
      });
      if (options.internalRepair) {
        const internalSnapshot = await snapshot();
        if (internalSnapshot.result && ["completed", "failed", "cancelled"].includes(internalSnapshot.result.status)) {
          return Object.freeze({
            jobId: input.jobId,
            action: "repair-terminal",
            classification: internalSnapshot.result.status,
            result: clone(internalSnapshot.result)
          });
        }
        return supervised;
      }
      if (supervised?.action !== "verification-required") return supervised;

      if (!beforeWorkspace) {
        const verification = {
          state: "failed",
          verifiedAt: new Date().toISOString(),
          evidence: ["verification:pre-dispatch workspace snapshot unavailable; failed closed"]
        };
        await coordination.recordVerification(input.jobId, verification);
        return Object.freeze({
          jobId: input.jobId,
          action: "verification",
          classification: "failed",
          verification
        });
      }
      const verificationAttemptsFile = durableJobDir
        ? path.join(durableJobDir, "runtime", "verification-attempts.json")
        : null;
      const pendingSnapshot = await snapshot();
      if (verificationAttemptsFile && fs.existsSync(verificationAttemptsFile) &&
          pendingSnapshot.receipt?.verification?.state === "pending") {
        const recovered = readPrivateVerificationAttempts(verificationAttemptsFile, input.jobId);
        await coordination.recordVerification(input.jobId, recovered.verification);
        return Object.freeze({
          jobId: input.jobId,
          action: "verification",
          classification: recovered.verification.state,
          verification: clone(recovered.verification),
          recovered: true
        });
      }
      const resumeRepair = options.repairLifecycle
        ? await options.repairLifecycle.resumePendingRepair()
        : null;
      const verificationOutcome = await verificationFn({
        request: immutableRequest,
        result: initialSnapshot.result ?? pendingSnapshot.result,
        receipt: pendingSnapshot.receipt,
        beforeWorkspace,
        maxRepairs: input.maxRepairs ?? options.maxRepairs ?? 0,
        ...(resumeRepair ? { resumeRepair } : {})
      }, verificationDependencies);
      return Object.freeze({
        jobId: input.jobId,
        action: "verification",
        classification: verificationOutcome.verification.state,
        verification: clone(verificationOutcome.verification)
      });
    }
  });
}
