import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProductionBridgeRepairLifecycle,
  discoverBrokerProcess
} from "../scripts/lib/bridge-repair.mjs";

const PARENT_ID = "ccb_00000000000000000000000001";
const CHILD_ID = "ccb_00000000000000000000000002";

function harness(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-repair-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  const parentDir = path.join(stateRoot, "jobs", PARENT_ID);
  const childDir = path.join(stateRoot, "jobs", CHILD_ID);
  fs.mkdirSync(path.join(parentDir, "runtime"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace);
  const parentRequest = {
    jobId: PARENT_ID,
    origin: {
      codexThreadId: "thread-1", codexTurnId: "turn-1", cwd: workspace,
      repoRoot: workspace, branch: "main", head: "abc"
    },
    worker: {
      model: "claude-opus", effort: "high", agent: "implementer",
      inlineAgents: { implementer: { description: "Repair implementer", prompt: "Repair only verified findings." } },
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [],
      settingSources: [], resolvedRuntimeVersion: "fixture"
    },
    execution: {
      profile: "trusted-autonomous", canonicalWorkspacePath: workspace,
      permittedRoot: workspace, timeoutSeconds: 30
    }
  };
  const childRequest = {
    jobId: CHILD_ID,
    execution: { canonicalWorkspacePath: workspace }
  };
  let childState = { jobId: CHILD_ID, status: "accepted", terminalAt: null };
  let childResult = null;
  let created = 0;
  let spawned = 0;
  let capabilityToken = null;
  let persistedSpec = null;
  let discoveredBrokerPid = null;
  let builtRequestInput = null;
  const stateApi = {
    readBridgeRequest(jobId) {
      if (jobId === PARENT_ID) return structuredClone(parentRequest);
      if (jobId === CHILD_ID && fs.existsSync(childDir)) return structuredClone(childRequest);
      throw new Error("missing request");
    },
    resolveBridgeJobDir(jobId) { return path.join(stateRoot, "jobs", jobId); },
    createBridgeJob(request, options) {
      created += 1;
      capabilityToken = options.capabilityToken;
      assert.equal(request.jobId, CHILD_ID);
      fs.mkdirSync(path.join(childDir, "runtime"), { recursive: true, mode: 0o700 });
    },
    getBridgeJob(jobId) {
      assert.equal(jobId, CHILD_ID);
      return structuredClone(childState);
    },
    readBridgeResult(jobId) {
      assert.equal(jobId, CHILD_ID);
      return structuredClone(childResult);
    },
    redactBridgeValue(value) { return value; }
  };
  const parentSpec = {
    jobId: PARENT_ID,
    stateRoot,
    jobDir: parentDir,
    maxRepairs: 1,
    tmuxBinary: "/usr/bin/tmux",
    claudeBinary: "/usr/bin/claude",
    codexBinary: "/usr/bin/codex",
    nodeBinary: process.execPath,
    envBinary: "/usr/bin/env",
    intervalMs: 100,
    verificationCommands: [[process.execPath, "--version"]]
  };
  const options = {
    parentSpec,
    stateApi,
    buildRequest: (input) => {
      builtRequestInput = structuredClone(input);
      return structuredClone(childRequest);
    },
    buildPrompt: ({ userPrompt }) => userPrompt,
    persistBrokerSpec(file, spec) {
      persistedSpec = structuredClone(spec);
      fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600, flag: "wx" });
    },
    spawnDetached(binary, args) {
      spawned += 1;
      assert.equal(binary, process.execPath);
      assert.equal(args[0].endsWith("bridge-broker.mjs"), true);
      discoveredBrokerPid = 777;
      return 777;
    },
    processAlive: (pid) => pid === 777,
    discoverBrokerPid: () => discoveredBrokerPid,
    sleep: async () => {}
  };
  return {
    base, parentDir, childDir, options,
    counts: () => ({ created, spawned }),
    builtRequestInput: () => structuredClone(builtRequestInput),
    capability: () => capabilityToken,
    spec: () => persistedSpec,
    discoverSpawnedBroker() { discoveredBrokerPid = 777; },
    complete() {
      childState = { jobId: CHILD_ID, status: "completed", terminalAt: "2026-07-18T12:00:00.000Z" };
      childResult = { jobId: CHILD_ID, status: "completed", filesChanged: ["src/repaired.mjs"] };
    }
  };
}

