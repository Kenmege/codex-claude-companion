import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { followBridgeLog, handleBridgeCommand } from "../scripts/lib/bridge-cli.mjs";
import { persistBridgeBrokerSpec, readBridgeBrokerSpec } from "../scripts/lib/bridge-broker.mjs";
import { deliverBridgeResult, drainBridgeInbox } from "../scripts/lib/bridge-delivery.mjs";
import { buildClaudeRunnerArgs } from "../scripts/lib/claude-runner.mjs";
import { createBridgeCoordinationOperations, readReceipt, recordVerification } from "../scripts/lib/bridge-messaging.mjs";
import {
  appendBridgeEvent,
  createBridgeJob,
  getBridgeBrokerAuthority,
  getBridgeJob,
  readBridgeRequest,
  requestBridgeCancellation,
  resolveBridgeJobDir,
  transitionBridgeJob,
  writeBridgeResult
} from "../scripts/lib/bridge-state.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function bridgeRequestFixture(jobId, workspace, codexThreadId = "thread-cli-fixture") {
  return {
    schemaVersion: 1,
    jobId,
    origin: { codexThreadId, codexTurnId: "turn-cli-fixture", cwd: workspace, repoRoot: workspace, branch: null, head: null },
    worker: {
      provider: "anthropic", model: "opus", agent: null, inlineAgents: null,
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [],
      settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: `ccb-${jobId.slice(-8).toLowerCase()}`,
      workspaceMode: "current", requestedWorkspacePath: workspace,
      canonicalWorkspacePath: workspace, permittedRoot: workspace,
      claudeSessionId: `00000000-0000-4000-8000-${jobId.slice(-12).padStart(12, "0")}`,
      sandboxAttestation: null, timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "runtime/prompt.txt", acceptance: ["fixture"] }
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("every public bridge subcommand exposes side-effect-free command help", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const script = path.join(repository, "scripts", "claude-review-companion.mjs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-command-help-"));
  const stateRoot = path.join(base, "state");
  const commands = ["delegate", "result", "wait", "status", "logs", "cancel", "recover", "list", "attach", "bridge-doctor", "send", "gc"];

  for (const command of commands) {
    const outcome = spawnSync(process.execPath, [script, command, "--help", "--state-dir", stateRoot], {
      cwd: repository,
      encoding: "utf8"
    });
    assert.equal(outcome.status, 0, `${command}: ${outcome.stderr}\n${outcome.stdout}`);
    assert.match(outcome.stdout, /^Usage:\n/);
    assert.match(outcome.stdout, new RegExp(`codex-claude ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    assert.equal(outcome.stderr, "");
    assert.equal(fs.existsSync(stateRoot), false, `${command} --help must not create bridge state`);
  }

  const shortHelp = spawnSync(process.execPath, [script, "delegate", "-h"], {
    cwd: repository,
    encoding: "utf8"
  });
  assert.equal(shortHelp.status, 0, shortHelp.stderr);
  assert.match(shortHelp.stdout, /codex-claude delegate/);
});

async function waitForLines(file, minimum, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length >= minimum) return lines;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${minimum} line(s) in ${file}`);
}

test("delegate rejects before side effects when no origin verification command is supplied", async () => {
  await assert.rejects(
    () => handleBridgeCommand("delegate", ["--thread-id", "thread-test", "--prompt", "work"]),
    /requires at least one origin-supplied --verify-command JSON argv array/
  );
});

test("delegate accepts one production repair and persists advanced Claude runtime inputs", async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stateRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-repair-enabled-")), "state");
  let output = "";
  let brokerStarts = 0;
  const status = await handleBridgeCommand("delegate", [
    "--thread-id", "thread-test",
    "--prompt", "work",
    "--verify-command", '["npm","test"]',
    "--max-repairs", "1",
    "--agents-json", '{"elite":{"description":"Elite verifier","prompt":"Verify independently."}}',
    "--plugin-dir", repository,
    "--mcp-config", path.join(repository, "package.json"),
    "--add-dir", path.join(repository, "scripts"),
    "--setting-sources", "user,project",
    "--path", repository,
    "--repo-root", repository,
    "--permitted-root", repository,
    "--tmux", process.execPath,
    "--claude", process.execPath,
    "--codex", process.execPath,
    "--state-dir", stateRoot,
    "--json"
  ], {
    write: (text) => { output += text; },
    spawnDetached: () => { brokerStarts += 1; return 4242; }
  });

  assert.equal(status, 0);
  assert.equal(brokerStarts, 1);
  const payload = JSON.parse(output);
  const request = readBridgeRequest(payload.jobId, { stateRoot });
  const spec = readBridgeBrokerSpec(path.join(resolveBridgeJobDir(payload.jobId, { stateRoot }), "broker-spec.json"));
  assert.equal(spec.maxRepairs, 1);
  assert.deepEqual(spec.verificationCommands, [["npm", "test"]]);
  assert.equal(request.worker.agent, null);
  assert.equal(request.worker.inlineAgents.elite.description, "Elite verifier");
  assert.deepEqual(request.worker.pluginDirs, [repository]);
  assert.deepEqual(request.worker.mcpConfigPaths, [path.join(repository, "package.json")]);
  assert.deepEqual(request.worker.addDirs, [path.join(repository, "scripts")]);
  assert.deepEqual(request.worker.settingSources, ["user", "project"]);
  assert.deepEqual(request.execution.effectiveClaudePermissionArgs, ["--setting-sources=user,project", "--permission-mode", "default"]);
});

test("public delegate CLI composes selected agent with inline definitions and persists exact runner argv", async (t) => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-public-agent-composition-"));
  const workspace = path.join(base, "workspace");
  const secondWorkspace = path.join(base, "workspace-2");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  fs.mkdirSync(secondWorkspace);
  let brokerPid = null;
  t.after(() => {
    if (processAlive(brokerPid)) {
      try { process.kill(brokerPid, "SIGTERM"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  });

  const definitions = {
    elite: { description: "Elite independent verifier", prompt: "Verify the implementation independently." }
  };
  const outcome = spawnSync(process.execPath, [
    "scripts/claude-review-companion.mjs", "delegate",
    "--thread-id", "thread-public-agent-composition",
    "--prompt", "verify composition",
    "--verify-command", `[${JSON.stringify(process.execPath)},"-e","process.exit(0)"]`,
    "--agent", "elite",
    "--agents-json", JSON.stringify(definitions),
    "--path", workspace,
    "--repo-root", workspace,
    "--permitted-root", workspace,
    "--tmux", process.execPath,
    "--claude", process.execPath,
    "--codex", process.execPath,
    "--state-dir", stateRoot,
    "--interval", "10000",
    "--json"
  ], { cwd: repository, encoding: "utf8" });

  assert.equal(outcome.status, 0, `${outcome.stderr}\n${outcome.stdout}`);
  const payload = JSON.parse(outcome.stdout);
  brokerPid = payload.brokerPid;
  const request = readBridgeRequest(payload.jobId, { stateRoot });
  assert.equal(request.worker.agent, "elite");
  assert.deepEqual(request.worker.inlineAgents, definitions);
  const runnerArgs = buildClaudeRunnerArgs(request);
  const selectorIndex = runnerArgs.indexOf("--agent");
  assert.notEqual(selectorIndex, -1);
  assert.deepEqual(runnerArgs.slice(selectorIndex, selectorIndex + 4), [
    "--agent", "elite", "--agents", JSON.stringify(definitions)
  ]);
});

test("delegate --wait returns exit 3 after a terminal worker failure is delivered", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-delegate-wait-failed-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  let brokerPid = null;
  let deliveryPromise = null;
  let spawns = 0;
  const status = await handleBridgeCommand("delegate", [
    "--thread-id", "thread-delegate-failed",
    "--prompt", "fail fixture",
    "--verify-command", `[${JSON.stringify(process.execPath)},"-e","process.exit(0)"]`,
    "--path", workspace,
    "--repo-root", workspace,
    "--permitted-root", workspace,
    "--tmux", process.execPath,
    "--claude", process.execPath,
    "--codex", process.execPath,
    "--state-dir", stateRoot,
    "--wait"
  ], {
    write: () => {},
    discoverBrokerPid: () => brokerPid,
    spawnDetached: (_binary, argv) => {
      spawns += 1;
      const spec = readBridgeBrokerSpec(argv[2]);
      const request = readBridgeRequest(spec.jobId, { stateRoot });
      const brokerAuthority = getBridgeBrokerAuthority(spec.jobId, { stateRoot });
      const brokerOptions = { stateRoot, brokerAuthority };
      transitionBridgeJob(spec.jobId, "running", {}, brokerOptions);
      transitionBridgeJob(spec.jobId, "failed", {}, brokerOptions);
      const result = {
        schemaVersion: 1, jobId: spec.jobId, status: "failed", summary: "delegate worker failed",
        filesChanged: [], commandsRun: [], testsRun: [], findings: [],
        blockers: [{ title: "Fixture failure", detail: "delegate failure fixture" }],
        claudeSessionId: request.execution.claudeSessionId,
        exitStatus: { code: 1, signal: null }, artifactPaths: []
      };
      writeBridgeResult(spec.jobId, result, brokerOptions);
      const stateOperations = createBridgeCoordinationOperations({
        stateRoot,
        brokerAuthorityForJob: () => brokerAuthority
      });
      deliveryPromise = deliverBridgeResult({
        result,
        receipt: readReceipt(spec.jobId, brokerOptions),
        origin: request.origin,
        stateOperations,
        originAdapter: async ({ resumeThreadId }) => ({ acknowledged: true, threadId: resumeThreadId })
      });
      brokerPid = 8787;
      return brokerPid;
    },
    sleep: async () => { await deliveryPromise; }
  });

  assert.equal(status, 3);
  assert.equal(spawns, 1);
});

test("delegate --wait returns exit 4 for a pending Claude question", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-delegate-wait-question-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  let spawns = 0;
  const status = await handleBridgeCommand("delegate", [
    "--thread-id", "thread-delegate-question",
    "--prompt", "question fixture",
    "--verify-command", `[${JSON.stringify(process.execPath)},"-e","process.exit(0)"]`,
    "--path", workspace,
    "--repo-root", workspace,
    "--permitted-root", workspace,
    "--tmux", process.execPath,
    "--claude", process.execPath,
    "--codex", process.execPath,
    "--state-dir", stateRoot,
    "--wait"
  ], {
    write: () => {},
    discoverBrokerPid: () => null,
    spawnDetached: (_binary, argv) => {
      spawns += 1;
      const spec = readBridgeBrokerSpec(argv[2]);
      appendBridgeEvent(spec.jobId, {
        type: "question",
        deduplicationKey: "claude-question:delegate-fixture",
        payload: { questionId: "delegate-question", text: "Approve the delegate fixture?" }
      }, { stateRoot, capabilityToken: spec.workerCapabilityToken });
      return 8888;
    }
  });

  assert.equal(status, 4);
  assert.equal(spawns, 1);
});

test("CLI classifies missing verification command as a usage error", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outcome = spawnSync(process.execPath, [
    "scripts/claude-review-companion.mjs", "delegate",
    "--thread-id", "thread-test", "--prompt", "work", "--json"
  ], { cwd: repository, encoding: "utf8" });

  assert.equal(outcome.status, 2, outcome.stderr);
  const payload = JSON.parse(outcome.stdout);
  assert.equal(payload.error_code, "USAGE_ERROR");
  assert.match(payload.message, /requires at least one origin-supplied --verify-command/);
});

