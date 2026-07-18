import assert from "node:assert/strict";
import test from "node:test";

import { superviseBridgeJob } from "../scripts/lib/bridge-supervisor.mjs";

const JOB_ID = "ccb_01J00000000000000000000000";
const IDENTITY = Object.freeze({
  executor: "tmux",
  tmuxSession: "ccb-01J00000000000000000000000",
  paneId: "%7",
  panePid: 4100,
  workerPid: 4101,
  claudeSessionId: "claude-session-1"
});
const RESULT = Object.freeze({
  schemaVersion: 1,
  jobId: JOB_ID,
  status: "completed",
  summary: "broker-normalized result",
  filesChanged: [],
  commandsRun: [],
  testsRun: [],
  findings: [],
  blockers: [],
  claudeSessionId: IDENTITY.claudeSessionId,
  exitStatus: { code: 0, signal: null },
  artifactPaths: []
});

function makeHarness(initial, overrides = {}) {
  let snapshot = structuredClone(initial);
  const calls = [];
  const stateOperations = {
    async claimSupervisor(jobId) {
      calls.push(["claimSupervisor", jobId]);
      return { acquired: true, leaseToken: "lease-1", snapshot: structuredClone(snapshot) };
    },
    async markStarting(jobId, leaseToken) {
      calls.push(["markStarting", jobId, leaseToken]);
      assert.equal(snapshot.phase, "accepted");
      snapshot.phase = "starting";
      return structuredClone(snapshot);
    },
    async recordDispatch(jobId, leaseToken, identity) {
      calls.push(["recordDispatch", jobId, leaseToken, structuredClone(identity)]);
      assert.equal(snapshot.phase, "starting");
      snapshot.phase = "running";
      snapshot.dispatch = structuredClone(identity);
      return structuredClone(snapshot);
    },
    async releaseSupervisor(jobId, leaseToken) {
      calls.push(["releaseSupervisor", jobId, leaseToken]);
    },
    ...overrides.stateOperations
  };
  return {
    calls,
    get snapshot() { return structuredClone(snapshot); },
    options: {
      jobId: JOB_ID,
      ownerId: "supervisor-A",
      stateOperations,
      executor: {
        async launch() {
          calls.push(["launch"]);
          return structuredClone(IDENTITY);
        },
        ...overrides.executor
      },
      inspectProcess: async (identity) => {
        calls.push(["inspectProcess", structuredClone(identity)]);
        return { classification: "live" };
      },
      normalizeResult: overrides.normalizeResult ?? (() => { throw new Error("normalizer must not run"); }),
      delivery: overrides.delivery ?? (async () => { throw new Error("delivery must not run"); })
    }
  };
}

test("records the concrete worker identity before entering running", async () => {
  const harness = makeHarness({
    jobId: JOB_ID,
    phase: "accepted",
    request: { jobId: JOB_ID },
    prompt: "do the work",
    origin: { codexThreadId: "thread-1" },
    dispatch: null,
    result: null,
    delivery: { state: "pending" },
    cancellation: { state: "none" }
  });

  const receipt = await superviseBridgeJob(harness.options);

  assert.equal(receipt.action, "monitoring");
  assert.equal(receipt.classification, "live");
  assert.equal(harness.snapshot.phase, "running");
  assert.deepEqual(harness.snapshot.dispatch, IDENTITY);
  assert.deepEqual(harness.calls.map(([name]) => name), [
    "claimSupervisor", "markStarting", "launch", "recordDispatch", "inspectProcess", "releaseSupervisor"
  ]);
});

