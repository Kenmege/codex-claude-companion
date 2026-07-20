const TERMINAL_WORKER_STATES = new Set(["completed", "failed", "cancelled"]);

function requireFunction(dependencies, name) {
  if (typeof dependencies[name] !== "function") {
    throw new TypeError(`Bridge verification requires dependency ${name}().`);
  }
  return dependencies[name];
}

async function reportProgress(dependencies, stage, attempt) {
  if (dependencies.onProgress == null) return;
  if (typeof dependencies.onProgress !== "function") {
    throw new TypeError("Bridge verification onProgress must be a function.");
  }
  await dependencies.onProgress(Object.freeze({ stage, attempt }));
}

function normalizeEvidence(source, value) {
  if (!value || typeof value !== "object" || typeof value.passed !== "boolean") {
    throw new TypeError(`${source} verification must return { passed, evidence }.`);
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (evidence.length === 0) {
    throw new TypeError(`${source} verification must return non-empty independent evidence.`);
  }
  return {
    source,
    passed: value.passed,
    evidence,
    findings: Array.isArray(value.findings) ? structuredClone(value.findings) : []
  };
}

function snapshotEntries(snapshot, label) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.entries)) {
    throw new TypeError(`${label} workspace snapshot must contain an entries array.`);
  }
  const entries = new Map();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      throw new TypeError(`${label} workspace snapshot entries require a path.`);
    }
    if (entries.has(entry.path)) {
      throw new TypeError(`${label} workspace snapshot contains duplicate path ${entry.path}.`);
    }
    entries.set(entry.path, {
      fingerprint: entry.fingerprint ?? null,
      dirty: Boolean(entry.dirty)
    });
  }
  return entries;
}

export function analyzeBridgeWorkspaceIntegrity({ before, after, reportedFiles = [] }) {
  const baseline = snapshotEntries(before, "Before");
  const current = snapshotEntries(after, "After");
  const reported = new Set(reportedFiles);
  const allPaths = new Set([...baseline.keys(), ...current.keys()]);
  const changedPaths = [...allPaths].filter((filePath) => {
    const earlier = baseline.get(filePath);
    const later = current.get(filePath);
    return !earlier || !later || earlier.fingerprint !== later.fingerprint;
  }).sort();
  const preexistingDirty = [...baseline.entries()]
    .filter(([, entry]) => entry.dirty)
    .map(([filePath]) => filePath)
    .sort();
  const overlapWithPreexistingDirty = changedPaths.filter((filePath) => baseline.get(filePath)?.dirty);
  const unexpectedChanges = changedPaths.filter((filePath) => !reported.has(filePath));
  const reportedButUnchanged = [...reported].filter((filePath) => !changedPaths.includes(filePath)).sort();
  return Object.freeze({
    changedPaths,
    preexistingDirty,
    overlapWithPreexistingDirty,
    unexpectedChanges,
    reportedButUnchanged,
    passed: unexpectedChanges.length === 0 && reportedButUnchanged.length === 0
  });
}

function assertVerifiableInput(input) {
  if (!input || typeof input !== "object") throw new TypeError("Bridge verification input is required.");
  if (input.result?.status !== "completed") {
    throw new Error("Only a completed Claude worker result can enter Codex verification.");
  }
  if (input.receipt?.workerState !== "completed") {
    throw new Error("Receipt workerState must be completed before Codex verification.");
  }
  if (input.receipt?.verification?.state !== "pending") {
    throw new Error("Codex verification may only claim a pending verification receipt.");
  }
  if (!input.beforeWorkspace) {
    throw new Error("A pre-dispatch workspace snapshot is required for verification.");
  }
}

function buildEvidence(repository, codex, integrity, attempt) {
  return [
    ...repository.evidence.map((item) => `repository:${item}`),
    ...codex.evidence.map((item) => `codex:${item}`),
    `workspace:changed=${integrity.changedPaths.length};unexpected=${integrity.unexpectedChanges.length};preexisting-overlap=${integrity.overlapWithPreexistingDirty.length}`,
    `repair-attempt:${attempt}`
  ];
}

function mergeRepairResult(parentResult, repairOutcome, repairJobId) {
  const filesChanged = [...new Set([
    ...(Array.isArray(parentResult.filesChanged) ? parentResult.filesChanged : []),
    ...(Array.isArray(repairOutcome.filesChanged) ? repairOutcome.filesChanged : [])
  ])].sort();
  return {
    ...structuredClone(parentResult),
    status: "completed",
    filesChanged,
    boundedRepair: {
      jobId: repairJobId,
      status: repairOutcome.status
    }
  };
}

function assertResumeRepair(value, parentJobId) {
  if (!value || typeof value !== "object" || value.repair?.attempt !== 1 ||
      typeof value.repair.jobId !== "string" || value.repair.jobId.length === 0 ||
      value.failedAttempt?.attempt !== 0 || value.failedAttempt?.passed !== false ||
      !value.outcome || !TERMINAL_WORKER_STATES.has(value.outcome.status)) {
    throw new Error(`Invalid durable repair resume evidence for ${parentJobId}.`);
  }
  return structuredClone(value);
}

