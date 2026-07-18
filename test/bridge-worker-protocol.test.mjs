import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_RESULT_MARKER,
  buildBridgeWorkerPrompt,
  normalizeClaudeWorkerResult
} from "../scripts/lib/bridge-worker-protocol.mjs";
import { resolveBridgePolicy } from "../scripts/lib/bridge-policy.mjs";

const JOB_ID = "ccb_01J00000000000000000000000";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function request() {
  const policy = resolveBridgePolicy({ profile: "review-readonly", workspacePath: "/tmp", permittedRoot: "/tmp" });
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    origin: {
      codexThreadId: "thread-1",
      codexTurnId: null,
      cwd: "/tmp/repo",
      repoRoot: "/tmp/repo",
      branch: "main",
      head: "a".repeat(40)
    },
    worker: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      agent: "elite-reviewer",
      inlineAgents: null,
      customAgentsFile: null,
      pluginDirs: [],
      mcpConfigPaths: [],
      addDirs: [],
      settingSources: ["user"],
      effort: "high",
      resolvedRuntimeVersion: "2.1.214"
    },
    execution: {
      profile: "review-readonly",
      executor: "tmux",
      tmuxSession: `ccb-${JOB_ID.slice(4)}`,
      workspaceMode: "current",
      requestedWorkspacePath: "/tmp",
      canonicalWorkspacePath: policy.canonicalWorkspacePath,
      permittedRoot: policy.permittedRoot,
      claudeSessionId: SESSION_ID,
      sandboxAttestation: null,
      timeoutSeconds: 300,
      effectiveClaudePermissionArgs: [...policy.claudeArgs]
    },
    task: { promptFile: "/tmp/prompt.md", acceptance: ["Tests pass"] }
  };
}

function streamFor(report, overrides = {}) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: SESSION_ID,
      result: `${BRIDGE_RESULT_MARKER}\n${JSON.stringify(report)}`,
      ...overrides
    }),
    ""
  ].join("\n");
}

test("worker prompt makes the trust boundary and machine result contract explicit", () => {
  const prompt = buildBridgeWorkerPrompt({ request: request(), userPrompt: "Review the implementation." });
  assert.match(prompt, /review-readonly/);
  assert.match(prompt, /Tests pass/);
  assert.match(prompt, new RegExp(BRIDGE_RESULT_MARKER));
  assert.match(prompt, /Do not claim a command, test, or file change without evidence/);
  assert.doesNotMatch(prompt, /123e4567/);
});

test("normalizer accepts a valid final report but owns identity and artifact paths", () => {
  const report = {
    summary: "Review complete.",
    filesChanged: ["src/a.mjs"],
    commandsRun: [{ command: "npm test", status: "passed", exitCode: 0 }],
    testsRun: [{ command: "npm test", status: "passed", summary: "12 tests passed" }],
    findings: [],
    blockers: []
  };
  const result = normalizeClaudeWorkerResult({
    request: request(),
    stdout: streamFor(report),
    exit: { code: 0, signal: null, cancelled: false, error: null },
    artifactPaths: ["/tmp/job/stdout.jsonl", "/tmp/job/exit.json"]
  });
  assert.equal(result.status, "completed");
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.claudeSessionId, SESSION_ID);
  assert.deepEqual(result.artifactPaths, ["/tmp/job/stdout.jsonl", "/tmp/job/exit.json"]);
  assert.equal(result.commandsRun[0].status, "passed");
});

test("normalizer fails closed on malformed or missing machine report", () => {
  const result = normalizeClaudeWorkerResult({
    request: request(),
    stdout: `${JSON.stringify({ type: "result", session_id: SESSION_ID, result: "Looks good" })}\n`,
    exit: { code: 0, signal: null, cancelled: false, error: null },
    artifactPaths: ["/tmp/job/stdout.jsonl"]
  });
  assert.equal(result.status, "failed");
  assert.match(result.summary, /invalid structured result/i);
  assert.match(result.blockers[0].detail, /marker/i);
});

test("normalizer never upgrades nonzero, error, or cancelled exits", () => {
  const report = { summary: "Done", filesChanged: [], commandsRun: [], testsRun: [], findings: [], blockers: [] };
  const failed = normalizeClaudeWorkerResult({
    request: request(),
    stdout: streamFor(report),
    exit: { code: 2, signal: null, cancelled: false, error: "boom" },
    artifactPaths: []
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.blockers.at(-1).detail, /boom/);

  const cancelled = normalizeClaudeWorkerResult({
    request: request(),
    stdout: streamFor(report),
    exit: { code: null, signal: "SIGTERM", cancelled: true, error: null },
    artifactPaths: []
  });
  assert.equal(cancelled.status, "cancelled");
});

test("normalizer rejects a mismatched Claude session and oversized stream", () => {
  assert.throws(() => normalizeClaudeWorkerResult({
    request: request(),
    stdout: streamFor({ summary: "Done", filesChanged: [], commandsRun: [], testsRun: [], findings: [], blockers: [] }, { session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    exit: { code: 0, signal: null },
    artifactPaths: []
  }), /session/i);
  assert.throws(() => normalizeClaudeWorkerResult({
    request: request(), stdout: "x".repeat(16 * 1024 * 1024 + 1), exit: { code: 0, signal: null }, artifactPaths: []
  }), /quota/i);
});
