import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createBridgeJob, getBridgeBrokerAuthority, requestBridgeCancellation, transitionBridgeJob } from "../scripts/lib/bridge-state.mjs";
import {
  appendClaudeMessage,
  appendCodexMessage,
  acknowledgeDelivery,
  acknowledgeInboxDelivery,
  claimDelivery,
  claimInbox,
  claimSupervisor,
  clearStartingReservation,
  confirmCancellation,
  createBridgeCoordinationOperations,
  failDeliveryToInbox,
  failInboxDelivery,
  markCodexMessageApplied,
  markStarting,
  readBridgeMessages,
  readCancellationClaim,
  readDelivery,
  readReceipt,
  readStartingReservation,
  recordVerification,
  releaseSupervisor
} from "../scripts/lib/bridge-messaging.mjs";

const JOB_ID = "ccb_00000000000000000000000041";
const SESSION_1 = "00000000-0000-4000-8000-000000000001";
const SESSION_2 = "00000000-0000-4000-8000-000000000002";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-messaging-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const options = { stateRoot: path.join(base, "state") };
  const created = createBridgeJob({
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: { codexThreadId: "thread", codexTurnId: null, cwd: workspace, repoRoot: workspace, branch: null, head: null },
    worker: { provider: "anthropic", model: "opus", agent: "implementer", inlineAgents: null, customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [], settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207" },
    execution: { profile: "standard", executor: "tmux", tmuxSession: "ccb-message-test", workspaceMode: "current", requestedWorkspacePath: workspace, canonicalWorkspacePath: workspace, permittedRoot: workspace, claudeSessionId: SESSION_1, sandboxAttestation: null, timeoutSeconds: 900, effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"] },
    task: { promptFile: "prompt.md", acceptance: ["reply"] }
  }, options);
  return {
    options,
    worker: { ...options, capabilityToken: created.capabilityToken },
    broker: { ...options, brokerAuthority: getBridgeBrokerAuthority(JOB_ID, options) }
  };
}

test("Codex enqueue is broker-only, private, redacted, deduplicated, and visibly pending", () => {
  const { options, worker, broker } = setup();
  const input = { messageId: "codex-1", deduplicationKey: "codex:1", text: "inspect sk-abcdefghijklmnop", inReplyTo: null };
  assert.throws(() => appendCodexMessage(JOB_ID, input, options), /broker authority/i);
  assert.throws(() => appendCodexMessage(JOB_ID, input, worker), /broker authority/i);
  const first = appendCodexMessage(JOB_ID, input, broker);
  const replay = appendCodexMessage(JOB_ID, input, broker);
  assert.equal(first.state, "pending");
  assert.deepEqual(replay, first);
  assert.equal(readBridgeMessages(JOB_ID, options).pending.length, 1);
  const journal = path.join(options.stateRoot, "jobs", JOB_ID, "messages.jsonl");
  const journalFd = fs.openSync(journal, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    assert.equal(fs.fstatSync(journalFd).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(journalFd, "utf8"), /sk-abcdefghijklmnop/);
  } finally {
    fs.closeSync(journalFd);
  }
  assert.throws(() => appendCodexMessage(JOB_ID, { ...input, text: "changed" }, broker), /deduplication conflict/i);
});

test("worker applies then acknowledges a message with a correlated resume boundary", () => {
  const { options, worker, broker } = setup();
  appendCodexMessage(JOB_ID, { messageId: "codex-1", deduplicationKey: "codex:1", text: "continue", inReplyTo: null }, broker);
  const continuation = { kind: "claude-resume", boundaryId: "resume-1", fromClaudeSessionId: SESSION_1, toClaudeSessionId: SESSION_2, ordinal: 1, recordedAt: "2026-07-18T12:00:00.000Z" };
  assert.throws(() => markCodexMessageApplied(JOB_ID, { messageId: "codex-1", deduplicationKey: "apply:1", continuation }, broker), /worker capability/i);
  const applied = markCodexMessageApplied(JOB_ID, { messageId: "codex-1", deduplicationKey: "apply:1", continuation }, worker);
  assert.equal(applied.state, "applied");
  const reply = appendClaudeMessage(JOB_ID, { messageId: "claude-1", deduplicationKey: "reply:1", text: "continued", inReplyTo: "codex-1", continuation }, worker);
  assert.equal(reply.state, "ack");
  const view = readBridgeMessages(JOB_ID, options);
  assert.equal(view.pending.length, 0);
  assert.equal(view.applied.length, 0);
  assert.equal(view.acknowledged[0].state, "ack");
  assert.equal(view.acknowledged[0].reply.messageId, "claude-1");
  assert.equal(view.continuationBoundaries.length, 1);
  assert.equal(view.continuationBoundaries[0].kind, "claude-resume");
});

test("replay is safe and invalid ordering, correlation, continuation, and quotas fail closed", () => {
  const { options, worker, broker } = setup();
  appendCodexMessage(JOB_ID, { messageId: "codex-1", deduplicationKey: "codex:1", text: "continue", inReplyTo: null }, broker);
  assert.throws(() => appendClaudeMessage(JOB_ID, { messageId: "claude-1", deduplicationKey: "reply:early", text: "no", inReplyTo: "codex-1" }, worker), /must be applied/i);
  assert.throws(() => markCodexMessageApplied(JOB_ID, { messageId: "missing", deduplicationKey: "apply:missing" }, worker), /unknown Codex message/i);
  assert.throws(() => appendCodexMessage(JOB_ID, { messageId: "large", deduplicationKey: "large", text: "x".repeat(70 * 1024), inReplyTo: null }, broker), /quota/i);
  assert.throws(() => markCodexMessageApplied(JOB_ID, { messageId: "codex-1", deduplicationKey: "apply:forged", continuation: { kind: "claude-resume", boundaryId: "forged", fromClaudeSessionId: SESSION_2, toClaudeSessionId: SESSION_1, ordinal: 1, recordedAt: "2026-07-18T12:00:00.000Z" } }, worker), /authoritative session/i);
  const applied = markCodexMessageApplied(JOB_ID, { messageId: "codex-1", deduplicationKey: "apply:1" }, worker);
  assert.deepEqual(markCodexMessageApplied(JOB_ID, { messageId: "codex-1", deduplicationKey: "apply:1" }, worker), applied);
  assert.throws(() => markCodexMessageApplied(JOB_ID, { messageId: "codex-1", deduplicationKey: "apply:2", continuation: { kind: "claude-resume" } }, worker), /schema validation/i);
  assert.equal(readBridgeMessages(JOB_ID, options).applied.length, 1);
});

test("stale delivery recovery rotates its claim token and fences the delayed prior claimant", () => {
  const { options, broker } = setup();
  transitionBridgeJob(JOB_ID, "running", {}, broker);
  transitionBridgeJob(JOB_ID, "completed", {}, broker);
  const origin = { codexThreadId: "thread", codexTurnId: null, cwd: path.join(path.dirname(options.stateRoot), "workspace"), repoRoot: path.join(path.dirname(options.stateRoot), "workspace"), branch: null, head: null };
  assert.throws(() => claimDelivery(JOB_ID, { route: "origin", origin }, options), /broker authority/i);
  assert.throws(() => claimDelivery(JOB_ID, { route: "origin", origin: { ...origin, codexThreadId: "wrong" } }, broker), /origin mismatch/i);
  const claim = claimDelivery(JOB_ID, { route: "origin", origin }, {
    ...broker,
    now: () => new Date("2026-07-18T12:00:00.000Z")
  });
  assert.equal(claim.accepted, true);
  assert.equal(claimDelivery(JOB_ID, { route: "origin", origin }, {
    ...broker,
    now: () => new Date("2026-07-18T12:00:01.000Z")
  }).accepted, false);
  const recoveredClaim = claimDelivery(JOB_ID, { route: "origin", origin }, {
    ...broker,
    now: () => new Date("2026-07-18T12:00:31.000Z")
  });
  assert.equal(recoveredClaim.accepted, true);
  assert.equal(recoveredClaim.recovered, true);
  assert.notEqual(recoveredClaim.claimId, claim.claimId);
  assert.equal(readDelivery(JOB_ID, broker).attempts, 2);
  const item = { schemaVersion: 1, jobId: JOB_ID, origin, prompt: "resume", workerCompleted: true, verified: false, failedRoute: "origin", error: "offline", attempt: 0, queuedAt: "2026-07-18T12:00:00.000Z" };
  assert.throws(
    () => acknowledgeDelivery(JOB_ID, claim.claimId, { route: "origin", deliveredAt: "2026-07-18T12:00:31.000Z", acknowledgedAt: "2026-07-18T12:00:31.000Z" }, broker),
    /claim mismatch/i
  );
  assert.throws(() => failDeliveryToInbox(JOB_ID, claim.claimId, item, broker), /claim mismatch/i);
  assert.equal(readDelivery(JOB_ID, broker).state, "claimed");
  failDeliveryToInbox(JOB_ID, recoveredClaim.claimId, item, broker);
  const authorityOptions = { ...options, now: () => new Date("2026-07-18T12:01:00.000Z"), brokerAuthorityForJob: () => getBridgeBrokerAuthority(JOB_ID, options) };
  const inbox = claimInbox(origin, authorityOptions);
  assert.equal(inbox.deliveryClaimId, recoveredClaim.claimId);
  assert.equal(claimInbox(origin, authorityOptions), null);
  const recovered = claimInbox(origin, { ...authorityOptions, now: () => new Date("2026-07-18T12:10:00.000Z") });
  assert.notEqual(recovered.inboxClaimId, inbox.inboxClaimId);
  failInboxDelivery(origin, recovered.inboxClaimId, recovered.deliveryClaimId, { jobId: JOB_ID, error: "busy", attemptedAt: "2026-07-18T12:10:00.000Z" }, { ...broker, now: () => new Date("2026-07-18T12:10:00.000Z") });
  const failedReplay = failInboxDelivery(origin, recovered.inboxClaimId, recovered.deliveryClaimId, { jobId: JOB_ID, error: "busy", attemptedAt: "2026-07-18T12:10:00.000Z" }, { ...broker, now: () => new Date("2026-07-18T12:10:00.000Z") });
  assert.equal(failedReplay.attempts, 3);
  const retry = claimInbox(origin, { ...authorityOptions, now: () => new Date("2026-07-18T12:11:00.000Z") });
  const done = acknowledgeInboxDelivery(origin, retry.inboxClaimId, retry.deliveryClaimId, { jobId: JOB_ID, route: "origin", deliveredAt: "2026-07-18T12:11:00.000Z", acknowledgedAt: "2026-07-18T12:11:00.000Z" }, broker);
  assert.equal(done.state, "acknowledged");
  assert.equal(acknowledgeInboxDelivery(origin, retry.inboxClaimId, retry.deliveryClaimId, { jobId: JOB_ID, route: "origin", deliveredAt: "2026-07-18T12:11:00.000Z", acknowledgedAt: "2026-07-18T12:11:00.000Z" }, broker).state, "acknowledged");
  assert.equal(fs.statSync(path.join(options.stateRoot, "jobs", JOB_ID, "delivery.json")).mode & 0o777, 0o600);
  assert.equal(acknowledgeDelivery(JOB_ID, recoveredClaim.claimId, { route: "origin", deliveredAt: "2026-07-18T12:11:00.000Z", acknowledgedAt: "2026-07-18T12:11:00.000Z" }, broker).state, "acknowledged");
});

test("delivery acknowledgements reject missing or malformed durable receipt timestamps", () => {
  const { options, broker } = setup();
  const origin = { codexThreadId: "thread", codexTurnId: null, cwd: path.join(path.dirname(options.stateRoot), "workspace"), repoRoot: path.join(path.dirname(options.stateRoot), "workspace"), branch: null, head: null };
  const claim = claimDelivery(JOB_ID, { route: "origin", origin }, broker);
  assert.throws(
    () => acknowledgeDelivery(JOB_ID, claim.claimId, { route: "origin", deliveredAt: "yesterday", acknowledgedAt: null }, broker),
    /RFC 3339/i
  );
  const receipt = readReceipt(JOB_ID, broker);
  assert.equal(receipt.delivery.state, "pending");
  assert.equal(receipt.delivery.deliveredAt, null);
});

test("broker coordination leases, launch reservations, cancellation claims, and receipts survive restart", () => {
  const { options, broker } = setup();
  let currentTime = "2026-07-18T12:00:00.000Z";
  const timedBroker = { ...broker, now: () => new Date(currentTime) };
  assert.throws(() => claimSupervisor(JOB_ID, { ownerId: "broker-a", leaseMs: 1_000 }, options), /broker authority/i);
  const first = claimSupervisor(JOB_ID, { ownerId: "broker-a", leaseMs: 1_000 }, timedBroker);
  assert.equal(first.acquired, true);
  currentTime = "2026-07-18T12:00:00.500Z";
  assert.equal(claimSupervisor(JOB_ID, { ownerId: "broker-b", leaseMs: 1_000 }, timedBroker).acquired, false);
  assert.equal(markStarting(JOB_ID, first.leaseToken, timedBroker).leaseToken, first.leaseToken);
  assert.equal(readStartingReservation(JOB_ID, timedBroker).leaseToken, first.leaseToken);

  requestBridgeCancellation(JOB_ID, "operator", broker);
  const coordination = createBridgeCoordinationOperations({
    ...options,
    now: () => new Date(currentTime),
    brokerAuthorityForJob: () => getBridgeBrokerAuthority(JOB_ID, options)
  });
  const cancellation = coordination.claimCancellation(JOB_ID, first.leaseToken);
  assert.equal(cancellation.accepted, true);

  currentTime = "2026-07-18T12:00:02.000Z";
  assert.throws(() => clearStartingReservation(JOB_ID, first.leaseToken, timedBroker), /lease expired/i);
  assert.throws(() => releaseSupervisor(JOB_ID, first.leaseToken, timedBroker), /lease expired/i);
  const recovered = claimSupervisor(JOB_ID, { ownerId: "broker-c", leaseMs: 1_000 }, timedBroker);
  assert.equal(recovered.acquired, true);
  assert.notEqual(recovered.leaseToken, first.leaseToken);
  assert.equal(readStartingReservation(JOB_ID, timedBroker).leaseToken, recovered.leaseToken);
  const recoveredCancellation = coordination.claimCancellation(JOB_ID, recovered.leaseToken);
  assert.equal(recoveredCancellation.claimId, cancellation.claimId);
  confirmCancellation(JOB_ID, recovered.leaseToken, recoveredCancellation.claimId, {
    reason: "operator",
    confirmedAt: "2026-07-18T12:00:02.000Z"
  }, timedBroker);
  assert.equal(readCancellationClaim(JOB_ID, timedBroker).state, "confirmed");
  assert.equal(clearStartingReservation(JOB_ID, recovered.leaseToken, timedBroker), true);
  assert.throws(() => releaseSupervisor(JOB_ID, first.leaseToken, timedBroker), /lease mismatch/i);
  assert.equal(releaseSupervisor(JOB_ID, recovered.leaseToken, timedBroker), true);
  const receipt = readReceipt(JOB_ID, timedBroker);
  assert.equal(receipt.jobId, JOB_ID);
  assert.equal(fs.statSync(path.join(options.stateRoot, "jobs", JOB_ID, "coordination.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(options.stateRoot, "jobs", JOB_ID, "receipt.json")).mode & 0o777, 0o600);
});

test("delivery corruption fails closed and verifier results durably advance receipts exactly once", () => {
  const { options, broker } = setup();
  const deliveryFile = path.join(options.stateRoot, "jobs", JOB_ID, "delivery.json");
  fs.writeFileSync(deliveryFile, JSON.stringify({ schemaVersion: 1, jobId: JOB_ID, state: "invented" }), { mode: 0o600 });
  assert.throws(() => readReceipt(JOB_ID, broker), /invalid durable delivery state/i);
  fs.unlinkSync(deliveryFile);
  transitionBridgeJob(JOB_ID, "running", {}, broker);
  transitionBridgeJob(JOB_ID, "completed", {}, broker);
  const verification = { state: "passed", verifiedAt: new Date(Date.now() + 1_000).toISOString(), evidence: ["repository:tests passed", "codex:review passed"] };
  const recorded = recordVerification(JOB_ID, verification, broker);
  assert.deepEqual(recorded.verification, verification);
  assert.deepEqual(recordVerification(JOB_ID, verification, broker).verification, verification);
  assert.throws(() => recordVerification(JOB_ID, { ...verification, state: "failed" }, broker), /already final/i);
});
