import { validateBridgeResultContract } from "./bridge-contracts.mjs";

const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`bridge supervisor requires ${name}`);
  return value;
}

function assertIdentity(identity) {
  if (!identity || identity.executor !== "tmux" || typeof identity.tmuxSession !== "string" ||
      identity.tmuxSession.length === 0 || typeof identity.paneId !== "string" || identity.paneId.length === 0 ||
      !Number.isInteger(identity.panePid) || identity.panePid <= 0 ||
      !Number.isInteger(identity.workerPid) || identity.workerPid <= 0 ||
      typeof identity.claudeSessionId !== "string" || identity.claudeSessionId.length === 0) {
    throw new Error("executor returned an incomplete concrete worker identity");
  }
}

function receipt(jobId, action, snapshot, extra = {}) {
  return Object.freeze({
    jobId,
    action,
    phase: snapshot?.phase ?? "unknown",
    ...extra
  });
}

function ambiguous(jobId, snapshot, reason, extra = {}) {
  return receipt(jobId, "recovery-required", snapshot, {
    classification: "ambiguous",
    reason,
    safeToRelaunch: false,
    ...extra
  });
}

function assertInspection(inspection) {
  if (!inspection || !["live", "dead", "missing", "stale"].includes(inspection.classification)) {
    throw new Error("process inspector returned an invalid classification");
  }
}

async function deliverPersisted(options, snapshot) {
  if (!snapshot.result || snapshot.delivery?.state === "acknowledged") {
    return receipt(options.jobId, "terminal", snapshot, {
      classification: "settled",
      delivered: snapshot.delivery?.state === "acknowledged"
    });
  }
  if (snapshot.result.status === "completed" && snapshot.receipt?.verification?.state === "pending") {
    return receipt(options.jobId, "verification-required", snapshot, {
      classification: "pending",
      delivered: false,
      reason: "successful delivery is gated on a final durable verification receipt"
    });
  }
  const outcome = await options.delivery({
    jobId: options.jobId,
    result: structuredClone(snapshot.result),
    receipt: structuredClone(snapshot.receipt),
    origin: structuredClone(snapshot.origin),
    stateOperations: options.stateOperations
  });
  return receipt(options.jobId, "delivery", snapshot, {
    classification: outcome?.state ?? "unknown",
    delivery: outcome ?? null
  });
}

async function observeCancellation(options, snapshot, leaseToken) {
  if (!["requested", "claimed"].includes(snapshot.cancellation?.state)) return null;
  const claimCancellation = requireFunction(options.stateOperations.claimCancellation, "stateOperations.claimCancellation");
  const claim = await claimCancellation(options.jobId, leaseToken);
  if (!claim?.accepted) {
    return receipt(options.jobId, "cancellation-observed", snapshot, { classification: "already-claimed" });
  }
  if (snapshot.dispatch) {
    requireFunction(options.executor.cancel, "executor.cancel");
    await options.executor.cancel(structuredClone(snapshot.dispatch), claim.reason ?? snapshot.cancellation.reason ?? "cancel requested");
  }
  const confirmCancellation = requireFunction(options.stateOperations.confirmCancellation, "stateOperations.confirmCancellation");
  const updated = await confirmCancellation(options.jobId, leaseToken, claim.claimId, {
    reason: claim.reason ?? snapshot.cancellation.reason ?? "cancel requested",
    identity: snapshot.dispatch ? structuredClone(snapshot.dispatch) : null
  });
  return receipt(options.jobId, "cancelled", updated ?? { ...snapshot, phase: "cancelled" }, {
    classification: "confirmed"
  });
}

async function persistDeadWorker(options, snapshot, leaseToken, inspection) {
  const normalizeResult = requireFunction(options.normalizeResult, "normalizeResult");
  const normalized = await normalizeResult(structuredClone(inspection.exit ?? null), {
    jobId: options.jobId,
    dispatch: structuredClone(snapshot.dispatch),
    request: structuredClone(snapshot.request)
  });
  validateBridgeResultContract(normalized);
  if (normalized.jobId !== options.jobId) throw new Error("normalizer returned a result for the wrong job");
  const recordWorkerTerminal = requireFunction(options.stateOperations.recordWorkerTerminal, "stateOperations.recordWorkerTerminal");
  snapshot = await recordWorkerTerminal(options.jobId, leaseToken, {
    status: normalized.status,
    exitStatus: structuredClone(normalized.exitStatus),
    observedIdentity: structuredClone(snapshot.dispatch)
  });
  const persistResult = requireFunction(options.stateOperations.persistResult, "stateOperations.persistResult");
  snapshot = await persistResult(options.jobId, leaseToken, structuredClone(normalized));
  return deliverPersisted(options, snapshot);
}

