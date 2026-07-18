import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeBridgeWorkspaceIntegrity,
  runBridgeVerification
} from "../scripts/lib/bridge-verification.mjs";

const JOB_ID = "ccb_01J00000000000000000000000";

function fixture(overrides = {}) {
  return {
    request: {
      jobId: JOB_ID,
      execution: { canonicalWorkspacePath: "/repo" }
    },
    result: {
      status: "completed",
      filesChanged: ["src/a.mjs"]
    },
    receipt: {
      workerState: "completed",
      verification: { state: "pending" }
    },
    beforeWorkspace: {
      entries: [
        { path: "src/a.mjs", fingerprint: "old", dirty: false },
        { path: "notes.txt", fingerprint: "user", dirty: true }
      ]
    },
    maxRepairs: 0,
    ...overrides
  };
}

function dependencies(overrides = {}) {
  const persisted = [];
  return {
    persisted,
    captureWorkspace: async () => ({
      entries: [
        { path: "src/a.mjs", fingerprint: "new", dirty: true },
        { path: "notes.txt", fingerprint: "user", dirty: true }
      ]
    }),
    runRepositoryChecks: async () => ({ passed: true, evidence: ["npm test exited 0"] }),
    runCodexReview: async () => ({ passed: true, evidence: ["independent diff review passed"] }),
    persistVerification: async (record) => persisted.push(record),
    now: () => "2026-07-18T12:00:00.000Z",
    ...overrides
  };
}

test("workspace integrity surfaces dirty overlap and result drift", () => {
  const report = analyzeBridgeWorkspaceIntegrity({
    before: { entries: [
      { path: "dirty.txt", fingerprint: "a", dirty: true },
      { path: "stable.txt", fingerprint: "s", dirty: false }
    ] },
    after: { entries: [
      { path: "dirty.txt", fingerprint: "b", dirty: true },
      { path: "stable.txt", fingerprint: "s", dirty: false },
      { path: "surprise.txt", fingerprint: "x", dirty: true }
    ] },
    reportedFiles: ["dirty.txt", "phantom.txt"]
  });
  assert.deepEqual(report.overlapWithPreexistingDirty, ["dirty.txt"]);
  assert.deepEqual(report.unexpectedChanges, ["surprise.txt"]);
  assert.deepEqual(report.reportedButUnchanged, ["phantom.txt"]);
  assert.equal(report.passed, false);
});

test("independent repository and Codex evidence are both required", async () => {
  const deps = dependencies();
  const outcome = await runBridgeVerification(fixture(), deps);
  assert.equal(outcome.verification.state, "passed");
  assert.match(outcome.verification.evidence[0], /^repository:/);
  assert.match(outcome.verification.evidence[1], /^codex:/);
  assert.equal(deps.persisted.length, 1);
});

test("verification reports durable stages before repository checks and Codex review", async () => {
  const order = [];
  const deps = dependencies({
    onProgress: async ({ stage, attempt }) => order.push(`progress:${stage}:${attempt}`),
    captureWorkspace: async () => {
      order.push("capture");
      return {
        entries: [
          { path: "src/a.mjs", fingerprint: "new", dirty: true },
          { path: "notes.txt", fingerprint: "user", dirty: true }
        ]
      };
    },
    runRepositoryChecks: async () => {
      order.push("repository");
      return { passed: true, evidence: ["tests passed"] };
    },
    runCodexReview: async () => {
      order.push("codex");
      return { passed: true, evidence: ["review passed"] };
    }
  });

  await runBridgeVerification(fixture(), deps);

  assert.deepEqual(order, [
    "progress:workspace-snapshot:0",
    "capture",
    "progress:repository-checks:0",
    "repository",
    "progress:codex-review:0",
    "codex"
  ]);
});

test("Claude completion assertions cannot substitute for Codex evidence", async () => {
  const deps = dependencies({
    runCodexReview: async () => ({ passed: true, evidence: [] })
  });
  await assert.rejects(runBridgeVerification(fixture(), deps), /non-empty independent evidence/);
  assert.equal(deps.persisted.length, 0);
});

test("workspace drift fails verification even when checks say pass", async () => {
  const deps = dependencies({
    captureWorkspace: async () => ({ entries: [
      { path: "src/a.mjs", fingerprint: "new", dirty: true },
      { path: "notes.txt", fingerprint: "changed-user", dirty: true }
    ] })
  });
  const outcome = await runBridgeVerification(fixture(), deps);
  assert.equal(outcome.verification.state, "failed");
  assert.deepEqual(outcome.attempts[0].integrity.unexpectedChanges, ["notes.txt"]);
});

test("one bounded repair is independently retested and rereviewed", async () => {
  let checks = 0;
  let reviews = 0;
  let repairs = 0;
  const deps = dependencies({
    runRepositoryChecks: async () => {
      checks += 1;
      return { passed: checks > 1, evidence: [`test pass ${checks}`] };
    },
    runCodexReview: async () => {
      reviews += 1;
      return { passed: reviews > 1, evidence: [`review pass ${reviews}`] };
    },
    dispatchRepair: async () => {
      repairs += 1;
      return { jobId: "ccb_repair" };
    },
    awaitRepair: async () => ({ status: "completed", filesChanged: ["src/a.mjs"] })
  });
  const outcome = await runBridgeVerification(fixture({ maxRepairs: 1 }), deps);
  assert.equal(outcome.verification.state, "passed");
  assert.equal(outcome.attempts.length, 2);
  assert.equal(repairs, 1);
  assert.equal(checks, 2);
  assert.equal(reviews, 2);
});