test("CLI returns exit 2 and a stable usage envelope for bridge input errors", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stateRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-usage-exit-")), "state");
  const env = { ...process.env, CODEX_CLAUDE_BRIDGE_STATE_DIR: stateRoot };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_TURN_ID;
  const cases = [
    ["list", "--unknown-option", "--json"],
    ["wait", "--json"],
    ["recover", "--all", "unexpected-job", "--json"],
    ["delegate", "--thread-id", "thread-test", "--prompt", "work", "--verify-command", "not-json", "--json"],
    ["delegate", "--thread-id", "thread-test", "--verify-command", '["npm","test"]', "--json"],
    ["delegate", "--prompt", "work", "--verify-command", '["npm","test"]', "--json"],
    ["logs", "ccb_00000000000000000000000001", "--follow", "--timeout", "0", "--json"]
  ];

  for (const argv of cases) {
    const outcome = spawnSync(process.execPath, ["scripts/claude-review-companion.mjs", ...argv], {
      cwd: repository,
      encoding: "utf8",
      env
    });
    assert.equal(outcome.status, 2, `${argv.join(" ")}\n${outcome.stderr}\n${outcome.stdout}`);
    const payload = JSON.parse(outcome.stdout);
    assert.equal(payload.error_code, "USAGE_ERROR", argv.join(" "));
    assert.equal(payload.ok, false);
  }
});