test("bounded repair precommits isolated authority and an immutable parent-child correlation", async (t) => {
  const h = harness(t);
  const lifecycle = createProductionBridgeRepairLifecycle(h.options);
  const failedAttempt = {
    attempt: 0, passed: false,
    repository: { passed: false, evidence: ["tests failed"] },
    codex: { passed: false, evidence: ["defect"] },
    integrity: { changedPaths: [], unexpectedChanges: [], overlapWithPreexistingDirty: [] }
  };

  const first = await lifecycle.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  const second = await lifecycle.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  assert.deepEqual(first, { jobId: CHILD_ID, attempt: 1 });
  assert.deepEqual(second, first);
  assert.deepEqual(h.counts(), { created: 1, spawned: 1 });
  assert.match(h.capability(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(h.spec().workerCapabilityToken, h.capability());
  assert.deepEqual(h.spec().internalRepair, { parentJobId: PARENT_ID, attempt: 1 });
  assert.equal(h.spec().maxRepairs, 0);
  assert.equal(h.builtRequestInput().agent, "implementer");
  assert.deepEqual(h.builtRequestInput().agents, {
    implementer: { description: "Repair implementer", prompt: "Repair only verified findings." }
  });

  const correlationFile = path.join(h.parentDir, "runtime", "repair-attempt-1.json");
  const before = fs.readFileSync(correlationFile, "utf8");
  const correlation = JSON.parse(before);
  assert.equal(correlation.authorityBoundary, "child-job-bound-capability; parent broker authority not delegated");
  assert.equal(correlation.childJobId, CHILD_ID);
  assert.equal(correlation.capabilityToken, h.capability());
  assert.equal(fs.existsSync(path.join(h.parentDir, "runtime", "repair-attempt-1.capability")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(correlationFile).mode & 0o077, 0);

  h.complete();
  const outcome = await lifecycle.awaitRepair(CHILD_ID);
  assert.equal(outcome.status, "completed");
  assert.equal(fs.readFileSync(correlationFile, "utf8"), before);
  const progress = JSON.parse(fs.readFileSync(
    path.join(h.parentDir, "runtime", "repair-attempt-1-state.json"), "utf8"
  ));
  assert.equal(progress.phase, "terminal");
});

test("parent broker crash recovery resumes the same repair without a second child", async (t) => {
  const h = harness(t);
  const failedAttempt = {
    attempt: 0, passed: false,
    repository: { passed: false, evidence: ["tests failed"] },
    codex: { passed: false, evidence: ["defect"] },
    integrity: { changedPaths: [], unexpectedChanges: [], overlapWithPreexistingDirty: [] }
  };
  const firstLifecycle = createProductionBridgeRepairLifecycle(h.options);
  await firstLifecycle.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  h.complete();

  const resumedLifecycle = createProductionBridgeRepairLifecycle({
    ...h.options,
    processAlive: () => false,
    discoverBrokerPid: () => null
  });
  const resumed = await resumedLifecycle.resumePendingRepair();
  assert.equal(resumed.repair.jobId, CHILD_ID);
  assert.equal(resumed.repair.attempt, 1);
  assert.equal(resumed.failedAttempt.attempt, 0);
  assert.equal(resumed.outcome.status, "completed");
  assert.deepEqual(h.counts(), { created: 1, spawned: 1 });
});

test("crash after the single prepare envelope resumes its exact child authority", async (t) => {
  const h = harness(t);
  const failedAttempt = {
    attempt: 0, passed: false,
    repository: { passed: false, evidence: ["tests failed"] },
    codex: { passed: false, evidence: ["defect"] },
    integrity: { changedPaths: [], unexpectedChanges: [], overlapWithPreexistingDirty: [] }
  };
  const crashed = createProductionBridgeRepairLifecycle({
    ...h.options,
    afterPreparePersist() { throw new Error("fault: crash after prepare envelope"); }
  });
  await assert.rejects(
    crashed.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt }),
    /fault: crash after prepare envelope/
  );
  const envelopeFile = path.join(h.parentDir, "runtime", "repair-attempt-1.json");
  const envelope = JSON.parse(fs.readFileSync(envelopeFile, "utf8"));
  assert.equal(envelope.childJobId, CHILD_ID);
  assert.match(envelope.capabilityToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(h.counts(), { created: 0, spawned: 0 });

  const resumed = createProductionBridgeRepairLifecycle(h.options);
  const repair = await resumed.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  assert.deepEqual(repair, { jobId: CHILD_ID, attempt: 1 });
  assert.equal(h.capability(), envelope.capabilityToken);
  assert.deepEqual(h.counts(), { created: 1, spawned: 1 });
});

test("crash after broker spawn reconciles the exact process before heartbeat without spawning twice", async (t) => {
  const h = harness(t);
  const failedAttempt = {
    attempt: 0, passed: false,
    repository: { passed: false, evidence: ["tests failed"] },
    codex: { passed: false, evidence: ["defect"] },
    integrity: { changedPaths: [], unexpectedChanges: [], overlapWithPreexistingDirty: [] }
  };
  const crashed = createProductionBridgeRepairLifecycle({
    ...h.options,
    afterBrokerSpawn() { throw new Error("fault: crash after broker spawn"); }
  });
  await assert.rejects(
    crashed.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt }),
    /fault: crash after broker spawn/
  );
  const progressFile = path.join(h.parentDir, "runtime", "repair-attempt-1-state.json");
  const reserved = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  assert.equal(reserved.phase, "spawn-reserved");
  assert.match(reserved.launchReservation, /^[a-f0-9-]{36}$/);
  assert.deepEqual(h.counts(), { created: 1, spawned: 1 });

  h.discoverSpawnedBroker();
  const resumed = createProductionBridgeRepairLifecycle(h.options);
  const repair = await resumed.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  assert.deepEqual(repair, { jobId: CHILD_ID, attempt: 1 });
  assert.deepEqual(h.counts(), { created: 1, spawned: 1 });
  const reconciled = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  assert.equal(reconciled.phase, "dispatched");
  assert.equal(reconciled.brokerPid, 777);
});

