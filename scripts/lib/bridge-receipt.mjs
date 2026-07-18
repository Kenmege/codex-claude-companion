import { validateBridgeReceiptContract } from "./bridge-contracts.mjs";

const WORKER_STATES = new Set(["accepted", "running", "stalled", "completed", "failed", "cancelled"]);

function redactText(value) {
  return String(value ?? "")
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function freezeReceipt(receipt) {
  validateBridgeReceiptContract(receipt);
  Object.freeze(receipt.delivery);
  Object.freeze(receipt.verification.evidence);
  Object.freeze(receipt.verification);
  Object.freeze(receipt.effectiveClaudePermissionArgs);
  return Object.freeze(receipt);
}

function clone(receipt) {
  validateBridgeReceiptContract(receipt);
  return structuredClone(receipt);
}

export function createBridgeReceipt(request, options = {}) {
  if (!request || typeof request !== "object" || typeof request.jobId !== "string") {
    throw new TypeError("Bridge receipt requires a request identity");
  }
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  return freezeReceipt({
    schemaVersion: 1,
    jobId: request.jobId,
    createdAt,
    workerState: "accepted",
    workerError: null,
    delivery: { state: "pending", attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null },
    verification: { state: "pending", verifiedAt: null, evidence: [] },
    profile: request.execution?.profile,
    effectiveClaudePermissionArgs: [...(request.execution?.effectiveClaudePermissionArgs ?? [])]
  });
}

export function updateBridgeWorkerReceipt(receipt, workerState, workerError = null) {
  if (!WORKER_STATES.has(workerState)) throw new Error(`Unknown bridge worker state ${String(workerState)}`);
  if (workerState === "failed" && (typeof workerError !== "string" || workerError.trim() === "")) {
    throw new Error("failed workerState requires workerError");
  }
  if (workerState !== "failed" && workerError !== null) {
    throw new Error("workerError is allowed only for failed workerState");
  }
  const next = clone(receipt);
  next.workerState = workerState;
  next.workerError = workerState === "failed" ? redactText(workerError).slice(0, 2_000) : null;
  return freezeReceipt(next);
}

export function updateBridgeDeliveryReceipt(receipt, delivery) {
  const next = clone(receipt);
  next.delivery = structuredClone(delivery);
  return freezeReceipt(next);
}

export function updateBridgeVerificationReceipt(receipt, verification) {
  const next = clone(receipt);
  next.verification = structuredClone(verification);
  return freezeReceipt(next);
}