async function recoverStarting(options, snapshot, leaseToken) {
  if (typeof options.executor.discover !== "function") {
    return ambiguous(options.jobId, snapshot, "launch may have occurred but no discovery operation is available");
  }
  const candidates = await options.executor.discover(options.jobId, structuredClone(snapshot));
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return ambiguous(options.jobId, snapshot, "no durable dispatch identity and no discoverable worker", { identityClassification: "missing" });
  }
  const inspected = [];
  for (const identity of candidates) {
    try {
      assertIdentity(identity);
    } catch {
      inspected.push({ identity, inspection: { classification: "stale" } });
      continue;
    }
    const inspection = await options.inspectProcess(structuredClone(identity));
    assertInspection(inspection);
    inspected.push({ identity, inspection });
  }
  const attributable = inspected.filter(({ inspection }) => inspection.classification === "live" || inspection.classification === "dead");
  if (attributable.length !== 1 || inspected.length !== 1) {
    return ambiguous(options.jobId, snapshot, "worker discovery was not uniquely attributable", {
      identityClassification: attributable.length === 0 ? "missing" : "multiple",
      candidateCount: inspected.length
    });
  }
  const recovered = attributable[0];
  const recordDispatch = requireFunction(options.stateOperations.recordDispatch, "stateOperations.recordDispatch");
  snapshot = await recordDispatch(options.jobId, leaseToken, structuredClone(recovered.identity));
  if (recovered.inspection.classification === "live") {
    return receipt(options.jobId, "monitoring", snapshot, { classification: "live", recovered: true });
  }
  return persistDeadWorker(options, snapshot, leaseToken, recovered.inspection);
}

export async function superviseBridgeJob(options) {
  if (!options || typeof options.jobId !== "string" || options.jobId.length === 0) {
    throw new Error("bridge supervisor requires jobId");
  }
  requireFunction(options.stateOperations?.claimSupervisor, "stateOperations.claimSupervisor");
  requireFunction(options.stateOperations?.releaseSupervisor, "stateOperations.releaseSupervisor");
  requireFunction(options.inspectProcess, "inspectProcess");
  requireFunction(options.delivery, "delivery");
  const claim = await options.stateOperations.claimSupervisor(options.jobId, {
    ownerId: options.ownerId,
    leaseMs: options.leaseMs
  });
  if (!claim?.acquired) {
    return receipt(options.jobId, "deferred", claim?.snapshot, { classification: "lease-held" });
  }
  if (typeof claim.leaseToken !== "string" || !claim.snapshot || claim.snapshot.jobId !== options.jobId) {
    throw new Error("broker returned an invalid supervisor lease");
  }
  const leaseToken = claim.leaseToken;
  let snapshot = structuredClone(claim.snapshot);
  try {
    const cancellation = await observeCancellation(options, snapshot, leaseToken);
    if (cancellation) return cancellation;

    if (snapshot.result) return deliverPersisted(options, snapshot);
    if (TERMINAL_PHASES.has(snapshot.phase)) {
      if (!snapshot.dispatch) {
        return ambiguous(options.jobId, snapshot, "terminal job has no durable result or attributable worker identity");
      }
      assertIdentity(snapshot.dispatch);
      const terminalInspection = await options.inspectProcess(structuredClone(snapshot.dispatch));
      assertInspection(terminalInspection);
      if (terminalInspection.classification !== "dead") {
        return ambiguous(options.jobId, snapshot, "terminal job result cannot be reconstructed from worker evidence", {
          identityClassification: terminalInspection.classification
        });
      }
      return persistDeadWorker(options, snapshot, leaseToken, terminalInspection);
    }
    if (snapshot.phase === "accepted") {
      const markStarting = requireFunction(options.stateOperations.markStarting, "stateOperations.markStarting");
      snapshot = await markStarting(options.jobId, leaseToken);
      const launch = requireFunction(options.executor?.launch, "executor.launch");
      const identity = await launch({
        jobId: options.jobId,
        request: structuredClone(snapshot.request),
        prompt: snapshot.prompt,
        origin: structuredClone(snapshot.origin)
      });
      assertIdentity(identity);
      const recordDispatch = requireFunction(options.stateOperations.recordDispatch, "stateOperations.recordDispatch");
      snapshot = await recordDispatch(options.jobId, leaseToken, structuredClone(identity));
    } else if (snapshot.phase === "starting" && !snapshot.dispatch) {
      return recoverStarting(options, snapshot, leaseToken);
    }

    if (snapshot.phase !== "running" || !snapshot.dispatch) {
      return ambiguous(options.jobId, snapshot, "unsupported or inconsistent durable supervisor state");
    }
    assertIdentity(snapshot.dispatch);
    const inspection = await options.inspectProcess(structuredClone(snapshot.dispatch));
    assertInspection(inspection);
    if (inspection.classification === "live") {
      return receipt(options.jobId, "monitoring", snapshot, { classification: "live" });
    }
    if (inspection.classification === "stale" || inspection.classification === "missing") {
      return ambiguous(options.jobId, snapshot, "durable worker identity cannot be safely attributed", {
        identityClassification: inspection.classification
      });
    }
    return persistDeadWorker(options, snapshot, leaseToken, inspection);
  } finally {
    await options.stateOperations.releaseSupervisor(options.jobId, leaseToken);
  }
}
