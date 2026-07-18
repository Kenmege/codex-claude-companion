import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  adaptBridgeLedgerSnapshot,
  createBridgeRuntime,
  inspectBridgeRuntimeCompatibility
} from "../scripts/lib/bridge-runtime.mjs";
import {
  createBridgeJob,
  getBridgeJob
} from "../scripts/lib/bridge-state.mjs";

const JOB_ID = "ccb_01J00000000000000000000000";

function verificationDependencies() {
  return {
    captureWorkspace: async () => ({ entries: [] }),
    runRepositoryChecks: async () => ({ passed: true, evidence: ["fixture repository check"] }),
    runCodexReview: async () => ({ passed: true, evidence: ["fixture Codex review"] }),
    persistVerification: async () => {}
  };
}

test("current bridge modules expose a complete durable runtime integration", () => {
  const report = inspectBridgeRuntimeCompatibility({ codexBinary: process.execPath });

  assert.equal(report.ready, true);
  assert.deepEqual(report.missing, []);
  assert.equal(report.guarantees.recordDispatchBeforeRunning, true);
  assert.equal(report.guarantees.safeUntrackedLaunchRecovery, true);
  assert.deepEqual(report.securityModel.trustedAutonomous, {
    available: true,
    containment: "cooperative-host-trust-only",
    brokerAuthorityIsolation: false
  });
  assert.deepEqual(report.securityModel.sandboxAutonomous, {
    available: false,
    containment: "requires-verified-separate-uid-or-os-sandbox",
    brokerAuthorityIsolation: false
  });
});

test("runtime fails closed before supervisor or executor side effects when compatibility is incomplete", async () => {
  let supervisorCalls = 0;
  let launchCalls = 0;
  const runtime = createBridgeRuntime({
    supervisorFn: async () => { supervisorCalls += 1; },
    executorApi: { launchTmuxClaudeWorker: async () => { launchCalls += 1; } }
  });

  const result = await runtime.run({ jobId: JOB_ID, prompt: "work" });

  assert.equal(result.action, "blocked");
  assert.equal(result.classification, "incompatible-runtime");
  assert.equal(result.safeToLaunch, false);
  assert.equal(supervisorCalls, 0);
  assert.equal(launchCalls, 0);
});

test("maxRepairs=1 fails closed unless all durable repair lifecycle operations are wired", async () => {
  const runtime = createBridgeRuntime({
    maxRepairs: 1,
    codexBinary: process.execPath
  });

  const result = await runtime.run({ jobId: JOB_ID, prompt: "work", maxRepairs: 1 });

  assert.equal(result.action, "blocked");
  assert.equal(result.classification, "incompatible-runtime");
  assert.equal(result.safeToLaunch, false);
  assert.deepEqual(result.missing.filter((item) => item.code === "bounded-production-repair"), [{
    code: "bounded-production-repair",
    detail: "maxRepairs=1 requires durable dispatch, await, and crash-resume repair operations"
  }]);
});