function makeRecoveryHarness(initial, dependencies = {}) {
  let snapshot = structuredClone(initial);
  const calls = [];
  let leaseSequence = 0;
  const operations = {
    async claimSupervisor(jobId) {
      const leaseToken = `lease-${++leaseSequence}`;
      calls.push(["claimSupervisor", jobId, leaseToken]);
      return { acquired: true, leaseToken, snapshot: structuredClone(snapshot) };
    },
    async recordDispatch(jobId, leaseToken, identity) {
      calls.push(["recordDispatch", jobId, leaseToken, structuredClone(identity)]);
      snapshot.dispatch = structuredClone(identity);
      snapshot.phase = "running";
      return structuredClone(snapshot);
    },
    async recordWorkerTerminal(jobId, leaseToken, terminal) {
      calls.push(["recordWorkerTerminal", jobId, leaseToken, structuredClone(terminal)]);
      snapshot.workerTerminal = structuredClone(terminal);
      snapshot.phase = terminal.status;
      return structuredClone(snapshot);
    },
    async persistResult(jobId, leaseToken, result) {
      calls.push(["persistResult", jobId, leaseToken, structuredClone(result)]);
      if (!snapshot.result) snapshot.result = structuredClone(result);
      return structuredClone(snapshot);
    },
    async claimCancellation(jobId, leaseToken) {
      calls.push(["claimCancellation", jobId, leaseToken]);
      if (snapshot.cancellation.state === "confirmed") return { accepted: false };
      if (snapshot.cancellation.state === "claimed") {
        return { accepted: true, claimId: "cancel-1", reason: snapshot.cancellation.reason };
      }
      if (snapshot.cancellation.state !== "requested") return { accepted: false };
      snapshot.cancellation.state = "claimed";
      return { accepted: true, claimId: "cancel-1", reason: snapshot.cancellation.reason };
    },
    async confirmCancellation(jobId, leaseToken, claimId, confirmation) {
      calls.push(["confirmCancellation", jobId, leaseToken, claimId, structuredClone(confirmation)]);
      snapshot.phase = "cancelled";
      snapshot.cancellation.state = "confirmed";
      return structuredClone(snapshot);
    },
    async releaseSupervisor(jobId, leaseToken) {
      calls.push(["releaseSupervisor", jobId, leaseToken]);
    },
    ...dependencies.stateOperations
  };
  const executor = {
    async launch() {
      calls.push(["launch"]);
      return structuredClone(IDENTITY);
    },
    async discover(jobId) {
      calls.push(["discover", jobId]);
      return [structuredClone(IDENTITY)];
    },
    async cancel(identity, reason) {
      calls.push(["cancel", structuredClone(identity), reason]);
      return { cancelled: true };
    },
    ...dependencies.executor
  };
  const inspectProcess = dependencies.inspectProcess ?? (async (identity) => {
    calls.push(["inspectProcess", structuredClone(identity)]);
    return { classification: "live" };
  });
  const normalizeResult = dependencies.normalizeResult ?? (async (exit) => {
    calls.push(["normalizeResult", structuredClone(exit)]);
    return structuredClone(RESULT);
  });
  const delivery = dependencies.delivery ?? (async ({ result }) => {
    calls.push(["delivery", structuredClone(result)]);
    snapshot.delivery = { state: "acknowledged" };
    return { state: "acknowledged", route: "test" };
  });
  return {
    calls,
    get snapshot() { return structuredClone(snapshot); },
    options: {
      jobId: JOB_ID,
      ownerId: "supervisor-A",
      leaseMs: 30_000,
      stateOperations: operations,
      executor,
      inspectProcess,
      normalizeResult,
      delivery
    }
  };
}

function baseSnapshot(overrides = {}) {
  return {
    jobId: JOB_ID,
    phase: "running",
    request: { jobId: JOB_ID },
    prompt: "do the work",
    origin: { codexThreadId: "thread-1", cwd: "/repo", repoRoot: "/repo" },
    dispatch: structuredClone(IDENTITY),
    workerTerminal: null,
    result: null,
    receipt: { jobId: JOB_ID, workerState: "completed", delivery: { state: "pending" } },
    delivery: { state: "pending" },
    cancellation: { state: "none" },
    ...overrides
  };
}