test("failed repair terminates verification without a second repair", async () => {
  let repairs = 0;
  const deps = dependencies({
    runRepositoryChecks: async () => ({ passed: false, evidence: ["tests failed"] }),
    runCodexReview: async () => ({ passed: false, evidence: ["defect found"] }),
    dispatchRepair: async () => {
      repairs += 1;
      return { jobId: "ccb_repair" };
    },
    awaitRepair: async () => ({ status: "failed", filesChanged: [] })
  });
  const outcome = await runBridgeVerification(fixture({ maxRepairs: 1 }), deps);
  assert.equal(outcome.verification.state, "failed");
  assert.equal(repairs, 1);
  assert.match(outcome.verification.evidence.at(-1), /ccb_repair:failed/);
});

test("durable repair resume skips the failed first check and preserves the parent result scope", async () => {
  let checks = 0;
  let dispatches = 0;
  const deps = dependencies({
    captureWorkspace: async () => ({ entries: [
      { path: "src/a.mjs", fingerprint: "new", dirty: true },
      { path: "src/repair.mjs", fingerprint: "added", dirty: true },
      { path: "notes.txt", fingerprint: "user", dirty: true }
    ] }),
    runRepositoryChecks: async () => {
      checks += 1;
      return { passed: true, evidence: ["repaired tests pass"] };
    },
    runCodexReview: async () => ({ passed: true, evidence: ["repair independently reviewed"] }),
    dispatchRepair: async () => { dispatches += 1; return { jobId: "must-not-dispatch" }; },
    awaitRepair: async () => { throw new Error("must not await a second repair"); }
  });
  const failedAttempt = {
    attempt: 0,
    passed: false,
    repository: { source: "repository", passed: false, evidence: ["tests failed"], findings: [] },
    codex: { source: "codex", passed: false, evidence: ["defect found"], findings: [] },
    integrity: {
      changedPaths: ["src/a.mjs"], preexistingDirty: ["notes.txt"],
      overlapWithPreexistingDirty: [], unexpectedChanges: [], reportedButUnchanged: [], passed: true
    }
  };
  const outcome = await runBridgeVerification(fixture({
    maxRepairs: 1,
    resumeRepair: {
      repair: { jobId: "ccb_repair", attempt: 1 },
      failedAttempt,
      outcome: { status: "completed", filesChanged: ["src/repair.mjs"] }
    }
  }), deps);

  assert.equal(outcome.verification.state, "passed");
  assert.equal(checks, 1);
  assert.equal(dispatches, 0);
  assert.deepEqual(outcome.result.filesChanged, ["src/a.mjs", "src/repair.mjs"]);
  assert.equal(outcome.result.boundedRepair.jobId, "ccb_repair");
  assert.equal(outcome.attempts.length, 2);
  assert.equal(outcome.attempts[0].repair.status, "completed");
});

test("durably resumed failed repair finalizes without rerunning or redispatching", async () => {
  let checks = 0;
  let dispatches = 0;
  const deps = dependencies({
    runRepositoryChecks: async () => { checks += 1; return { passed: true, evidence: ["unexpected"] }; },
    dispatchRepair: async () => { dispatches += 1; return { jobId: "unexpected" }; },
    awaitRepair: async () => { throw new Error("unexpected"); }
  });
  const failedAttempt = {
    attempt: 0,
    passed: false,
    repository: { source: "repository", passed: false, evidence: ["tests failed"], findings: [] },
    codex: { source: "codex", passed: false, evidence: ["defect found"], findings: [] },
    integrity: {
      changedPaths: ["src/a.mjs"], preexistingDirty: [], overlapWithPreexistingDirty: [],
      unexpectedChanges: [], reportedButUnchanged: [], passed: true
    }
  };
  const outcome = await runBridgeVerification(fixture({
    maxRepairs: 1,
    resumeRepair: {
      repair: { jobId: "ccb_repair", attempt: 1 },
      failedAttempt,
      outcome: { status: "failed", filesChanged: [] }
    }
  }), deps);
  assert.equal(outcome.verification.state, "failed");
  assert.equal(checks, 0);
  assert.equal(dispatches, 0);
  assert.match(outcome.verification.evidence.at(-1), /ccb_repair:failed/);
});

test("non-completed results and unbounded repair counts fail closed", async () => {
  await assert.rejects(
    runBridgeVerification(fixture({ result: { status: "failed", filesChanged: [] } }), dependencies()),
    /completed Claude worker result/
  );
  await assert.rejects(
    runBridgeVerification(fixture({ maxRepairs: 2 }), dependencies()),
    /maxRepairs must be 0 or 1/
  );
});