test("ledger snapshot adapter maps status, request, result, cancellation, and dispatch without invention", async () => {
  const request = {
    jobId: JOB_ID,
    origin: { codexThreadId: "thread-1", cwd: "/repo", repoRoot: "/repo" },
    execution: { canonicalWorkspacePath: "/repo" },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
  const dispatch = { executor: "tmux", tmuxSession: "ccb-job", workerPid: 42 };
  const result = { jobId: JOB_ID, status: "completed" };
  const snapshot = await adaptBridgeLedgerSnapshot(JOB_ID, {
    prompt: "durable prompt supplied by caller",
    stateApi: {
      getBridgeJob: () => ({
        jobId: JOB_ID,
        status: "completed",
        cancelRequestedAt: "2026-07-18T10:00:00.000Z",
        dispatch
      }),
      readBridgeRequest: () => request,
      readBridgeResult: () => result
    },
    coordination: {
      readStartingReservation: async () => null,
      readCancellationClaim: async () => ({ state: "confirmed", reason: "user asked" }),
      readDelivery: async () => ({ state: "pending" }),
      readReceipt: async () => ({ jobId: JOB_ID })
    }
  });

  assert.equal(snapshot.phase, "completed");
  assert.equal(snapshot.prompt, "durable prompt supplied by caller");
  assert.deepEqual(snapshot.request, request);
  assert.deepEqual(snapshot.result, result);
  assert.deepEqual(snapshot.dispatch, dispatch);
  assert.deepEqual(snapshot.cancellation, { state: "confirmed", reason: "user asked" });
  assert.deepEqual(snapshot.delivery, { state: "pending" });
});

test("a complete adapter binds broker authority, ledger mutations, executor, and delivery", async () => {
  const calls = [];
  let ledger = {
    jobId: JOB_ID,
    status: "accepted",
    dispatch: null,
    cancelRequestedAt: null
  };
  const request = {
    jobId: JOB_ID,
    origin: { codexThreadId: "thread-1", cwd: "/repo", repoRoot: "/repo" },
    execution: { canonicalWorkspacePath: "/repo" },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
  const coordination = {
    async claimSupervisor() { return { acquired: true, leaseToken: "lease-1" }; },
    async releaseSupervisor() {},
    async markStarting() { calls.push("markStarting"); },
    async clearStartingReservation() {},
    async readStartingReservation() { return null; },
    async claimCancellation() { return { accepted: false }; },
    async confirmCancellation() {},
    async readCancellationClaim() { return null; },
    async claimDelivery() { return { accepted: false }; },
    async acknowledgeDelivery() {},
    async failDeliveryToInbox() {},
    async readDelivery() { return { state: "pending" }; },
    async readReceipt() { return { jobId: JOB_ID }; },
    async recordVerification() {},
    async claimInbox() { return null; },
    async acknowledgeInboxDelivery() {},
    async failInboxDelivery() {}
  };
  const stateApi = {
    getBridgeBrokerAuthority() { return { jobId: JOB_ID, token: "authority" }; },
    getBridgeJob() { return structuredClone(ledger); },
    readBridgeRequest() { return structuredClone(request); },
    readBridgeResult() { return null; },
    recordDispatch(jobId, identity, options) {
      calls.push(["recordDispatch", identity, options.brokerAuthority.token]);
      ledger = { ...ledger, status: "running", dispatch: structuredClone(identity) };
      return structuredClone(ledger);
    },
    transitionBridgeJob(jobId, status, details, options) {
      calls.push(["transitionBridgeJob", status, details, options.brokerAuthority.token]);
      ledger.status = status;
      return structuredClone(ledger);
    },
    writeBridgeResult() { throw new Error("not used in tracer"); }
  };
  const identity = {
    executor: "tmux",
    tmuxSession: "ccb-job",
    paneId: "%1",
    panePid: 100,
    workerPid: 101,
    claudeSessionId: "session"
  };
  const runtime = createBridgeRuntime({
    stateApi,
    coordination,
    identityFields: ["executor", "tmuxSession", "paneId", "panePid", "workerPid", "claudeSessionId"],
    executorApi: {
      async launchTmuxClaudeWorker(options) {
        calls.push("launch");
        assert.equal(options.brokerAuthority, undefined);
        await options.stateOperations.recordDispatch(JOB_ID, identity);
        return structuredClone(identity);
      },
      async discover() { return []; },
      async cancel(launch) {
        calls.push("cancel");
        assert.equal(launch.jobId, JOB_ID);
        assert.equal(launch.artifacts.identityFile, "/private/job/runtime/identity.json");
        assert.equal(launch.artifacts.cancelFile, "/private/job/runtime/cancel.json");
        assert.equal(launch.artifacts.exitFile, "/private/job/runtime/exit.json");
      }
    },
    processInspector: async () => ({ classification: "live" }),
    normalizeResult: async () => { throw new Error("not used"); },
    deliveryFn: async () => ({ state: "deduplicated" }),
    supervisorFn: async (options) => {
      const claim = await options.stateOperations.claimSupervisor(JOB_ID, {});
      assert.equal(claim.snapshot.phase, "accepted");
      const starting = await options.stateOperations.markStarting(JOB_ID, claim.leaseToken);
      assert.equal(starting.phase, "starting");
      const launched = await options.executor.launch({ request, prompt: "work" });
      const running = await options.stateOperations.recordDispatch(JOB_ID, claim.leaseToken, launched);
      assert.equal(running.phase, "running");
      await options.executor.cancel(running.dispatch, "test cancellation transport");
      return { action: "monitoring" };
    },
    executorOptions: { jobDir: "/private/job" },
    verificationDependencies: verificationDependencies()
  });

  assert.equal(runtime.compatibility.ready, true);
  const outcome = await runtime.run({ jobId: JOB_ID, prompt: "work" });

  assert.deepEqual(outcome, { action: "monitoring" });
  assert.deepEqual(calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
    "markStarting", "launch", "recordDispatch", "recordDispatch", "cancel"
  ]);

  request.execution = { ...request.execution, profile: "trusted-autonomous" };
  const callsBeforeSecurityGate = calls.length;
  const isolated = await runtime.run({
    jobId: JOB_ID,
    prompt: "work",
    securityRequirements: { brokerAuthorityIsolation: true }
  });
  assert.equal(isolated.action, "blocked");
  assert.equal(isolated.classification, "security-boundary-unavailable");
  assert.equal(isolated.trustProfile, "trusted-autonomous");
  assert.equal(isolated.safeToLaunch, false);
  assert.equal(calls.length, callsBeforeSecurityGate);

  request.execution = { ...request.execution, profile: "sandbox-autonomous" };
  const sandboxed = await runtime.run({ jobId: JOB_ID, prompt: "work" });
  assert.equal(sandboxed.classification, "security-boundary-unavailable");
  assert.equal(sandboxed.trustProfile, "sandbox-autonomous");
  assert.equal(calls.length, callsBeforeSecurityGate);
});

test("internal repair suppresses verifier and delivery so the parent is the only external delivery authority", async () => {
  const childId = "ccb_00000000000000000000000002";
  const workspace = "/private/workspace";
  let childResult = null;
  let externalDeliveries = 0;
  let verifierCalls = 0;
  let inboxDrains = 0;

  function components(jobId, initialStatus, resultReader) {
    const request = {
      jobId,
      origin: { codexThreadId: "thread-1", cwd: workspace, repoRoot: workspace },
      execution: { canonicalWorkspacePath: workspace },
      task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
    };
    const stateApi = {
      getBridgeBrokerAuthority: () => ({ jobId, token: "authority" }),
      getBridgeJob: () => ({ jobId, status: initialStatus, dispatch: null, cancelRequestedAt: null }),
      readBridgeRequest: () => structuredClone(request),
      readBridgeResult: () => structuredClone(resultReader()),
      recordDispatch() {}, transitionBridgeJob() {}, writeBridgeResult() {},
      resolveBridgeJobDir: () => `/private/${jobId}`
    };
    const coordination = {
      async claimSupervisor() { return { acquired: true, leaseToken: "lease" }; },
      async releaseSupervisor() {}, async markStarting() {}, async clearStartingReservation() {},
      async readStartingReservation() { return null; }, async claimCancellation() { return { accepted: false }; },
      async confirmCancellation() {}, async readCancellationClaim() { return null; },
      async claimDelivery() { return { accepted: true }; }, async acknowledgeDelivery() {},
      async failDeliveryToInbox() {}, async readDelivery() { return { state: "pending" }; },
      async readReceipt() {
        return { jobId, workerState: "completed", verification: { state: "passed" }, delivery: { state: "pending" } };
      },
      async recordVerification() {}, async claimInbox() { return null; },
      async acknowledgeInboxDelivery() {}, async failInboxDelivery() {}
    };
    return { request, stateApi, coordination };
  }

  const child = components(childId, "running", () => childResult);
  const childRuntime = createBridgeRuntime({
    stateApi: child.stateApi,
    coordination: child.coordination,
    internalRepair: { parentJobId: JOB_ID, attempt: 1 },
    executorApi: {
      async launchTmuxClaudeWorker() {}, async discover() { return []; },
      async inspectProcess() { return { classification: "live" }; }
    },
    deliveryFn: async () => { externalDeliveries += 1; return { state: "acknowledged" }; },
    inboxDrainFn: async () => { inboxDrains += 1; },
    verificationFn: async () => { verifierCalls += 1; throw new Error("child verifier must not run"); },
    supervisorFn: async (options) => {
      childResult = { jobId: childId, status: "completed", filesChanged: ["src/fix.mjs"] };
      const delivery = await options.delivery({ jobId: childId, result: childResult });
      assert.equal(delivery.state, "suppressed-internal-repair");
      return { action: "verification-required" };
    },
    verificationDependencies: verificationDependencies(),
    executorOptions: { jobDir: `/private/${childId}` }
  });
  const childOutcome = await childRuntime.run({ jobId: childId, prompt: "repair" });
  assert.equal(childOutcome.action, "repair-terminal");
  assert.equal(childOutcome.classification, "completed");

  const parentResult = { jobId: JOB_ID, status: "completed", filesChanged: ["src/fix.mjs"] };
  const parent = components(JOB_ID, "completed", () => parentResult);
  const parentRuntime = createBridgeRuntime({
    stateApi: parent.stateApi,
    coordination: parent.coordination,
    executorApi: {
      async launchTmuxClaudeWorker() {}, async discover() { return []; },
      async inspectProcess() { return { classification: "dead" }; }
    },
    deliveryFn: async () => { externalDeliveries += 1; return { state: "acknowledged" }; },
    inboxDrainFn: async () => { inboxDrains += 1; },
    supervisorFn: async (options) => {
      await options.delivery({ jobId: JOB_ID, result: parentResult });
      return { action: "delivery", classification: "acknowledged" };
    },
    verificationDependencies: verificationDependencies(),
    executorOptions: { jobDir: `/private/${JOB_ID}` }
  });
  const parentOutcome = await parentRuntime.run({ jobId: JOB_ID, prompt: "parent" });
  assert.equal(parentOutcome.action, "delivery");
  assert.equal(externalDeliveries, 1);
  assert.equal(verifierCalls, 0);
  assert.equal(inboxDrains, 1);
});

test("parent crash after immutable verification evidence replays the receipt without rerunning review or repair", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runtime-verification-replay-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const jobDir = path.join(base, JOB_ID);
  fs.mkdirSync(path.join(jobDir, "runtime"), { recursive: true, mode: 0o700 });
  const verification = {
    state: "passed",
    verifiedAt: "2026-07-18T12:00:00.000Z",
    evidence: ["repository:test passed", "codex:review passed", "repair-attempt:1"]
  };
  fs.writeFileSync(path.join(jobDir, "runtime", "verification-attempts.json"), JSON.stringify({
    schemaVersion: 1,
    jobId: JOB_ID,
    verification,
    attempts: [{ attempt: 0, passed: false }, { attempt: 1, passed: true }],
    result: { jobId: JOB_ID, status: "completed", filesChanged: ["src/a.mjs"] }
  }), { mode: 0o600 });
  const request = {
    jobId: JOB_ID,
    origin: { codexThreadId: "thread-1", cwd: base, repoRoot: base },
    execution: { canonicalWorkspacePath: base },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
  let recordCalls = 0;
  let verifierCalls = 0;
  let resumeCalls = 0;
  const coordination = {
    async claimSupervisor() { return { acquired: true, leaseToken: "lease" }; },
    async releaseSupervisor() {}, async markStarting() {}, async clearStartingReservation() {},
    async readStartingReservation() { return null; }, async claimCancellation() { return { accepted: false }; },
    async confirmCancellation() {}, async readCancellationClaim() { return null; },
    async claimDelivery() { return { accepted: false }; }, async acknowledgeDelivery() {},
    async failDeliveryToInbox() {}, async readDelivery() { return { state: "pending" }; },
    async readReceipt() {
      return { jobId: JOB_ID, workerState: "completed", verification: { state: "pending" }, delivery: { state: "pending" } };
    },
    async recordVerification(jobId, value) {
      recordCalls += 1;
      assert.equal(jobId, JOB_ID);
      assert.deepEqual(value, verification);
    },
    async claimInbox() { return null; }, async acknowledgeInboxDelivery() {}, async failInboxDelivery() {}
  };
  const repairLifecycle = {
    async dispatchRepair() {}, async awaitRepair() {},
    async resumePendingRepair() { resumeCalls += 1; throw new Error("must not resume after final evidence"); }
  };
  const runtime = createBridgeRuntime({
    stateApi: {
      getBridgeBrokerAuthority: () => ({ jobId: JOB_ID, token: "authority" }),
      getBridgeJob: () => ({ jobId: JOB_ID, status: "completed", dispatch: null, cancelRequestedAt: null }),
      readBridgeRequest: () => structuredClone(request),
      readBridgeResult: () => ({ jobId: JOB_ID, status: "completed", filesChanged: ["src/a.mjs"] }),
      recordDispatch() {}, transitionBridgeJob() {}, writeBridgeResult() {},
      resolveBridgeJobDir: () => jobDir
    },
    coordination,
    repairLifecycle,
    maxRepairs: 1,
    executorApi: {
      async launchTmuxClaudeWorker() {}, async discover() { return []; },
      async inspectProcess() { return { classification: "dead" }; }
    },
    inboxDrainFn: async () => {},
    supervisorFn: async () => ({ action: "verification-required" }),
    verificationFn: async () => { verifierCalls += 1; throw new Error("must not reverify"); },
    verificationDependencies: {
      ...verificationDependencies(),
      dispatchRepair: repairLifecycle.dispatchRepair,
      awaitRepair: repairLifecycle.awaitRepair
    },
    executorOptions: { jobDir }
  });

  const outcome = await runtime.run({
    jobId: JOB_ID,
    prompt: "work",
    beforeWorkspace: { entries: [] }
  });
  assert.equal(outcome.action, "verification");
  assert.equal(outcome.classification, "passed");
  assert.equal(outcome.recovered, true);
  assert.equal(recordCalls, 1);
  assert.equal(verifierCalls, 0);
  assert.equal(resumeCalls, 0);
});

test("pending bounded repair recovery is forwarded to the sole parent verification pass", async () => {
  const workspace = "/private/recovery-workspace";
  const result = { jobId: JOB_ID, status: "completed", filesChanged: ["src/original.mjs"] };
  const request = {
    jobId: JOB_ID,
    origin: { codexThreadId: "thread-1", cwd: workspace, repoRoot: workspace },
    execution: { canonicalWorkspacePath: workspace },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
  const resumed = {
    repair: { jobId: "ccb_00000000000000000000000002", attempt: 1 },
    failedAttempt: { attempt: 0, passed: false },
    outcome: { status: "completed", filesChanged: ["src/repaired.mjs"] }
  };
  let resumeCalls = 0;
  let verifierCalls = 0;
  const verificationProgress = [];
  const repairLifecycle = {
    async dispatchRepair() { throw new Error("must not redispatch recovered repair"); },
    async awaitRepair() { throw new Error("must not re-await recovered repair"); },
    async resumePendingRepair() { resumeCalls += 1; return structuredClone(resumed); }
  };
  const coordination = {
    async claimSupervisor() { return { acquired: true, leaseToken: "lease" }; },
    async releaseSupervisor() {}, async markStarting() {}, async clearStartingReservation() {},
    async readStartingReservation() { return null; }, async claimCancellation() { return { accepted: false }; },
    async confirmCancellation() {}, async readCancellationClaim() { return null; },
    async claimDelivery() { return { accepted: false }; }, async acknowledgeDelivery() {},
    async failDeliveryToInbox() {}, async readDelivery() { return { state: "pending" }; },
    async readReceipt() {
      return { jobId: JOB_ID, workerState: "completed", verification: { state: "pending" }, delivery: { state: "pending" } };
    },
    async recordVerification() {}, async claimInbox() { return null; },
    async acknowledgeInboxDelivery() {}, async failInboxDelivery() {}
  };
  const runtime = createBridgeRuntime({
    stateApi: {
      getBridgeBrokerAuthority: () => ({ jobId: JOB_ID, token: "authority" }),
      getBridgeJob: () => ({ jobId: JOB_ID, status: "completed", dispatch: null, cancelRequestedAt: null }),
      readBridgeRequest: () => structuredClone(request), readBridgeResult: () => structuredClone(result),
      recordDispatch() {}, transitionBridgeJob() {}, writeBridgeResult() {},
      resolveBridgeJobDir: () => "/private/nonexistent-recovery-job"
    },
    coordination,
    repairLifecycle,
    maxRepairs: 1,
    executorApi: {
      async launchTmuxClaudeWorker() {}, async discover() { return []; },
      async inspectProcess() { return { classification: "dead" }; }
    },
    inboxDrainFn: async () => {},
    supervisorFn: async () => ({ action: "verification-required" }),
    onVerificationProgress: async (progress) => verificationProgress.push(progress),
    verificationFn: async (input, dependencies) => {
      verifierCalls += 1;
      assert.deepEqual(input.resumeRepair, resumed);
      await dependencies.onProgress({ stage: "codex-review", attempt: 1 });
      return { verification: { state: "passed", evidence: ["parent recheck passed"] } };
    },
    verificationDependencies: {
      ...verificationDependencies(),
      dispatchRepair: repairLifecycle.dispatchRepair,
      awaitRepair: repairLifecycle.awaitRepair
    },
    executorOptions: { jobDir: "/private/nonexistent-recovery-job" }
  });

  const outcome = await runtime.run({
    jobId: JOB_ID,
    prompt: "work",
    maxRepairs: 1,
    beforeWorkspace: { entries: [] }
  });
  assert.equal(outcome.classification, "passed");
  assert.equal(resumeCalls, 1);
  assert.equal(verifierCalls, 1);
  assert.deepEqual(verificationProgress, [{ jobId: JOB_ID, stage: "codex-review", attempt: 1 }]);
});

test("default durable coordination records a concrete dispatch before reporting a live worker", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runtime-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const stateOptions = { stateRoot: path.join(base, "state") };
  const jobId = "ccb_00000000000000000000000001";
  const tmuxSession = `ccb-${jobId.slice(-8)}`;
  const claudeSessionId = "00000000-0000-4000-8000-000000000001";
  const origin = {
    codexThreadId: "thread-runtime",
    codexTurnId: null,
    cwd: workspace,
    repoRoot: workspace,
    branch: null,
    head: null
  };
  const request = {
    schemaVersion: 1,
    jobId,
    origin,
    worker: {
      provider: "anthropic",
      model: "user-selected-model",
      agent: "implementer",
      inlineAgents: null,
      customAgentsFile: null,
      pluginDirs: [],
      mcpConfigPaths: [],
      addDirs: [],
      settingSources: [],
      effort: "high",
      resolvedRuntimeVersion: "fixture"
    },
    execution: {
      profile: "standard",
      executor: "tmux",
      tmuxSession,
      workspaceMode: "current",
      requestedWorkspacePath: workspace,
      canonicalWorkspacePath: workspace,
      permittedRoot: workspace,
      claudeSessionId,
      sandboxAttestation: null,
      timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
  createBridgeJob(request, stateOptions);
  const identity = {
    executor: "tmux",
    tmuxSession,
    paneId: "%7",
    panePid: 700,
    workerPid: 701,
    claudeSessionId,
    origin,
    recordedAt: "2026-07-18T12:00:00.000Z"
  };
  const runtime = createBridgeRuntime({
    stateOptions,
    verificationDependencies: verificationDependencies(),
    executorApi: {
      async launchTmuxClaudeWorker(launchOptions) {
        await launchOptions.stateOperations.recordDispatch(jobId, identity);
        return structuredClone(identity);
      },
      async discover() { return [structuredClone(identity)]; },
      async cancel() {}
    },
    processInspector: async () => ({ classification: "live" }),
    normalizeResult: async () => { throw new Error("live worker has no terminal result"); },
    deliveryFn: async () => { throw new Error("live worker is not delivered"); }
  });

  assert.equal(runtime.compatibility.ready, true);
  const outcome = await runtime.run({
    jobId,
    prompt: "Perform the durable task",
    ownerId: "runtime-test"
  });

  assert.equal(outcome.action, "monitoring");
  assert.equal(outcome.classification, "live");
  const durable = getBridgeJob(jobId, stateOptions);
  assert.equal(durable.status, "running");
  assert.deepEqual(durable.dispatch, identity);
});