test("send removes its queued input when the authoritative event journal rejects it", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-send-rollback-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000111";
  const created = createBridgeJob(bridgeRequestFixture(jobId, workspace), { stateRoot });
  appendBridgeEvent(jobId, {
    type: "question",
    deduplicationKey: "claude-question:empty-answer",
    payload: { questionId: "empty-answer", text: "Proceed?" }
  }, { stateRoot, capabilityToken: created.capabilityToken });

  await assert.rejects(
    () => handleBridgeCommand("send", [
      jobId,
      "--question-id", "empty-answer",
      "--message=",
      "--state-dir", stateRoot
    ], { write: () => {}, spawnDetached: () => { throw new Error("broker must not start"); } }),
    /Codex message text must contain/
  );

  const queueDir = path.join(resolveBridgeJobDir(jobId, { stateRoot }), "runtime", "input", "queue");
  const stagingDir = path.join(resolveBridgeJobDir(jobId, { stateRoot }), "runtime", "input", "staging");
  assert.deepEqual(fs.readdirSync(queueDir), []);
  assert.deepEqual(fs.readdirSync(stagingDir), []);
});

test("send validates broker authority before creating any executable or staged input", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-send-authority-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000112";
  createBridgeJob(bridgeRequestFixture(jobId, workspace), { stateRoot });
  fs.writeFileSync(path.join(stateRoot, "broker-authority.key"), `${"b".repeat(43)}\n`, { mode: 0o600 });

  await assert.rejects(
    () => handleBridgeCommand("send", [
      jobId,
      "--message", "must not be delivered",
      "--state-dir", stateRoot
    ], { write: () => {}, spawnDetached: () => { throw new Error("broker must not start"); } }),
    /Broker authority key does not match/
  );

  const inputRoot = path.join(resolveBridgeJobDir(jobId, { stateRoot }), "runtime", "input");
  assert.equal(fs.existsSync(inputRoot), false);
});

test("actual CLI wait returns exit 3 for a delivered terminal worker failure", async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cli-wait-failed-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000081";
  const request = bridgeRequestFixture(jobId, workspace);
  createBridgeJob(request, { stateRoot });
  const brokerAuthority = getBridgeBrokerAuthority(jobId, { stateRoot });
  const brokerOptions = { stateRoot, brokerAuthority };
  transitionBridgeJob(jobId, "running", {}, brokerOptions);
  transitionBridgeJob(jobId, "failed", {}, brokerOptions);
  const result = {
    schemaVersion: 1, jobId, status: "failed", summary: "worker failed",
    filesChanged: [], commandsRun: [], testsRun: [], findings: [], blockers: [{ title: "Fixture failure", detail: "fixture failure" }],
    claudeSessionId: request.execution.claudeSessionId,
    exitStatus: { code: 1, signal: null }, artifactPaths: []
  };
  writeBridgeResult(jobId, result, brokerOptions);
  const stateOperations = createBridgeCoordinationOperations({
    stateRoot,
    brokerAuthorityForJob: () => brokerAuthority
  });
  assert.equal((await deliverBridgeResult({
    result,
    receipt: readReceipt(jobId, brokerOptions),
    origin: request.origin,
    stateOperations,
    originAdapter: async ({ resumeThreadId }) => ({ acknowledged: true, threadId: resumeThreadId })
  })).state, "acknowledged");

  const outcome = spawnSync(process.execPath, ["scripts/claude-review-companion.mjs", "wait", jobId, "--state-dir", stateRoot, "--json"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, CODEX_THREAD_ID: request.origin.codexThreadId }
  });
  assert.equal(outcome.status, 3, outcome.stderr);
  const payload = JSON.parse(outcome.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.receipt.delivery.state, "acknowledged");
});