test("a live reused persisted PID is ignored unless exact process discovery proves its broker argv", async (t) => {
  const h = harness(t);
  const failedAttempt = {
    attempt: 0, passed: false,
    repository: { passed: false, evidence: ["tests failed"] },
    codex: { passed: false, evidence: ["defect"] },
    integrity: { changedPaths: [], unexpectedChanges: [], overlapWithPreexistingDirty: [] }
  };
  const first = createProductionBridgeRepairLifecycle(h.options);
  await first.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  assert.deepEqual(h.counts(), { created: 1, spawned: 1 });

  const resumed = createProductionBridgeRepairLifecycle({
    ...h.options,
    processAlive: (pid) => pid === 666 || pid === 777,
    discoverBrokerPid: () => null
  });
  fs.writeFileSync(path.join(h.childDir, "broker-heartbeat.json"), JSON.stringify({ brokerPid: 666 }), {
    mode: 0o600
  });
  await resumed.dispatchRepair({ parentJobId: PARENT_ID, failedAttempt });
  assert.deepEqual(h.counts(), { created: 1, spawned: 2 });
});

test("broker process discovery requires an exact command and fails closed on ambiguity", () => {
  const nodeBinary = "/opt/node/bin/node";
  const brokerScript = "/repo/scripts/bridge-broker.mjs";
  const specFile = "/state/jobs/child/broker-spec.json";
  const exact = `${nodeBinary} ${brokerScript} --spec ${specFile}`;
  const listing = (stdout, status = 0) => () => ({ status, stdout, stderr: "" });

  assert.equal(discoverBrokerProcess(
    nodeBinary, brokerScript, specFile,
    listing(`  101 wrapper --label '${brokerScript} --spec ${specFile}'\n`)
  ), null);
  assert.equal(discoverBrokerProcess(
    nodeBinary, brokerScript, specFile,
    listing(`  102 ${exact} --extra\n`)
  ), null);
  assert.equal(discoverBrokerProcess(
    nodeBinary, brokerScript, specFile,
    listing(`  103 ${exact}\n`)
  ), 103);
  assert.throws(
    () => discoverBrokerProcess(
      nodeBinary, brokerScript, specFile,
      listing(`  104 ${exact}\n  105 ${exact}\n`)
    ),
    /multiple repair brokers match durable spec/
  );
  assert.throws(
    () => discoverBrokerProcess(nodeBinary, brokerScript, specFile, listing("", 1)),
    /unable to inspect process identities/
  );
});
