import assert from "node:assert/strict";
import test from "node:test";

import {
  createBridgeReceipt,
  updateBridgeDeliveryReceipt,
  updateBridgeVerificationReceipt,
  updateBridgeWorkerReceipt
} from "../scripts/lib/bridge-receipt.mjs";

const JOB_ID = "ccb_01J00000000000000000000000";
const REQUEST = Object.freeze({
  jobId: JOB_ID,
  execution: Object.freeze({
    profile: "standard",
    effectiveClaudePermissionArgs: Object.freeze(["--setting-sources=", "--permission-mode", "default"])
  })
});

test("creates an immutable pending receipt from trusted request policy", () => {
  const receipt = createBridgeReceipt(REQUEST, { now: () => new Date("2026-07-18T12:00:00Z") });
  assert.equal(receipt.workerState, "accepted");
  assert.equal(receipt.delivery.state, "pending");
  assert.equal(receipt.verification.state, "pending");
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.effectiveClaudePermissionArgs));
});

test("updates worker, delivery, and verification without mutating prior receipts", () => {
  const accepted = createBridgeReceipt(REQUEST, { now: () => new Date("2026-07-18T12:00:00Z") });
  const completed = updateBridgeWorkerReceipt(accepted, "completed");
  const delivered = updateBridgeDeliveryReceipt(completed, {
    state: "acknowledged", attempts: 1,
    deliveredAt: "2026-07-18T12:02:00Z", acknowledgedAt: "2026-07-18T12:03:00Z", lastError: null
  });
  const verified = updateBridgeVerificationReceipt(delivered, {
    state: "passed", verifiedAt: "2026-07-18T12:04:00Z", evidence: ["repository:npm test", "codex:review passed"]
  });
  assert.equal(accepted.workerState, "accepted");
  assert.equal(completed.delivery.state, "pending");
  assert.equal(verified.delivery.state, "acknowledged");
  assert.equal(verified.verification.state, "passed");
});

test("fails closed on impossible worker, delivery, or verification transitions", () => {
  const receipt = createBridgeReceipt(REQUEST, { now: () => new Date("2026-07-18T12:00:00Z") });
  assert.throws(() => updateBridgeWorkerReceipt(receipt, "failed"), /workerError/i);
  assert.throws(() => updateBridgeWorkerReceipt(receipt, "completed", "not allowed"), /workerError/i);
  assert.throws(() => updateBridgeDeliveryReceipt(receipt, {
    state: "acknowledged", attempts: 1,
    deliveredAt: "2026-07-18T12:02:00Z", acknowledgedAt: "2026-07-18T12:03:00Z", lastError: null
  }), /receipt/i);
  assert.throws(() => updateBridgeVerificationReceipt(receipt, {
    state: "passed", verifiedAt: "2026-07-18T12:04:00Z", evidence: ["claimed"]
  }), /receipt/i);
});

test("failed worker carries a bounded error and cannot be verified", () => {
  const receipt = createBridgeReceipt(REQUEST, { now: () => new Date("2026-07-18T12:00:00Z") });
  const failed = updateBridgeWorkerReceipt(receipt, "failed", "token=secret-value process failed");
  assert.match(failed.workerError, /\[REDACTED\]/);
  assert.throws(() => updateBridgeVerificationReceipt(failed, {
    state: "failed", verifiedAt: "2026-07-18T12:04:00Z", evidence: ["repository:failed"]
  }), /receipt/i);
});

test("terminal failed and cancelled workers may be durably acknowledged", () => {
  const receipt = createBridgeReceipt(REQUEST, { now: () => new Date("2026-07-18T12:00:00Z") });
  for (const terminal of [
    updateBridgeWorkerReceipt(receipt, "failed", "worker failed"),
    updateBridgeWorkerReceipt(receipt, "cancelled")
  ]) {
    const acknowledged = updateBridgeDeliveryReceipt(terminal, {
      state: "acknowledged", attempts: 1,
      deliveredAt: "2026-07-18T12:02:00Z", acknowledgedAt: "2026-07-18T12:03:00Z", lastError: null
    });
    assert.equal(acknowledged.delivery.state, "acknowledged");
  }
});