test("actual CLI wait returns exit 4 for a pending Claude question without spawning a broker", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cli-wait-question-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000082";
  const request = bridgeRequestFixture(jobId, workspace);
  const created = createBridgeJob(request, { stateRoot });
  appendBridgeEvent(jobId, {
    type: "question",
    deduplicationKey: "claude-question:fixture",
    payload: { questionId: "fixture-question", text: "Proceed with the migration?" }
  }, { stateRoot, capabilityToken: created.capabilityToken });

  const outcome = spawnSync(process.execPath, ["scripts/claude-review-companion.mjs", "wait", jobId, "--state-dir", stateRoot, "--json"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, CODEX_THREAD_ID: request.origin.codexThreadId }
  });
  assert.equal(outcome.status, 4, outcome.stderr);
  const payload = JSON.parse(outcome.stdout);
  assert.equal(payload.pendingQuestionId, "fixture-question");
  assert.equal(payload.pendingQuestionText, "Proceed with the migration?");
  assert.equal(fs.existsSync(path.join(resolveBridgeJobDir(jobId, { stateRoot }), "broker-heartbeat.json")), false);
});

test("actual CLI gc is a bounded dry run and requires explicit apply for removal", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cli-gc-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000083";
  createBridgeJob(bridgeRequestFixture(jobId, workspace), {
    stateRoot,
    clock: () => new Date("2020-01-01T00:00:00Z")
  });
  const brokerAuthority = getBridgeBrokerAuthority(jobId, { stateRoot });
  requestBridgeCancellation(jobId, "gc fixture", {
    stateRoot, brokerAuthority, clock: () => new Date("2020-01-01T12:00:00Z")
  });
  transitionBridgeJob(jobId, "cancelled", {}, {
    stateRoot,
    brokerAuthority,
    clock: () => new Date("2020-01-02T00:00:00Z")
  });
  const invocation = (extra) => spawnSync(process.execPath, [
    "scripts/claude-review-companion.mjs", "gc", "--state-dir", stateRoot,
    "--older-than-days", "1", "--json", ...extra
  ], { cwd: repository, encoding: "utf8" });

  const preview = invocation([]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).candidates, [jobId]);
  assert.equal(fs.existsSync(resolveBridgeJobDir(jobId, { stateRoot })), true);
  const applied = invocation(["--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).removed, [jobId]);
  assert.equal(fs.existsSync(resolveBridgeJobDir(jobId, { stateRoot })), false);

  const invalid = invocation(["--limit", "65"]);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error_code, "USAGE_ERROR");
});

test("public help documents required repeatable JSON argv verification commands", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outcome = spawnSync(process.execPath, ["scripts/claude-review-companion.mjs", "--help"], {
    cwd: repository,
    encoding: "utf8"
  });

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /--verify-command '\["npm","test"\]'/);
  assert.match(outcome.stdout, /repeatable; required origin-supplied independent verification command/);
  assert.match(outcome.stdout, /--agents-json <JSON>/);
  assert.match(outcome.stdout, /--plugin-dir <dir>/);
  assert.match(outcome.stdout, /--setting-sources <list>/);
  assert.match(outcome.stdout, /--max-repairs <0\|1>/);
});

test("bounded log following emits existing and appended content then stops at terminal state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-follow-"));
  const log = path.join(directory, "stdout.jsonl");
  fs.writeFileSync(log, "existing\n", { mode: 0o600 });
  let clock = 0;
  let terminal = false;
  let output = "";
  let sleeps = 0;

  const outcome = await followBridgeLog(log, {
    timeoutMs: 1_000,
    pollMs: 50,
    now: () => clock,
    write: (text) => { output += text; },
    isTerminal: () => terminal,
    sleep: async (milliseconds) => {
      clock += milliseconds;
      sleeps += 1;
      if (sleeps === 1) fs.appendFileSync(log, "appended\n");
      if (sleeps === 2) terminal = true;
    }
  });

  assert.equal(outcome.reason, "terminal");
  assert.equal(output, "existing\nappended\n");
});

test("recover --all is a valid global drain operation when no durable jobs exist", async () => {
  const stateRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-recover-all-")), "state");
  let output = "";
  const status = await handleBridgeCommand("recover", ["--all", "--state-dir", stateRoot], {
    write: (text) => { output += text; }
  });
  assert.equal(status, 0);
  assert.equal(output, "No bridge jobs to recover.\n");
});

test("status preserves authoritative state when a legacy receipt is invalid", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-status-invalid-receipt-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000101";
  createBridgeJob(bridgeRequestFixture(jobId, workspace), { stateRoot });
  fs.writeFileSync(path.join(resolveBridgeJobDir(jobId, { stateRoot }), "receipt.json"), "{}\n", { mode: 0o600 });

  let output = "";
  const status = await handleBridgeCommand("status", [jobId, "--state-dir", stateRoot, "--json"], {
    write: (text) => { output += text; }
  });
  const payload = JSON.parse(output);

  assert.equal(status, 0);
  assert.equal(payload.jobId, jobId);
  assert.equal(payload.status, "accepted");
  assert.equal(payload.receipt, null);
  assert.deepEqual(payload.artifactErrors.map((entry) => entry.artifact), ["receipt"]);
  assert.match(payload.artifactErrors[0].message, /receipt|schema|contract/i);
});

