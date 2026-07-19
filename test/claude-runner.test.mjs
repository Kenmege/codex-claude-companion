import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClaudeRunnerArgs,
  progressFromClaudeLine,
  questionsFromClaudeLine,
  runClaudeWorker
} from "../scripts/lib/claude-runner.mjs";
import { enqueueBridgeInput, readBridgeInputAck } from "../scripts/lib/bridge-input.mjs";

const WORKER_CAPABILITY = "w".repeat(43);
const RUNNER_PATH = fileURLToPath(new URL("../scripts/lib/claude-runner.mjs", import.meta.url));

function request(workspace) {
  return {
    schemaVersion: 1,
    jobId: "ccb_00000000000000000000000001",
    origin: {
      codexThreadId: "thread-1", codexTurnId: "turn-1", cwd: workspace,
      repoRoot: workspace, branch: "main", head: "a".repeat(40)
    },
    worker: {
      provider: "anthropic", model: "opus", agent: "implementer",
      inlineAgents: { implementer: { description: "Implement", prompt: "Do the work" } },
      customAgentsFile: null, pluginDirs: [path.join(workspace, "plugin one")],
      mcpConfigPaths: [path.join(workspace, "mcp.json")], addDirs: [path.join(workspace, "extra")],
      settingSources: ["user", "project"], effort: "xhigh", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "trusted-autonomous", executor: "tmux", tmuxSession: "ccb-runner-test",
      workspaceMode: "current", requestedWorkspacePath: workspace, canonicalWorkspacePath: workspace,
      permittedRoot: workspace, claudeSessionId: "00000000-0000-4000-8000-000000000001",
      sandboxAttestation: null, timeoutSeconds: 30,
      effectiveClaudePermissionArgs: ["--setting-sources=user,project", "--permission-mode", "bypassPermissions"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] }
  };
}

function privateEnvironmentFile(base, values = { PATH: process.env.PATH ?? "" }) {
  const file = path.join(base, "environment.json");
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  return file;
}

function privateRuntimeDir(base) {
  const runtimeDir = path.join(base, "job", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  return runtimeDir;
}

test("runner builds exact argv while keeping the prompt out of argv", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-"));
  const value = request(workspace);
  const args = buildClaudeRunnerArgs(value);

  assert.deepEqual(args, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--replay-user-messages",
    "--session-id", value.execution.claudeSessionId,
    "--model", "opus", "--effort", "xhigh",
    "--agent", "implementer",
    "--agents", JSON.stringify(value.worker.inlineAgents),
    "--plugin-dir", path.join(workspace, "plugin one"),
    "--mcp-config", path.join(workspace, "mcp.json"),
    "--add-dir", path.join(workspace, "extra"),
    "--setting-sources=user,project",
    "--permission-mode", "bypassPermissions"
  ]);
  assert.equal(args.includes(value.task.promptFile), false);
});

test("runner extracts bounded redacted AskUserQuestion events only from the authoritative session", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-question-"));
  const value = request(workspace);
  const line = JSON.stringify({
    type: "assistant",
    session_id: value.execution.claudeSessionId,
    message: { content: [{
      type: "tool_use",
      name: "AskUserQuestion",
      id: "toolu_question_1",
      input: { questions: [{ question: "Use token=super-secret or continue safely?" }] }
    }] }
  });

  assert.deepEqual(questionsFromClaudeLine(line, value), [{
    questionId: "toolu_question_1",
    text: "Use token=[REDACTED] or continue safely?"
  }]);
  assert.deepEqual(questionsFromClaudeLine(line.replace(value.execution.claudeSessionId, crypto.randomUUID()), value), []);
});

test("runner extracts bounded redacted progress from authoritative assistant text and tool use", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-progress-"));
  const value = request(workspace);
  const line = JSON.stringify({
    type: "assistant",
    session_id: value.execution.claudeSessionId,
    message: { content: [
      { type: "text", text: "Checking token=super-secret before validation." },
      { type: "tool_use", name: "Bash", id: "toolu_progress_1", input: { command: "npm test" } },
      { type: "tool_use", name: "AskUserQuestion", id: "toolu_question_2", input: { question: "Continue?" } }
    ] }
  });

  assert.deepEqual(progressFromClaudeLine(line, value).map(({ message }) => message), [
    "Checking token=[REDACTED] before validation.",
    "Claude invoked Bash"
  ]);
  assert.deepEqual(progressFromClaudeLine(line.replace(value.execution.claudeSessionId, crypto.randomUUID()), value), []);
});