test("recovers a crash after launch before dispatch without launching twice", async () => {
  const harness = makeRecoveryHarness(baseSnapshot({ phase: "starting", dispatch: null }));

  const first = await superviseBridgeJob(harness.options);
  const second = await superviseBridgeJob(harness.options);

  assert.equal(first.action, "monitoring");
  assert.equal(first.recovered, true);
  assert.equal(second.action, "monitoring");
  assert.deepEqual(harness.snapshot.dispatch, IDENTITY);
  assert.equal(harness.calls.filter(([name]) => name === "launch").length, 0);
  assert.equal(harness.calls.filter(([name]) => name === "discover").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "recordDispatch").length, 1);
});

test("survives a dispatch-record crash by discovering the already-launched worker", async () => {
  let snapshot = baseSnapshot({ phase: "accepted", dispatch: null });
  let firstRecord = true;
  let launchCount = 0;
  const stateOperations = {
    async claimSupervisor() { return { acquired: true, leaseToken: "lease", snapshot: structuredClone(snapshot) }; },
    async markStarting() { snapshot.phase = "starting"; return structuredClone(snapshot); },
    async recordDispatch(jobId, lease, identity) {
      if (firstRecord) {
        firstRecord = false;
        throw new Error("simulated crash after launch");
      }
      snapshot.phase = "running";
      snapshot.dispatch = structuredClone(identity);
      return structuredClone(snapshot);
    },
    async releaseSupervisor() {}
  };
  const options = {
    jobId: JOB_ID,
    stateOperations,
    executor: {
      async launch() { launchCount += 1; return structuredClone(IDENTITY); },
      async discover() { return [structuredClone(IDENTITY)]; }
    },
    inspectProcess: async () => ({ classification: "live" }),
    normalizeResult: async () => structuredClone(RESULT),
    delivery: async () => ({ state: "acknowledged" })
  };

  await assert.rejects(superviseBridgeJob(options), /simulated crash after launch/);
  const recovery = await superviseBridgeJob(options);

  assert.equal(recovery.action, "monitoring");
  assert.equal(recovery.recovered, true);
  assert.equal(launchCount, 1);
  assert.equal(snapshot.phase, "running");
});

test("returns an explicit ambiguous receipt when post-launch identity is missing", async () => {
  const harness = makeRecoveryHarness(baseSnapshot({ phase: "starting", dispatch: null }), {
    executor: { async discover() { return []; } }
  });

  const recovery = await superviseBridgeJob(harness.options);

  assert.equal(recovery.action, "recovery-required");
  assert.equal(recovery.classification, "ambiguous");
  assert.equal(recovery.identityClassification, "missing");
  assert.equal(recovery.safeToRelaunch, false);
  assert.equal(harness.calls.filter(([name]) => name === "launch").length, 0);
});

test("normalizes a dead worker in the broker and persists result before delivery", async () => {
  const order = [];
  const hostileExit = {
    code: 0,
    signal: null,
    verification: { state: "passed" },
    delivery: { state: "acknowledged" },
    workerResult: { summary: "trust me" }
  };
  const harness = makeRecoveryHarness(baseSnapshot(), {
    inspectProcess: async () => ({ classification: "dead", exit: structuredClone(hostileExit) }),
    normalizeResult: async (rawExit, context) => {
      order.push("normalize");
      assert.deepEqual(rawExit, hostileExit);
      assert.equal(context.dispatch.workerPid, IDENTITY.workerPid);
      return structuredClone(RESULT);
    },
    stateOperations: {
      async recordWorkerTerminal(jobId, leaseToken, terminal) {
        order.push("terminal");
        assert.deepEqual(Object.keys(terminal).sort(), ["exitStatus", "observedIdentity", "status"]);
        return baseSnapshot({ phase: "completed", workerTerminal: terminal });
      },
      async persistResult(jobId, leaseToken, result) {
        order.push("persist");
        assert.equal("verification" in result, false);
        assert.equal("delivery" in result, false);
        return baseSnapshot({ phase: "completed", result: structuredClone(result) });
      }
    },
    delivery: async ({ result }) => {
      order.push("deliver");
      assert.deepEqual(result, RESULT);
      return { state: "acknowledged" };
    }
  });

  const recovery = await superviseBridgeJob(harness.options);

  assert.equal(recovery.action, "delivery");
  assert.deepEqual(order, ["normalize", "terminal", "persist", "deliver"]);
});

