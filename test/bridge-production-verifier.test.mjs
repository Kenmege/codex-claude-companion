import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  captureGitWorkspace,
  createProductionBridgeVerificationDependencies,
  runProductionRepositoryChecks
} from "../scripts/lib/bridge-production-verifier.mjs";

function git(workspace, args) {
  const outcome = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-production-verifier-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  git(base, ["init", "--quiet"]);
  return {
    workspace: base,
    request: { execution: { canonicalWorkspacePath: base } }
  };
}

test("workspace capture represents a deleted tracked path deterministically", (t) => {
  const { workspace } = fixture(t);
  const tracked = path.join(workspace, "tracked.txt");
  fs.writeFileSync(tracked, "before\n");
  git(workspace, ["add", "tracked.txt"]);
  fs.unlinkSync(tracked);

  const first = captureGitWorkspace(workspace);
  const second = captureGitWorkspace(workspace);
  const entry = first.entries.find((candidate) => candidate.path === "tracked.txt");

  assert.ok(entry);
  assert.equal(entry.dirty, true);
  assert.match(entry.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(second, first);
});

test("repository checks never execute a post-worker package test script implicitly", (t) => {
  const { workspace, request } = fixture(t);
  const marker = path.join(workspace, "MUTABLE-SCRIPT-WAS-EXECUTED");
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    scripts: { test: `node -e \"require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')\"` }
  }));

  const result = runProductionRepositoryChecks({ request }, { verificationCommands: [] });

  assert.equal(result.passed, false);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(result.evidence.some((line) => line.includes("no origin-supplied command")));
});

test("repository checks execute bounded origin-supplied argv without a shell", (t) => {
  const { request } = fixture(t);

  const result = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[process.execPath, "-e", "process.exit(0)"]]
  });

  assert.equal(result.passed, true);
  assert.ok(result.evidence.some((line) => line.includes(process.execPath)));
});

test("repository verification does not leak the broker auto-recovery guard", (t) => {
  const { request } = fixture(t);
  const guard = "CODEX_CLAUDE_BRIDGE_AUTO_RECOVERY";
  const previous = process.env[guard];
  process.env[guard] = "1";
  t.after(() => {
    if (previous === undefined) delete process.env[guard];
    else process.env[guard] = previous;
  });

  const result = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[
      process.execPath,
      "-e",
      `process.exit(Object.hasOwn(process.env, ${JSON.stringify(guard)}) ? 7 : 0)`
    ]]
  });

  assert.equal(result.passed, true, result.findings.join("\n"));
});

test("repository checks fail closed on an invalid or failing origin command", (t) => {
  const { request } = fixture(t);

  assert.throws(
    () => runProductionRepositoryChecks({ request }, { verificationCommands: [[""]] }),
    /bounded argv arrays/
  );
  const failed = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[process.execPath, "-e", "process.exit(7)"]]
  });
  assert.equal(failed.passed, false);
});

test("repository check failures preserve bounded diagnostics from both stream tails", (t) => {
  const { request } = fixture(t);
  const script = [
    'process.stdout.write("stdout-head\\n" + "o".repeat(3000) + "\\nstdout-tail\\n");',
    'process.stderr.write("stderr-head\\n" + "e".repeat(3000) + "\\nstderr-tail\\n");',
    "process.exit(7);"
  ].join("");

  const failed = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[process.execPath, "-e", script]]
  });

  assert.equal(failed.passed, false);
  assert.equal(failed.findings.length, 1);
  assert.match(failed.findings[0], /stdout-head/);
  assert.match(failed.findings[0], /stdout-tail/);
  assert.match(failed.findings[0], /stderr-head/);
  assert.match(failed.findings[0], /stderr-tail/);
  assert.match(failed.findings[0], /characters omitted/);
  assert.ok(failed.findings[0].length <= 4_500);
});

test("repository check failures retain salient test failures from truncated output", (t) => {
  const { request } = fixture(t);
  const script = [
    'process.stdout.write("head\\n" + "o".repeat(2500) + "\\nnot ok 417 - exact failing lifecycle test\\n" + "z".repeat(2500) + "\\ntail\\n");',
    "process.exit(1);"
  ].join("");

  const failed = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[process.execPath, "-e", script]]
  });

  assert.equal(failed.passed, false);
  assert.match(failed.findings[0], /not ok 417 - exact failing lifecycle test/);
  assert.ok(failed.findings[0].length <= 4_500);
});

test("repository check failures prioritize actual TAP failures over passing failure-named tests", (t) => {
  const { request } = fixture(t);
  const passingNoise = Array.from(
    { length: 80 },
    (_, index) => `ok ${index + 1} - failure recovery scenario ${index + 1}`
  ).join("\n");
  const script = [
    `process.stdout.write(${JSON.stringify(`${passingNoise}\nnot ok 417 - exact failing lifecycle test\n`)});`,
    'process.stdout.write("detail".repeat(1000));',
    "process.exit(1);"
  ].join("");

  const failed = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[process.execPath, "-e", script]]
  });

  assert.equal(failed.passed, false);
  assert.match(failed.findings[0], /not ok 417 - exact failing lifecycle test/);
  assert.ok(failed.findings[0].length <= 4_500);
});

test("repository checks preserve working and staged git diff diagnostics", (t) => {
  const { workspace, request } = fixture(t);
  fs.writeFileSync(path.join(workspace, "working.txt"), "clean\n");
  git(workspace, ["add", "working.txt"]);
  fs.writeFileSync(path.join(workspace, "working.txt"), "working trailing whitespace  \n");
  fs.writeFileSync(path.join(workspace, "staged.txt"), "staged trailing whitespace  \n");
  git(workspace, ["add", "staged.txt"]);

  const failed = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[process.execPath, "-e", "process.exit(0)"]]
  });
  const findings = failed.findings.join("\n");

  assert.equal(failed.passed, false);
  assert.match(findings, /working\.txt/);
  assert.match(findings, /staged\.txt/);
  assert.match(findings, /trailing whitespace/);
});

