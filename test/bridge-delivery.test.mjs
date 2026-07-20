import test from "node:test";
import assert from "node:assert/strict";

import {
  createCodexOriginAdapter,
  deliverBridgeResult,
  drainBridgeInbox
} from "../scripts/lib/bridge-delivery.mjs";

const JOB_ID = "ccb_00000000000000000000000001";

function completedResult(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    status: "completed",
    summary: "Implemented the bounded change.",
    filesChanged: ["scripts/lib/example.mjs"],
    commandsRun: [{ command: "node --test", status: "passed", exitCode: 0 }],
    testsRun: [{ command: "node --test", status: "passed", summary: "4/4 passed" }],
    findings: [], blockers: [],
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    exitStatus: { code: 0, signal: null }, artifactPaths: [],
    ...overrides
  };
}

function pendingReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    createdAt: "2026-07-18T12:00:00.000Z",
    workerState: "completed", workerError: null,
    delivery: { state: "pending", attempts: 0, deliveredAt: null, acknowledgedAt: null, lastError: null },
    verification: { state: "pending", verifiedAt: null, evidence: [] },
    profile: "standard", effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"],
    ...overrides
  };
}

function origin() {
  return {
    codexThreadId: "thread-origin", codexTurnId: "turn-origin",
    cwd: "/tmp/workspace", repoRoot: "/tmp/workspace", branch: "main", head: null
  };
}

test("an active waiter receives and acknowledges one correlated delivery", async () => {
  const calls = [];
  const stateOperations = {
    claimDelivery: async (jobId, metadata) => {
      calls.push(["claim", jobId, metadata]);
      return { accepted: true, claimId: "claim-1" };
    },
    acknowledgeDelivery: async (jobId, claimId, metadata) => {
      calls.push(["ack", jobId, claimId, metadata]);
    }
  };
  let delivered;
  const outcome = await deliverBridgeResult({
    result: completedResult(), receipt: pendingReceipt(), origin: origin(), stateOperations,
    waiter: async (envelope) => {
      delivered = envelope;
      return { acknowledged: true };
    },
    now: () => new Date("2026-07-18T12:01:00.000Z")
  });

  assert.equal(outcome.state, "acknowledged");
  assert.equal(outcome.route, "waiter");
  assert.equal(delivered.jobId, JOB_ID);
  assert.equal(delivered.workerCompleted, true);
  assert.equal(delivered.verified, false);
  assert.equal(calls.filter(([kind]) => kind === "claim").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "ack").length, 1);
});

test("failed and cancelled terminal results use the same acknowledged delivery flow", async () => {
  for (const workerStatus of ["failed", "cancelled"]) {
    let delivered;
    const outcome = await deliverBridgeResult({
      result: completedResult({ status: workerStatus, summary: `${workerStatus} safely` }),
      receipt: pendingReceipt({ workerState: workerStatus, workerError: workerStatus === "failed" ? "worker failed" : null }),
      origin: origin(),
      stateOperations: {
        claimDelivery: async () => ({ accepted: true, claimId: `claim-${workerStatus}` }),
        acknowledgeDelivery: async () => {}
      },
      waiter: async (envelope) => { delivered = envelope; return { acknowledged: true }; }
    });
    assert.equal(outcome.state, "acknowledged");
    assert.equal(delivered.workerStatus, workerStatus);
    assert.equal(delivered.workerCompleted, false);
  }
});

test("without a waiter the correlated Codex origin is resumed with a concise redacted prompt", async () => {
  const calls = [];
  let adapterInput;
  const outcome = await deliverBridgeResult({
    result: completedResult({
      summary: `Completed safely with token sk-ant-${"x".repeat(80)}. ${"transcript ".repeat(300)}`
    }),
    receipt: pendingReceipt(), origin: origin(),
    stateOperations: {
      claimDelivery: async () => ({ accepted: true, claimId: "claim-origin" }),
      acknowledgeDelivery: async (...args) => calls.push(args)
    },
    originAdapter: async (input) => {
      adapterInput = input;
      return { acknowledged: true, threadId: "thread-origin" };
    },
    now: () => new Date("2026-07-18T12:02:00.000Z")
  });

  assert.equal(outcome.route, "origin");
  assert.equal(adapterInput.cwd, "/tmp/workspace");
  assert.equal(adapterInput.resumeThreadId, "thread-origin");
  assert.match(adapterInput.prompt, new RegExp(JOB_ID));
  assert.match(adapterInput.prompt, /worker completed: yes/i);
  assert.match(adapterInput.prompt, /independently verified: no/i);
  assert.doesNotMatch(adapterInput.prompt, /sk-ant-/);
  assert.ok(adapterInput.prompt.length <= 1_200);
  assert.equal(calls.length, 1);
});