/**
 * Run an independent Codex-owned verification loop. Claude's result is input
 * evidence, never verification authority. All side effects are injected so the
 * broker can wrap them in its own durable lease and authority checks.
 */
export async function runBridgeVerification(input, dependencies = {}) {
  assertVerifiableInput(input);
  const captureWorkspace = requireFunction(dependencies, "captureWorkspace");
  const runRepositoryChecks = requireFunction(dependencies, "runRepositoryChecks");
  const runCodexReview = requireFunction(dependencies, "runCodexReview");
  const persistVerification = requireFunction(dependencies, "persistVerification");
  const maxRepairs = input.maxRepairs ?? 0;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 1) {
    throw new RangeError("maxRepairs must be 0 or 1 for the bounded bridge verifier.");
  }
  if (maxRepairs > 0) {
    requireFunction(dependencies, "dispatchRepair");
    requireFunction(dependencies, "awaitRepair");
  }

  let result = structuredClone(input.result);
  const attempts = [];
  let firstAttempt = 0;
  if (input.resumeRepair != null) {
    if (maxRepairs !== 1) throw new Error("Repair resume requires maxRepairs=1.");
    const resumed = assertResumeRepair(input.resumeRepair, input.request.jobId);
    attempts.push({
      ...resumed.failedAttempt,
      repair: { jobId: resumed.repair.jobId, status: resumed.outcome.status }
    });
    if (resumed.outcome.status !== "completed") {
      const failed = resumed.failedAttempt;
      const verification = {
        state: "failed",
        verifiedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
        evidence: [
          ...buildEvidence(failed.repository, failed.codex, failed.integrity, 0),
          `repair:${resumed.repair.jobId}:${resumed.outcome.status}`
        ]
      };
      await persistVerification({
        jobId: input.request.jobId,
        verification,
        attempts: structuredClone(attempts),
        result
      });
      return Object.freeze({ verification, attempts: Object.freeze(attempts), result });
    }
    result = mergeRepairResult(result, resumed.outcome, resumed.repair.jobId);
    firstAttempt = 1;
  }

  for (let attempt = firstAttempt; attempt <= maxRepairs; attempt += 1) {
    await reportProgress(dependencies, "workspace-snapshot", attempt);
    const afterWorkspace = await captureWorkspace(input.request.execution.canonicalWorkspacePath);
    const integrity = analyzeBridgeWorkspaceIntegrity({
      before: input.beforeWorkspace,
      after: afterWorkspace,
      reportedFiles: result.filesChanged
    });
    await reportProgress(dependencies, "repository-checks", attempt);
    const repository = normalizeEvidence(
      "repository",
      await runRepositoryChecks({ request: input.request, result, integrity, attempt })
    );
    await reportProgress(dependencies, "codex-review", attempt);
    const codex = normalizeEvidence(
      "codex",
      await runCodexReview({ request: input.request, result, integrity, repository, attempt })
    );
    const passed = repository.passed && codex.passed && integrity.passed;
    let record = Object.freeze({ attempt, passed, repository, codex, integrity });
    attempts.push(record);

    if (passed || attempt === maxRepairs) {
      const verification = {
        state: passed ? "passed" : "failed",
        verifiedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
        evidence: buildEvidence(repository, codex, integrity, attempt)
      };
      await persistVerification({
        jobId: input.request.jobId,
        verification,
        attempts: structuredClone(attempts),
        result
      });
      return Object.freeze({ verification, attempts: Object.freeze(attempts), result });
    }

    const repair = await dependencies.dispatchRepair({
      parentJobId: input.request.jobId,
      request: input.request,
      failedAttempt: record,
      maxRepairs
    });
    if (!repair || typeof repair.jobId !== "string" || repair.jobId.length === 0) {
      throw new Error("Repair dispatch did not return a correlated jobId.");
    }
    const repairOutcome = await dependencies.awaitRepair(repair.jobId);
    if (!repairOutcome || !TERMINAL_WORKER_STATES.has(repairOutcome.status)) {
      throw new Error("Repair job did not return a terminal worker result.");
    }
    record = Object.freeze({
      ...record,
      repair: { jobId: repair.jobId, status: repairOutcome.status }
    });
    attempts[attempts.length - 1] = record;
    if (repairOutcome.status !== "completed") {
      const verification = {
        state: "failed",
        verifiedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
        evidence: [
          ...buildEvidence(repository, codex, integrity, attempt),
          `repair:${repair.jobId}:${repairOutcome.status}`
        ]
      };
      await persistVerification({
        jobId: input.request.jobId,
        verification,
        attempts: structuredClone(attempts),
        result
      });
      return Object.freeze({ verification, attempts: Object.freeze(attempts), result });
    }
    result = mergeRepairResult(result, repairOutcome, repair.jobId);
  }
  throw new Error("Bridge verification exhausted unexpectedly.");
}