test("wait remains strict when a receipt is invalid", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-wait-invalid-receipt-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000105";
  createBridgeJob(bridgeRequestFixture(jobId, workspace), { stateRoot });
  fs.writeFileSync(path.join(resolveBridgeJobDir(jobId, { stateRoot }), "receipt.json"), "{}\n", { mode: 0o600 });

  await assert.rejects(
    () => handleBridgeCommand("wait", [jobId, "--state-dir", stateRoot, "--timeout", "1"], { write: () => {} }),
    /receipt|schema|contract/i
  );
});

test("list isolates an invalid legacy receipt to its owning job", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-list-invalid-receipt-"));
  const workspace = path.join(base, "workspace");
  const secondWorkspace = path.join(base, "workspace-2");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  fs.mkdirSync(secondWorkspace);
  const validJobId = "ccb_00000000000000000000000102";
  const invalidJobId = "ccb_00000000000000000000000103";
  createBridgeJob(bridgeRequestFixture(validJobId, workspace), { stateRoot });
  createBridgeJob(bridgeRequestFixture(invalidJobId, secondWorkspace), { stateRoot });
  fs.writeFileSync(path.join(resolveBridgeJobDir(invalidJobId, { stateRoot }), "receipt.json"), "{}\n", { mode: 0o600 });

  let output = "";
  const status = await handleBridgeCommand("list", ["--state-dir", stateRoot, "--json"], {
    write: (text) => { output += text; }
  });
  const payload = JSON.parse(output);
  const byId = new Map(payload.jobs.map((job) => [job.jobId, job]));

  assert.equal(status, 0);
  assert.deepEqual([...byId.keys()].sort(), [invalidJobId, validJobId].sort());
  assert.deepEqual(byId.get(validJobId).artifactErrors, []);
  assert.deepEqual(byId.get(invalidJobId).artifactErrors.map((entry) => entry.artifact), ["receipt"]);
});