test("runner streams a private prompt on stdin and normalizes logs, heartbeat, and exit", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-life-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  const requestFile = path.join(privateRuntimeDir(base), "request.json");
  const promptFile = path.join(base, "prompt.txt");
  const capturedPrompt = path.join(base, "captured-prompt.txt");
  const fakeClaude = path.join(base, "fake-claude");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "durable private prompt", { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nIFS= read -r line\nprintf '%s' "$line" > '${capturedPrompt}'\nprintf 'worker-out\\n'\nprintf 'worker-err\\n' >&2\nsleep 0.15\nexit 7\n`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, claudeBinary: fakeClaude, environmentFile: privateEnvironmentFile(base),
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(base, "identity.json"), heartbeatFile: path.join(base, "heartbeat.json"),
    exitFile: path.join(base, "exit.json"), stdoutFile: path.join(base, "stdout.log"),
    stderrFile: path.join(base, "stderr.log"), heartbeatIntervalMs: 20
  };

  const result = await runClaudeWorker(spec);

  assert.equal(JSON.parse(fs.readFileSync(capturedPrompt, "utf8")).message.content.endsWith("\ndurable private prompt"), true);
  assert.equal(fs.readFileSync(spec.stdoutFile, "utf8"), "worker-out\n");
  assert.equal(fs.readFileSync(spec.stderrFile, "utf8"), "worker-err\n");
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(JSON.parse(fs.readFileSync(spec.identityFile)).claudeSessionId, value.execution.claudeSessionId);
  assert.ok(JSON.parse(fs.readFileSync(spec.heartbeatFile)).claudePid > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(spec.exitFile)), result);
  for (const file of [spec.identityFile, spec.heartbeatFile, spec.exitFile, spec.stdoutFile, spec.stderrFile]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(WORKER_CAPABILITY));
  }
});

test("runner timeout terminates the complete Claude process tree before returning", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-timeout-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  value.execution.timeoutSeconds = 1;
  const requestFile = path.join(privateRuntimeDir(base), "request.json");
  const promptFile = path.join(base, "prompt.txt");
  const descendantPidFile = path.join(base, "descendant.pid");
  const fakeClaude = path.join(base, "fake-claude");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "timeout probe", { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nsleep 30 &\necho $! > '${descendantPidFile}'\nwait\n`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, claudeBinary: fakeClaude, environmentFile: privateEnvironmentFile(base),
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(base, "identity.json"), heartbeatFile: path.join(base, "heartbeat.json"),
    exitFile: path.join(base, "exit.json"), stdoutFile: path.join(base, "stdout.log"),
    stderrFile: path.join(base, "stderr.log"), heartbeatIntervalMs: 20, timeoutGraceMs: 100
  };

  const result = await runClaudeWorker(spec);
  const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8").trim());
  let descendantAlive = true;
  try {
    process.kill(descendantPid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") descendantAlive = false;
    else throw error;
  }
  if (descendantAlive) process.kill(descendantPid, "SIGKILL");

  assert.equal(result.timedOut, true);
  assert.equal(descendantAlive, false, "timeout returned while a Claude descendant was still alive");
});