test("reconstructs a result after a crash between terminal recording and result persistence", async () => {
  const harness = makeRecoveryHarness(baseSnapshot({
    phase: "completed",
    workerTerminal: { status: "completed", exitStatus: { code: 0, signal: null } }
  }), {
    inspectProcess: async () => ({ classification: "dead", exit: { code: 0, signal: null } })
  });

  const recovery = await superviseBridgeJob(harness.options);

  assert.equal(recovery.action, "delivery");
  assert.deepEqual(harness.snapshot.result, RESULT);
  assert.equal(harness.calls.filter(([name]) => name === "normalizeResult").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "persistResult").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "delivery").length, 1);
});

test("resumes after result persistence and relies on durable delivery deduplication", async () => {
  const harness = makeRecoveryHarness(baseSnapshot({ phase: "completed", result: structuredClone(RESULT) }));

  const first = await superviseBridgeJob(harness.options);
  const second = await superviseBridgeJob(harness.options);

  assert.equal(first.action, "delivery");
  assert.equal(second.action, "terminal");
  assert.equal(harness.calls.filter(([name]) => name === "delivery").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "launch").length, 0);
  assert.equal(harness.calls.filter(([name]) => name === "persistResult").length, 0);
  assert.equal(harness.calls.filter(([name]) => name === "normalizeResult").length, 0);
});

test("fails closed on stale PID or tmux attribution", async () => {
  const harness = makeRecoveryHarness(baseSnapshot(), {
    inspectProcess: async () => ({ classification: "stale", observedPid: 9999 })
  });

  const recovery = await superviseBridgeJob(harness.options);

  assert.equal(recovery.action, "recovery-required");
  assert.equal(recovery.identityClassification, "stale");
  assert.equal(recovery.safeToRelaunch, false);
  assert.equal(harness.calls.filter(([name]) => name === "persistResult").length, 0);
  assert.equal(harness.calls.filter(([name]) => name === "delivery").length, 0);
});

test("observes cancellation intent and durably confirms it exactly once", async () => {
  const harness = makeRecoveryHarness(baseSnapshot({ cancellation: { state: "requested", reason: "user asked" } }));

  const first = await superviseBridgeJob(harness.options);
  const second = await superviseBridgeJob(harness.options);

  assert.equal(first.action, "cancelled");
  assert.equal(first.classification, "confirmed");
  assert.equal(second.action, "recovery-required");
  assert.equal(harness.calls.filter(([name]) => name === "cancel").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "confirmCancellation").length, 1);
});

test("resumes a claimed cancellation after a crash before durable confirmation", async () => {
  let confirmations = 0;
  const harness = makeRecoveryHarness(baseSnapshot({
    cancellation: { state: "requested", reason: "user asked" }
  }), {
    stateOperations: {
      async confirmCancellation(jobId, leaseToken, claimId, confirmation) {
        confirmations += 1;
        if (confirmations === 1) throw new Error("simulated confirmation crash");
        return baseSnapshot({ phase: "cancelled", cancellation: { state: "confirmed", reason: confirmation.reason } });
      }
    }
  });

  await assert.rejects(superviseBridgeJob(harness.options), /simulated confirmation crash/);
  const recovery = await superviseBridgeJob(harness.options);

  assert.equal(recovery.action, "cancelled");
  assert.equal(recovery.classification, "confirmed");
  assert.equal(confirmations, 2);
});

test("defers without side effects when another supervisor owns the lease", async () => {
  const harness = makeRecoveryHarness(baseSnapshot(), {
    stateOperations: {
      async claimSupervisor() { return { acquired: false, snapshot: baseSnapshot() }; }
    }
  });

  const recovery = await superviseBridgeJob(harness.options);

  assert.equal(recovery.action, "deferred");
  assert.equal(recovery.classification, "lease-held");
  assert.equal(harness.calls.length, 0);
});