test("repository checks retain verifier spawn errors", (t) => {
  const { workspace, request } = fixture(t);
  const missing = path.join(workspace, "definitely-missing-verifier");

  const failed = runProductionRepositoryChecks({ request }, {
    verificationCommands: [[missing]]
  });

  assert.equal(failed.passed, false);
  assert.ok(failed.evidence.some((line) => line.includes("exit=error")));
  assert.ok(failed.findings.some((line) => line.includes("ENOENT")));
});

test("production verifier persists immutable attempt evidence before final receipt state", async () => {
  const calls = [];
  const dependencies = createProductionBridgeVerificationDependencies({
    codexBinary: process.execPath,
    verificationCommands: [[process.execPath, "-e", "process.exit(0)"]],
    recordVerificationAttempts: async (jobId, evidence) => calls.push(["attempts", jobId, evidence]),
    recordVerification: async (jobId, verification) => calls.push(["receipt", jobId, verification])
  });
  const payload = {
    jobId: "ccb_00000000000000000000000001",
    verification: { state: "failed", verifiedAt: new Date().toISOString(), evidence: ["failed closed"] },
    attempts: [{ attempt: 0, passed: false }],
    result: { status: "completed" }
  };

  await dependencies.persistVerification(payload);

  assert.deepEqual(calls.map(([kind]) => kind), ["attempts", "receipt"]);
  assert.equal(calls[0][2].attempts[0].attempt, 0);
});

test("production verifier refuses to run without immutable attempt persistence", () => {
  assert.throws(() => createProductionBridgeVerificationDependencies({
    codexBinary: process.execPath,
    recordVerification() {}
  }), /immutable recordVerificationAttempts/);
});

test("production verifier exposes only a paired durable repair lifecycle", () => {
  const dispatchRepair = async () => ({ jobId: "ccb_repair" });
  const awaitRepair = async () => ({ status: "completed" });
  const base = {
    codexBinary: process.execPath,
    recordVerificationAttempts() {},
    recordVerification() {}
  };
  const dependencies = createProductionBridgeVerificationDependencies({
    ...base, dispatchRepair, awaitRepair
  });
  assert.equal(dependencies.dispatchRepair, dispatchRepair);
  assert.equal(dependencies.awaitRepair, awaitRepair);
  assert.throws(
    () => createProductionBridgeVerificationDependencies({ ...base, dispatchRepair }),
    /paired dispatchRepair and awaitRepair/
  );
});

test("production Codex review uses the job timeout, scoped prompt, and live heartbeats", async (t) => {
  const { workspace } = fixture(t);
  const guard = "CODEX_CLAUDE_BRIDGE_AUTO_RECOVERY";
  const previous = process.env[guard];
  process.env[guard] = "1";
  t.after(() => {
    if (previous === undefined) delete process.env[guard];
    else process.env[guard] = previous;
  });
  let observed;
  let heartbeatCount = 0;
  const dependencies = createProductionBridgeVerificationDependencies({
    codexBinary: process.execPath,
    verifierTimeoutMs: 42_000,
    verifierHeartbeatMs: 5,
    onVerifierHeartbeat: ({ attempt }) => {
      assert.equal(attempt, 0);
      heartbeatCount += 1;
    },
    async runProcess(_binary, args, options) {
      observed = { args, options };
      await new Promise((resolve) => setTimeout(resolve, 20));
      const outputFile = args[args.indexOf("--output-last-message") + 1];
      fs.writeFileSync(outputFile, JSON.stringify({
        passed: false,
        evidence: ["repository failure confirmed"],
        findings: ["not ok 417"]
      }));
      return { status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
    recordVerificationAttempts() {},
    recordVerification() {}
  });

  const review = await dependencies.runCodexReview({
    request: {
      execution: { canonicalWorkspacePath: workspace },
      task: { acceptance: ["lifecycle tests pass"] }
    },
    result: { status: "completed", filesChanged: ["scripts/lib/bridge-runtime.mjs"] },
    integrity: {
      changedPaths: ["scripts/lib/bridge-runtime.mjs"],
      unexpectedChanges: [],
      reportedButUnchanged: [],
      preexistingDirty: ["legacy-unrelated.txt"]
    },
    repository: {
      passed: false,
      evidence: ["npm test exit=1"],
      findings: ["not ok 417 - exact failing lifecycle test"]
    },
    attempt: 0
  });

  assert.equal(review.passed, false);
  assert.equal(observed.options.timeout, 42_000);
  assert.equal(observed.options.env[guard], undefined);
  assert.match(observed.options.inputData, /return promptly/i);
  assert.match(observed.options.inputData, /scripts\/lib\/bridge-runtime\.mjs/);
  assert.doesNotMatch(observed.options.inputData, /Inspect the repository and changed files/);
  assert.doesNotMatch(observed.options.inputData, /legacy-unrelated\.txt/);
  assert.ok(heartbeatCount >= 1);
});

test("production verifier rejects verifier timing outside bounded contracts", () => {
  const base = {
    codexBinary: process.execPath,
    recordVerificationAttempts() {},
    recordVerification() {}
  };
  assert.throws(
    () => createProductionBridgeVerificationDependencies({ ...base, verifierTimeoutMs: 29_999 }),
    /verifierTimeoutMs/
  );
  assert.throws(
    () => createProductionBridgeVerificationDependencies({ ...base, verifierHeartbeatMs: 0 }),
    /verifierHeartbeatMs/
  );
});