test("recover --all reports an invalid legacy receipt without starting its broker", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-recover-invalid-receipt-"));
  const workspace = path.join(base, "workspace");
  const healthyWorkspace = path.join(base, "healthy-workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  fs.mkdirSync(healthyWorkspace);
  const jobId = "ccb_00000000000000000000000104";
  const healthyJobId = "ccb_00000000000000000000000106";
  createBridgeJob(bridgeRequestFixture(jobId, workspace), { stateRoot });
  createBridgeJob(bridgeRequestFixture(healthyJobId, healthyWorkspace), { stateRoot });
  const receiptFile = path.join(resolveBridgeJobDir(jobId, { stateRoot }), "receipt.json");
  fs.writeFileSync(receiptFile, "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(resolveBridgeJobDir(healthyJobId, { stateRoot }), "broker-spec.json"), "{}\n", { mode: 0o600 });

  let output = "";
  let spawns = 0;
  const status = await handleBridgeCommand("recover", ["--all", "--state-dir", stateRoot, "--json"], {
    write: (text) => { output += text; },
    discoverBrokerPid: () => null,
    spawnDetached: () => { spawns += 1; return 10106; }
  });
  const payload = JSON.parse(output);

  assert.equal(status, 3);
  assert.deepEqual(payload.recovered.map((item) => item.jobId), [healthyJobId]);
  assert.equal(payload.errors.length, 1);
  assert.equal(payload.errors[0].jobId, jobId);
  assert.match(payload.errors[0].message, /receipt|schema|contract/i);
  assert.equal(spawns, 1, "only the healthy job may start a broker");
  assert.equal(fs.readFileSync(receiptFile, "utf8"), "{}\n", "observation must preserve legacy evidence");
});

test("live heartbeat identity inspection failure refuses broker spawn", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-inspection-closed-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000084";
  createBridgeJob(bridgeRequestFixture(jobId, workspace), { stateRoot });
  const jobDir = resolveBridgeJobDir(jobId, { stateRoot });
  fs.writeFileSync(path.join(jobDir, "broker-spec.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(jobDir, "broker-heartbeat.json"), `${JSON.stringify({
    schemaVersion: 1, jobId, brokerPid: 8484
  })}\n`, { mode: 0o600 });
  let spawns = 0;

  await assert.rejects(
    () => handleBridgeCommand("recover", [jobId, "--state-dir", stateRoot], {
      write: () => {},
      processAlive: () => true,
      readProcessArgv: () => { throw new Error("process inspection unavailable fixture"); },
      discoverBrokerPid: () => null,
      spawnDetached: () => { spawns += 1; return 8485; }
    }),
    /process inspection unavailable fixture/
  );
  assert.equal(spawns, 0, "an uninspectable live PID must fail closed instead of spawning a duplicate");
});

test("durable broker-start reservation serializes concurrent subprocesses and reconciles crash-before-heartbeat", async (t) => {
  if (process.platform === "win32") {
    t.skip("process identity reconciliation currently uses ps/proc on Unix");
    return;
  }
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-start-race-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const fakeBroker = path.join(base, "fake-broker.mjs");
  const helper = path.join(base, "start-helper.mjs");
  fs.writeFileSync(fakeBroker, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.BROKER_MARKER, `${process.pid}\\n`);',
    'process.on("SIGTERM", () => process.exit(0));',
    'setInterval(() => {}, 1_000);'
  ].join("\n"), { mode: 0o600 });
  const bridgeCliUrl = pathToFileURL(path.join(repository, "scripts", "lib", "bridge-cli.mjs")).href;
  fs.writeFileSync(helper, [
    `import { startBroker } from ${JSON.stringify(bridgeCliUrl)};`,
    'try {',
    '  const result = startBroker(process.env.BRIDGE_JOB_ID, { stateRoot: process.env.BRIDGE_STATE_ROOT }, {',
    '    brokerScript: process.env.FAKE_BROKER_SCRIPT,',
    '    env: process.env,',
    '    ...(process.env.CRASH_AFTER_SPAWN === "1" ? { afterBrokerSpawn: () => { throw new Error("crash after spawn fixture"); } } : {})',
    '  });',
    '  process.stdout.write(`${JSON.stringify(result)}\\n`);',
    '} catch (error) {',
    '  process.stderr.write(`${error.message}\\n`);',
    '  process.exitCode = 7;',
    '}'
  ].join("\n"), { mode: 0o600 });

  const livePids = new Set();
  t.after(() => {
    for (const pid of livePids) {
      try { process.kill(pid, "SIGTERM"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  });
  const makeJob = (jobId) => {
    const jobWorkspace = path.join(base, `workspace-${jobId.slice(-2)}`);
    fs.mkdirSync(jobWorkspace);
    createBridgeJob(bridgeRequestFixture(jobId, jobWorkspace), { stateRoot });
    fs.writeFileSync(path.join(resolveBridgeJobDir(jobId, { stateRoot }), "broker-spec.json"), "{}\n", { mode: 0o600 });
  };
  const launch = (jobId, marker, extraEnv = {}) => waitForExit(spawn(process.execPath, [helper], {
    cwd: repository,
    env: {
      ...process.env,
      BRIDGE_JOB_ID: jobId,
      BRIDGE_STATE_ROOT: stateRoot,
      FAKE_BROKER_SCRIPT: fakeBroker,
      BROKER_MARKER: marker,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  }));

  const concurrentJob = "ccb_00000000000000000000000085";
  const concurrentMarker = path.join(base, "concurrent-starts.log");
  makeJob(concurrentJob);
  const concurrent = await Promise.all([
    launch(concurrentJob, concurrentMarker),
    launch(concurrentJob, concurrentMarker)
  ]);
  assert.deepEqual(concurrent.map((result) => result.code), [0, 0], concurrent.map((result) => result.stderr).join("\n"));
  const concurrentResults = concurrent.map((result) => JSON.parse(result.stdout));
  assert.equal(concurrentResults.filter((result) => result.started).length, 1);
  assert.equal(concurrentResults.filter((result) => result.reason === "reconciled-before-heartbeat").length, 1);
  const concurrentPids = await waitForLines(concurrentMarker, 1);
  assert.equal(concurrentPids.length, 1, "two independent launchers must create exactly one broker process");
  livePids.add(Number(concurrentPids[0]));

  const crashedJob = "ccb_00000000000000000000000086";
  const crashMarker = path.join(base, "crash-starts.log");
  makeJob(crashedJob);
  const crashed = await launch(crashedJob, crashMarker, { CRASH_AFTER_SPAWN: "1" });
  assert.equal(crashed.code, 7);
  assert.match(crashed.stderr, /crash after spawn fixture/);
  const crashedPids = await waitForLines(crashMarker, 1);
  livePids.add(Number(crashedPids[0]));
  const reconciled = await launch(crashedJob, crashMarker);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  assert.deepEqual(JSON.parse(reconciled.stdout), {
    started: false,
    pid: Number(crashedPids[0]),
    reason: "reconciled-before-heartbeat"
  });
  assert.equal((await waitForLines(crashMarker, 1)).length, 1, "recovery must adopt the orphan without spawning again");
});

test("ordinary CLI invocation restarts a same-origin durable inbox and drains it exactly once", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-auto-recover-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  fs.mkdirSync(workspace);
  const jobId = "ccb_00000000000000000000000091";
  const origin = {
    codexThreadId: "thread-auto-recover", codexTurnId: "turn-auto-recover",
    cwd: workspace, repoRoot: workspace, branch: null, head: null
  };
  createBridgeJob({
    schemaVersion: 1,
    jobId,
    origin,
    worker: {
      provider: "anthropic", model: "opus", agent: null, inlineAgents: null,
      customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [],
      settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: "ccb-auto-recover",
      workspaceMode: "current", requestedWorkspacePath: workspace,
      canonicalWorkspacePath: workspace, permittedRoot: workspace,
      claudeSessionId: "00000000-0000-4000-8000-000000000091",
      sandboxAttestation: null, timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "runtime/prompt.txt", acceptance: ["deliver exactly once"] }
  }, { stateRoot });
  const brokerAuthority = getBridgeBrokerAuthority(jobId, { stateRoot });
  const brokerOptions = { stateRoot, brokerAuthority };
  transitionBridgeJob(jobId, "running", {}, brokerOptions);
  transitionBridgeJob(jobId, "completed", {}, brokerOptions);
  const result = {
    schemaVersion: 1, jobId, status: "completed", summary: "completed",
    filesChanged: [], commandsRun: [], testsRun: [], findings: [], blockers: [],
    claudeSessionId: "00000000-0000-4000-8000-000000000091",
    exitStatus: { code: 0, signal: null }, artifactPaths: []
  };
  writeBridgeResult(jobId, result, brokerOptions);
  recordVerification(jobId, {
    state: "passed", verifiedAt: new Date(Date.now() + 1_000).toISOString(), evidence: ["independent:test passed"]
  }, brokerOptions);
  const stateOperations = createBridgeCoordinationOperations({
    stateRoot,
    brokerAuthorityForJob: (candidate) => getBridgeBrokerAuthority(candidate, { stateRoot })
  });
  const queued = await deliverBridgeResult({
    result,
    receipt: readReceipt(jobId, brokerOptions),
    origin,
    stateOperations,
    originAdapter: async () => { throw new Error("Codex origin temporarily unavailable"); }
  });
  assert.equal(queued.state, "queued");
  assert.equal(readReceipt(jobId, brokerOptions).delivery.state, "pending");
  const brokerSpec = path.join(resolveBridgeJobDir(jobId, { stateRoot }), "broker-spec.json");
  fs.writeFileSync(brokerSpec, "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(resolveBridgeJobDir(jobId, { stateRoot }), "broker-heartbeat.json"), `${JSON.stringify({
    schemaVersion: 1, jobId, brokerPid: 8181
  })}\n`, { mode: 0o600 });

  let brokerStarts = 0;
  let originDeliveries = 0;
  let drainPromise = null;
  let inspectedArgv = [
    process.execPath,
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "bridge-broker.mjs"),
    "--spec",
    brokerSpec
  ];
  const deps = {
    codexThreadId: origin.codexThreadId,
    write: () => {},
    processAlive: () => true,
    readProcessArgv: () => inspectedArgv,
    spawnDetached: (_binary, _argv, spawnOptions) => {
      brokerStarts += 1;
      assert.equal(spawnOptions.env.CODEX_CLAUDE_BRIDGE_AUTO_RECOVERY, "1");
      drainPromise = drainBridgeInbox({
        origin,
        stateOperations,
        originAdapter: async ({ resumeThreadId }) => {
          originDeliveries += 1;
          return { acknowledged: true, threadId: resumeThreadId };
        }
      });
      return 9191;
    }
  };

  await handleBridgeCommand("list", ["--state-dir", stateRoot], { ...deps, codexThreadId: "wrong-thread" });
  assert.equal(brokerStarts, 0, "cross-origin CLI invocation must not restart the inbox owner");
  await handleBridgeCommand("list", ["--state-dir", stateRoot], {
    ...deps,
    codexOrigin: { ...origin, codexTurnId: "later-turn", cwd: base, branch: "later", head: "later" }
  });
  assert.equal(brokerStarts, 0, "an exact live broker argv must suppress duplicate restart across later turns");
  inspectedArgv = [process.execPath, `${inspectedArgv[1]}.substring-confusable`, "--spec", brokerSpec];
  await handleBridgeCommand("list", ["--state-dir", stateRoot], {
    ...deps,
    codexOrigin: { ...origin, codexTurnId: "later-turn", cwd: base, branch: "later", head: "later" }
  });
  assert.equal(brokerStarts, 1);
  assert.deepEqual(await drainPromise, { state: "acknowledged", route: "origin", jobId });
  await handleBridgeCommand("list", ["--state-dir", stateRoot], deps);
  assert.equal(brokerStarts, 1, "settled delivery must not be restarted");
  assert.equal(originDeliveries, 1);
  assert.equal(readReceipt(jobId, brokerOptions).delivery.state, "acknowledged");
  assert.deepEqual(await drainBridgeInbox({ origin, stateOperations }), { state: "empty" });
});

test("real broker process restart drains the durable origin inbox exactly once", async (t) => {
  if (process.platform === "win32") {
    t.skip("real broker stale-owner restart fixture requires Unix process signals");
    return;
  }
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const brokerScript = path.join(repository, "scripts", "bridge-broker.mjs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-real-broker-restart-"));
  const workspace = path.join(base, "workspace");
  const stateRoot = path.join(base, "state");
  const fakeBin = path.join(base, "bin");
  const fakeCodex = path.join(fakeBin, "codex");
  const deliveryMarker = path.join(base, "origin-deliveries.log");
  fs.mkdirSync(workspace);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { process.stdout.write("codex-fake 1.0\\n"); process.exit(0); }',
    'if (args[0] === "app-server" && args[1] === "--help") { process.stdout.write("fake app-server\\n"); process.exit(0); }',
    'if (args[0] !== "app-server") process.exit(2);',
    'const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.id === undefined) return;',
    '  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake-codex" } });',
    '  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });',
    '  if (message.method === "turn/start") {',
    '    fs.appendFileSync(process.env.DELIVERY_MARKER, `${message.params.threadId}\\n`);',
    '    const turn = { id: "turn-fake-delivery", status: "inProgress" };',
    '    send({ id: message.id, result: { turn } });',
    '    setTimeout(() => send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed" } } }), 25);',
    '    return;',
    '  }',
    '  send({ id: message.id, result: {} });',
    '});'
  ].join("\n"), { mode: 0o700 });

  const jobId = "ccb_00000000000000000000000092";
  const origin = {
    codexThreadId: "thread-real-broker-restart", codexTurnId: "turn-real-broker-restart",
    cwd: workspace, repoRoot: workspace, branch: null, head: null
  };
  const request = bridgeRequestFixture(jobId, workspace, origin.codexThreadId);
  request.origin = origin;
  const created = createBridgeJob(request, { stateRoot });
  const jobDir = resolveBridgeJobDir(jobId, { stateRoot });
  const specFile = path.join(jobDir, "broker-spec.json");
  const heartbeatFile = path.join(jobDir, "broker-heartbeat.json");
  persistBridgeBrokerSpec(specFile, {
    schemaVersion: 1,
    jobId,
    stateRoot,
    jobDir,
    prompt: "real broker restart fixture",
    workerCapabilityToken: created.capabilityToken,
    tmuxBinary: fs.realpathSync(process.execPath),
    claudeBinary: fs.realpathSync(process.execPath),
    codexBinary: fakeCodex,
    nodeBinary: fs.realpathSync(process.execPath),
    envBinary: fs.realpathSync("/usr/bin/env"),
    heartbeatFile,
    intervalMs: 100,
    maxRepairs: 0,
    verificationCommands: [[process.execPath, "-e", "process.exit(0)"]],
    securityRequirements: {}
  });

  let staleChild = null;
  let stalePid = null;
  let recoveredPid = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const pid of [stalePid, recoveredPid]) {
      if (!processAlive(pid)) continue;
      try { process.kill(pid, "SIGTERM"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    const session = loadBrokerSession(workspace);
    if (session) {
      await sendBrokerShutdown(session.endpoint).catch(() => {});
      await waitUntil(() => !processAlive(session.pid), "app-server broker shutdown", 2_000).catch(() => {});
      teardownBrokerSession({
        ...session,
        killProcess: (pid) => {
          if (processAlive(pid)) process.kill(pid, "SIGTERM");
        }
      });
      clearBrokerSession(workspace);
    }
  };
  t.after(cleanup);

  const bridgeEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    DELIVERY_MARKER: deliveryMarker,
    CODEX_THREAD_ID: origin.codexThreadId
  };
  delete bridgeEnv.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  delete bridgeEnv.CODEX_COMPANION_APP_SERVER_PID_FILE;
  delete bridgeEnv.CODEX_COMPANION_APP_SERVER_LOG_FILE;

  staleChild = spawn(process.execPath, [brokerScript, "--spec", specFile], {
    cwd: jobDir,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  stalePid = staleChild.pid;
  process.kill(stalePid, "SIGSTOP");
  fs.writeFileSync(heartbeatFile, `${JSON.stringify({
    schemaVersion: 1, jobId, brokerPid: stalePid,
    timestamp: new Date(0).toISOString(), action: "starting", consecutiveErrors: 0
  })}\n`, { mode: 0o600 });
  assert.equal(processAlive(stalePid), true);
  process.kill(stalePid, "SIGKILL");
  const staleExit = await waitForExit(staleChild);
  assert.equal(staleExit.signal, "SIGKILL");
  assert.equal(processAlive(stalePid), false);

  const preTerminal = getBridgeJob(jobId, { stateRoot });
  assert.equal(["accepted", "running"].includes(preTerminal.status), true, preTerminal.status);
  const brokerAuthority = getBridgeBrokerAuthority(jobId, { stateRoot });
  const brokerOptions = { stateRoot, brokerAuthority };
  if (preTerminal.status === "accepted") transitionBridgeJob(jobId, "running", {}, brokerOptions);
  transitionBridgeJob(jobId, "completed", {}, brokerOptions);
  const result = {
    schemaVersion: 1, jobId, status: "completed", summary: "real broker completed",
    filesChanged: [], commandsRun: [], testsRun: [], findings: [], blockers: [],
    claudeSessionId: request.execution.claudeSessionId,
    exitStatus: { code: 0, signal: null }, artifactPaths: []
  };
  writeBridgeResult(jobId, result, brokerOptions);
  recordVerification(jobId, {
    state: "passed", verifiedAt: new Date(Date.now() + 1_000).toISOString(), evidence: ["real-broker:verification passed"]
  }, brokerOptions);
  const stateOperations = createBridgeCoordinationOperations({
    stateRoot,
    brokerAuthorityForJob: (candidate) => getBridgeBrokerAuthority(candidate, { stateRoot })
  });
  assert.equal((await deliverBridgeResult({
    result,
    receipt: readReceipt(jobId, brokerOptions),
    origin,
    stateOperations,
    originAdapter: async () => { throw new Error("queue for real broker restart fixture"); }
  })).state, "queued");

  const list = () => spawnSync(process.execPath, [
    "scripts/claude-review-companion.mjs", "list", "--state-dir", stateRoot, "--json"
  ], { cwd: repository, encoding: "utf8", env: bridgeEnv });
  const restarted = list();
  assert.equal(restarted.status, 0, `${restarted.stderr}\n${restarted.stdout}`);
  await waitUntil(() => {
    try {
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
      if (heartbeat.brokerPid === stalePid) return false;
      recoveredPid = heartbeat.brokerPid;
      return readReceipt(jobId, brokerOptions).delivery.state === "acknowledged";
    } catch { return false; }
  }, "restarted broker delivery acknowledgement", 15_000);
  assert.notEqual(recoveredPid, stalePid);
  assert.deepEqual(fs.readFileSync(deliveryMarker, "utf8").trim().split("\n"), [origin.codexThreadId]);
  await waitUntil(() => !processAlive(recoveredPid), "restarted broker exit", 5_000);

  const replay = list();
  assert.equal(replay.status, 0, `${replay.stderr}\n${replay.stdout}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(fs.readFileSync(deliveryMarker, "utf8").trim().split("\n"), [origin.codexThreadId]);
  assert.equal(readReceipt(jobId, brokerOptions).delivery.state, "acknowledged");

  const appServerSession = loadBrokerSession(workspace);
  const appServerPid = appServerSession?.pid ?? null;
  await cleanup();
  assert.equal(processAlive(stalePid), false);
  assert.equal(processAlive(recoveredPid), false);
  assert.equal(processAlive(appServerPid), false);
});