test("runner cancellation terminates and verifies its complete detached Claude process tree", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-cancel-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  const requestFile = path.join(privateRuntimeDir(base), "request.json");
  const promptFile = path.join(base, "prompt.txt");
  const cancelFile = path.join(base, "cancel.json");
  const descendantPidFile = path.join(base, "descendant.pid");
  const fakeClaude = path.join(base, "fake-claude");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "cancel probe", { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nsleep 30 &\necho $! > '${descendantPidFile}'\nwait\n`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, cancelFile, claudeBinary: fakeClaude, environmentFile: privateEnvironmentFile(base),
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(base, "identity.json"), heartbeatFile: path.join(base, "heartbeat.json"),
    exitFile: path.join(base, "exit.json"), stdoutFile: path.join(base, "stdout.log"),
    stderrFile: path.join(base, "stderr.log"), heartbeatIntervalMs: 20, timeoutGraceMs: 100
  };
  const run = runClaudeWorker(spec);
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(descendantPidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fs.writeFileSync(cancelFile, JSON.stringify({ reason: "operator request" }), { mode: 0o600 });

  const result = await run;
  const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8").trim());
  assert.equal(result.cancelled, true);
  assert.equal(result.treeTerminated, true);
  assert.equal(fs.existsSync(cancelFile), false);
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
});

test("runner forwards host shutdown signals and does not orphan its detached Claude tree", {
  skip: process.platform === "win32",
  timeout: 10_000
}, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-host-signal-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  const requestFile = path.join(privateRuntimeDir(base), "request.json");
  const promptFile = path.join(base, "prompt.txt");
  const fakeClaude = path.join(base, "fake-claude");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "host signal probe", { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/bin/sh
IFS= read -r _
printf '%s\\n' '${JSON.stringify({
    type: "system", subtype: "init",
    session_id: value.execution.claudeSessionId,
    permissionMode: "bypassPermissions"
  })}'
sleep 30
`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, claudeBinary: fakeClaude, environmentFile: privateEnvironmentFile(base),
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(base, "identity.json"), heartbeatFile: path.join(base, "heartbeat.json"),
    exitFile: path.join(base, "exit.json"), stdoutFile: path.join(base, "stdout.log"),
    stderrFile: path.join(base, "stderr.log"), heartbeatIntervalMs: 20, timeoutGraceMs: 100,
    requirePermissionAttestation: true
  };
  const specFile = path.join(base, "runner-spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
  const runner = spawn(process.execPath, [RUNNER_PATH, "--spec", specFile], {
    cwd: workspace,
    stdio: "ignore"
  });
  const runnerExit = new Promise((resolve) => runner.once("close", (code, signal) => resolve({ code, signal })));
  const identityDeadline = Date.now() + 3_000;
  let identity;
  while (Date.now() < identityDeadline) {
    try {
      identity = JSON.parse(fs.readFileSync(spec.identityFile, "utf8"));
      if (Number.isInteger(identity.claudePid) && identity.permissionVerification === "verified") break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(Number.isInteger(identity?.claudePid), "runner never published its Claude PID");

  process.kill(runner.pid, "SIGHUP");
  await runnerExit;
  const cleanupDeadline = Date.now() + 2_000;
  let claudeAlive = true;
  while (Date.now() < cleanupDeadline) {
    try {
      process.kill(identity.claudePid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        claudeAlive = false;
        break;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (claudeAlive) {
    try { process.kill(-identity.claudePid, "SIGKILL"); } catch {}
  }

  assert.equal(claudeAlive, false, "Claude survived after its runner received SIGHUP");
  const receipt = JSON.parse(fs.readFileSync(spec.exitFile, "utf8"));
  assert.equal(receipt.treeTerminated, true);
  assert.match(receipt.error, /runner received SIGHUP/);
});

test("runner consumes and unlinks the private current environment instead of using stale inherited auth", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-env-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  const requestFile = path.join(privateRuntimeDir(base), "request.json");
  const promptFile = path.join(base, "prompt.txt");
  const environmentFile = path.join(base, "environment.json");
  const capturedEnvironment = path.join(base, "captured-environment.txt");
  const fakeClaude = path.join(base, "fake-claude");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "environment probe", { mode: 0o600 });
  fs.writeFileSync(environmentFile, JSON.stringify({
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: "current-auth-value"
  }), { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nIFS= read -r line\nprintf '%s' "$ANTHROPIC_API_KEY" > '${capturedEnvironment}'\n`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, environmentFile, claudeBinary: fakeClaude,
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(base, "identity.json"), heartbeatFile: path.join(base, "heartbeat.json"),
    exitFile: path.join(base, "exit.json"), stdoutFile: path.join(base, "stdout.log"),
    stderrFile: path.join(base, "stderr.log"), heartbeatIntervalMs: 20
  };
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "stale-inherited-value";
  try {
    const result = await runClaudeWorker(spec);
    assert.equal(result.code, 0);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }

  assert.equal(fs.readFileSync(capturedEnvironment, "utf8"), "current-auth-value");
  assert.equal(fs.existsSync(environmentFile), false, "credential transport survived runner consumption");
});

test("runner steers two durable messages through one live Claude session and acknowledges replay", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-steer-"));
  const jobDir = path.join(base, "job");
  const runtimeDir = path.join(jobDir, "runtime");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  const requestFile = path.join(runtimeDir, "request.json");
  const promptFile = path.join(runtimeDir, "prompt.txt");
  const fakeClaude = path.join(base, "fake-claude.mjs");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "initial prompt", { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import readline from "node:readline";
const session = ${JSON.stringify(value.execution.claudeSessionId)};
let count = 0;
process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:session,permissionMode:"bypassPermissions"}) + "\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => {
  const envelope = JSON.parse(line);
  process.stdout.write(JSON.stringify({...envelope,session_id:session}) + "\\n");
  count += 1;
  if (count === 3) process.exit(0);
});
`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, claudeBinary: fakeClaude, environmentFile: privateEnvironmentFile(runtimeDir),
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(runtimeDir, "identity.json"), heartbeatFile: path.join(runtimeDir, "heartbeat.json"),
    exitFile: path.join(runtimeDir, "exit.json"), stdoutFile: path.join(runtimeDir, "stdout.log"),
    stderrFile: path.join(runtimeDir, "stderr.log"), heartbeatIntervalMs: 20, inputPollIntervalMs: 20,
    requirePermissionAttestation: true
  };

  const running = runClaudeWorker(spec);
  while (!fs.existsSync(spec.identityFile)) await new Promise((resolve) => setTimeout(resolve, 10));
  const first = enqueueBridgeInput(jobDir, value.jobId, "first continuation");
  const second = enqueueBridgeInput(jobDir, value.jobId, "second continuation");
  const result = await running;

  assert.equal(result.code, 0);
  assert.equal(result.claudeSessionId, value.execution.claudeSessionId);
  assert.equal(readBridgeInputAck(jobDir, first.messageId)?.claudeSessionId, value.execution.claudeSessionId);
  assert.equal(readBridgeInputAck(jobDir, second.messageId)?.claudeSessionId, value.execution.claudeSessionId);
  assert.equal(JSON.parse(fs.readFileSync(spec.identityFile)).permissionVerification, "verified");
});

test("runner closes stream-json input after the authoritative terminal result", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-runner-terminal-result-"));
  const jobDir = path.join(base, "job");
  const runtimeDir = path.join(jobDir, "runtime");
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace);
  const value = request(workspace);
  value.worker.inlineAgents = null;
  value.worker.pluginDirs = [];
  value.worker.mcpConfigPaths = [];
  value.worker.addDirs = [];
  value.worker.settingSources = [];
  value.execution.timeoutSeconds = 2;
  const requestFile = path.join(runtimeDir, "request.json");
  const promptFile = path.join(runtimeDir, "prompt.txt");
  const fakeClaude = path.join(base, "fake-claude.mjs");
  fs.writeFileSync(requestFile, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(promptFile, "terminal result probe", { mode: 0o600 });
  fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import readline from "node:readline";
const session = ${JSON.stringify(value.execution.claudeSessionId)};
const lines = readline.createInterface({input:process.stdin});
let received = false;
process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:session,permissionMode:"bypassPermissions"}) + "\\n");
lines.on("line", () => {
  if (received) return;
  received = true;
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",session_id:session,result:"done"}) + "\\n");
});
lines.on("close", () => process.exit(0));
`, { mode: 0o700 });
  const spec = {
    requestFile, promptFile, claudeBinary: fakeClaude, environmentFile: privateEnvironmentFile(runtimeDir),
    workerCapabilityToken: WORKER_CAPABILITY,
    identityFile: path.join(runtimeDir, "identity.json"), heartbeatFile: path.join(runtimeDir, "heartbeat.json"),
    exitFile: path.join(runtimeDir, "exit.json"), stdoutFile: path.join(runtimeDir, "stdout.log"),
    stderrFile: path.join(runtimeDir, "stderr.log"), heartbeatIntervalMs: 20,
    requirePermissionAttestation: true
  };

  const result = await runClaudeWorker(spec);

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.match(fs.readFileSync(spec.stdoutFile, "utf8"), /\"type\":\"result\"/);
});