test("a stale, wrong, busy, or unavailable origin fails closed into the durable per-origin inbox", async () => {
  for (const failure of [
    async () => ({ acknowledged: true, threadId: "wrong-thread" }),
    async () => { throw new Error("thread is busy: Bearer raw-secret-value"); },
    async () => { throw new Error("Codex unavailable"); }
  ]) {
    let inboxWrite;
    let acknowledged = false;
    const outcome = await deliverBridgeResult({
      result: completedResult({ summary: "Done with api_key=raw-secret-value" }),
      receipt: pendingReceipt(), origin: origin(),
      stateOperations: {
        claimDelivery: async () => ({ accepted: true, claimId: "claim-fallback" }),
        acknowledgeDelivery: async () => { acknowledged = true; },
        failDeliveryToInbox: async (...args) => { inboxWrite = args; }
      },
      originAdapter: failure,
      now: () => new Date("2026-07-18T12:03:00.000Z")
    });

    assert.equal(outcome.state, "queued");
    assert.equal(outcome.route, "inbox");
    assert.equal(acknowledged, false);
    assert.equal(inboxWrite[0], JOB_ID);
    assert.equal(inboxWrite[1], "claim-fallback");
    assert.equal(inboxWrite[2].origin.codexThreadId, "thread-origin");
    assert.doesNotMatch(JSON.stringify(inboxWrite), /raw-secret-value/);
    assert.equal(inboxWrite[2].attempt, 0);
  }
});

test("drain claims one durable inbox item and acknowledges its retry exactly once", async () => {
  let available = true;
  let adapterCalls = 0;
  const acknowledgements = [];
  const stateOperations = {
    claimInbox: async () => {
      if (!available) return null;
      available = false;
      return {
        inboxClaimId: "inbox-claim-1",
        deliveryClaimId: "delivery-claim-1",
        item: {
          schemaVersion: 1, jobId: JOB_ID, origin: origin(),
          prompt: `Bridge result for ${JOB_ID}. Worker completed: yes. Independently verified: no.`,
          workerCompleted: true, verified: false, failedRoute: "origin",
          error: "Codex unavailable", attempt: 0, queuedAt: "2026-07-18T12:03:00.000Z"
        }
      };
    },
    acknowledgeInboxDelivery: async (...args) => acknowledgements.push(args)
  };
  const originAdapter = async ({ resumeThreadId }) => {
    adapterCalls += 1;
    return { acknowledged: true, threadId: resumeThreadId };
  };

  const first = await drainBridgeInbox({
    origin: origin(), stateOperations, originAdapter,
    now: () => new Date("2026-07-18T12:04:00.000Z")
  });
  const second = await drainBridgeInbox({ origin: origin(), stateOperations, originAdapter });

  assert.deepEqual(first, { state: "acknowledged", route: "origin", jobId: JOB_ID });
  assert.deepEqual(second, { state: "empty" });
  assert.equal(adapterCalls, 1);
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0][1], "inbox-claim-1");
  assert.equal(acknowledgements[0][2], "delivery-claim-1");
});

test("a durable duplicate claim suppresses every external delivery side effect", async () => {
  let callbacks = 0;
  let acknowledgements = 0;
  const outcome = await deliverBridgeResult({
    result: completedResult(), receipt: pendingReceipt(), origin: origin(),
    stateOperations: {
      claimDelivery: async () => ({ accepted: false, state: "acknowledged" }),
      acknowledgeDelivery: async () => { acknowledgements += 1; }
    },
    waiter: async () => { callbacks += 1; return { acknowledged: true }; }
  });
  assert.deepEqual(outcome, { state: "deduplicated", route: "waiter" });
  assert.equal(callbacks, 0);
  assert.equal(acknowledgements, 0);
});

test("existing nonterminal delivery claims preserve queued and deferred liveness states", async () => {
  for (const [claimState, expectedState] of [["inbox", "queued"], ["inbox_claimed", "queued"], ["claimed", "deferred"]]) {
    const outcome = await deliverBridgeResult({
      result: completedResult(), receipt: pendingReceipt(), origin: origin(),
      stateOperations: {
        claimDelivery: async () => ({ accepted: false, state: claimState, claimId: "claim-live" }),
        acknowledgeDelivery: async () => { throw new Error("must not acknowledge"); }
      },
      originAdapter: async () => { throw new Error("must not invoke adapter"); }
    });
    assert.equal(outcome.state, expectedState);
  }
});

test("the Codex adapter resumes only the supplied origin thread", async () => {
  let invocation;
  const adapter = createCodexOriginAdapter({
    runTurn: async (...args) => {
      invocation = args;
      return { status: 0, threadId: "thread-origin" };
    }
  });
  const acknowledgement = await adapter({
    cwd: "/tmp/workspace", resumeThreadId: "thread-origin", prompt: "correlated prompt"
  });
  assert.deepEqual(invocation, ["/tmp/workspace", {
    resumeThreadId: "thread-origin", prompt: "correlated prompt",
    disableBroker: true, timeoutMs: 15_000
  }]);
  assert.deepEqual(acknowledgement, { acknowledged: true, threadId: "thread-origin" });
});

test("the Codex adapter forwards a bounded direct-delivery deadline", async () => {
  let turnOptions;
  const adapter = createCodexOriginAdapter({
    timeoutMs: 125,
    runTurn: async (_cwd, options) => {
      turnOptions = options;
      return { status: 1, threadId: "thread-origin" };
    }
  });
  const acknowledgement = await adapter({
    cwd: "/tmp/workspace", resumeThreadId: "thread-origin", prompt: "deliver"
  });
  assert.equal(turnOptions.disableBroker, true);
  assert.equal(turnOptions.timeoutMs, 125);
  assert.equal(acknowledgement.acknowledged, false);
});
