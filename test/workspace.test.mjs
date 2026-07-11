import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildClaudeBackgroundArgs,
  buildClaudeLogsArgs,
  buildClaudePanelArgs,
  buildClaudeStatusArgs,
  buildClaudeStopArgs,
  createWorkspaceConfig,
  formatWorkspaceEvent,
  runWorkspace,
  selectTerminalBackend
} from "../scripts/lib/workspace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "scripts", "claude-review-companion.mjs");

test("background worker uses rolling Opus, native coding permissions, and a stable session ID", () => {
  assert.deepEqual(
    buildClaudeBackgroundArgs({ model: "opus", prompt: "implement the API" }, "123e4567-e89b-42d3-a456-426614174000"),
    [
      "--model", "opus",
      "--permission-mode", "default",
      "--session-id", "123e4567-e89b-42d3-a456-426614174000",
      "--bg",
      "implement the API"
    ]
  );
});

test("background worker supports explicit models and plan mode", () => {
  assert.deepEqual(
    buildClaudeBackgroundArgs(
      { model: "sonnet", plan: true, prompt: "design the migration" },
      "123e4567-e89b-42d3-a456-426614174000"
    ),
    [
      "--model", "sonnet",
      "--permission-mode", "plan",
      "--session-id", "123e4567-e89b-42d3-a456-426614174000",
      "--bg",
      "design the migration"
    ]
  );
});

test("panel and supervision commands use Claude native agent controls", () => {
  assert.deepEqual(buildClaudePanelArgs({ cwd: "/repo" }), ["agents", "--cwd", "/repo"]);
  assert.deepEqual(buildClaudeStatusArgs({ cwd: "/repo", all: true, json: true }), [
    "agents", "--cwd", "/repo", "--all", "--json"
  ]);
  assert.deepEqual(buildClaudeLogsArgs("session-123"), ["logs", "session-123"]);
  assert.deepEqual(buildClaudeStopArgs("session-123"), ["stop", "session-123"]);
});

test("workspace config validates paths and panel modes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-workspace-config-"));
  const nested = path.join(cwd, "nested");
  fs.mkdirSync(nested);

  const config = createWorkspaceConfig({ path: "nested", positionals: ["fix", "tests"] }, cwd);
  assert.equal(config.cwd, nested);
  assert.equal(config.prompt, "fix tests");
  assert.equal(config.openPanel, true);

  assert.throws(
    () => createWorkspaceConfig({ panelOnly: true, positionals: ["unexpected"] }, cwd),
    /--panel-only cannot include/i
  );
  assert.throws(
    () => createWorkspaceConfig({ noPanel: true, positionals: [] }, cwd),
    /--no-panel requires/i
  );
  assert.throws(
    () => createWorkspaceConfig({ panelOnly: true, noPanel: true, positionals: [] }, cwd),
    /cannot be used together/i
  );
  assert.throws(
    () => createWorkspaceConfig({ positionals: [] }, cwd),
    /coding request.*--panel-only/i
  );
  assert.throws(
    () => createWorkspaceConfig({ path: "missing", positionals: ["work"] }, cwd),
    /not a directory/i
  );
});

test("terminal backend prefers an existing tmux session, then native terminal adapters", () => {
  const available = (...commands) => (command) => commands.includes(command);
  assert.equal(selectTerminalBackend({ platform: "darwin", env: { TMUX: "yes" }, commandAvailable: available("tmux") }), "tmux");
  assert.equal(selectTerminalBackend({ platform: "darwin", env: {}, commandAvailable: available("open") }), "terminal-app");
  assert.equal(selectTerminalBackend({ platform: "linux", env: {}, commandAvailable: available("x-terminal-emulator") }), "x-terminal-emulator");
  assert.equal(selectTerminalBackend({ platform: "linux", env: {}, commandAvailable: available() }), null);
});

test("workspace lifecycle events exclude prompt and tool content", () => {
  const event = {
    command: "workspace",
    phase: "worker_dispatched",
    mode: "coding",
    model: "opus",
    codexModelRouting: "active-session",
    directory: "/repo",
    sessionId: "session-123",
    terminalBackend: "terminal-app"
  };
  const json = formatWorkspaceEvent(event, { json: true });
  assert.deepEqual(JSON.parse(json), event);
  assert.doesNotMatch(json, /secret coding prompt/i);

  const human = formatWorkspaceEvent(event);
  assert.match(human, /worker_dispatched/);
  assert.match(human, /session=session-123/);
  assert.match(human, /codex_model=active-session/);
});

test("workspace dispatches Claude, opens a separate panel, and returns control to Codex", async () => {
  const calls = [];
  const events = [];
  const clock = [100, 112, 200, 207];
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const result = await runWorkspace(
    { cwd: "/repo", model: "opus", prompt: "make the change", openPanel: true },
    {
      commandAvailable: () => true,
      now: () => clock.shift(),
      generateSessionId: () => sessionId,
      selectBackend: () => "terminal-app",
      runCommand: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
      openPanel: (config, backend) => {
        calls.push({ command: "panel", config, backend });
        return { opened: true, backend };
      },
      emit: (event) => events.push(event)
    }
  );

  assert.deepEqual(calls.map(({ command }) => command), ["claude", "panel"]);
  assert.deepEqual(calls[0].args, [
    "--model", "opus", "--permission-mode", "default",
    "--session-id", sessionId, "--bg", "make the change"
  ]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(result.status, 0);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.panelOpened, true);
  assert.deepEqual(events.map(({ phase }) => phase), ["worker_dispatched", "panel_opened"]);
  assert.deepEqual(events.map(({ durationMs }) => durationMs), [12, 7]);
  assert.ok(calls.every(({ command }) => command !== "codex"));
});

test("dispatch failure does not open a panel", async () => {
  let panelCalls = 0;
  const result = await runWorkspace(
    { cwd: "/repo", model: "opus", prompt: "make the change", openPanel: true },
    {
      commandAvailable: () => true,
      generateSessionId: () => "123e4567-e89b-42d3-a456-426614174000",
      runCommand: () => ({ status: 7, stdout: "", stderr: "dispatch failed" }),
      openPanel: () => { panelCalls += 1; },
      emit: () => {}
    }
  );
  assert.equal(result.status, 7);
  assert.equal(panelCalls, 0);
});

test("panel failure preserves the running worker and returns manual recovery", async () => {
  const result = await runWorkspace(
    { cwd: "/repo", model: "opus", prompt: "make the change", openPanel: true },
    {
      commandAvailable: () => true,
      generateSessionId: () => "123e4567-e89b-42d3-a456-426614174000",
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      selectBackend: () => null,
      emit: () => {}
    }
  );
  assert.equal(result.status, 0);
  assert.equal(result.panelOpened, false);
  assert.deepEqual(result.manualPanelCommand, ["claude", "agents", "--cwd", "/repo"]);
});

test("panel-only mode opens the control panel without dispatching a worker", async () => {
  let dispatchCalls = 0;
  const result = await runWorkspace(
    { cwd: "/repo", model: "opus", prompt: null, panelOnly: true, openPanel: true },
    {
      commandAvailable: () => true,
      runCommand: () => { dispatchCalls += 1; },
      selectBackend: () => "tmux",
      openPanel: () => ({ opened: true, backend: "tmux" }),
      emit: () => {}
    }
  );
  assert.equal(dispatchCalls, 0);
  assert.equal(result.panelOpened, true);
  assert.equal(result.sessionId, null);
});

test("workspace requires the Claude executable", async () => {
  await assert.rejects(
    runWorkspace(
      { cwd: "/repo", model: "opus", prompt: "work", openPanel: false },
      { commandAvailable: () => false, emit: () => {} }
    ),
    /Claude Code CLI.*not available/i
  );
});

test("CLI dispatch returns immediately and forwards native background arguments", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-workspace-cli-"));
  const stub = path.join(temp, "claude");
  const argsFile = path.join(temp, "args.txt");
  fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CLAUDE_ARGS_FILE\"\n", { mode: 0o700 });

  const result = spawnSync(process.execPath, [
    helper,
    "workspace",
    "--path", root,
    "--no-panel",
    "implement the focused repair"
  ], {
    cwd: root,
    env: { ...process.env, PATH: `${temp}${path.delimiter}${process.env.PATH}`, CLAUDE_ARGS_FILE: argsFile },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude workspace session: [0-9a-f-]{36}/i);
  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 6), [
    "--model", "opus", "--permission-mode", "default", "--session-id", args[5]
  ]);
  assert.match(args[5], /^[0-9a-f-]{36}$/i);
  assert.deepEqual(args.slice(6), ["--bg", "implement the focused repair"]);
});

test("CLI supervision commands forward to Claude native controls", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-workspace-control-"));
  const stub = path.join(temp, "claude");
  fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
  const env = { ...process.env, PATH: `${temp}${path.delimiter}${process.env.PATH}` };

  const status = spawnSync(process.execPath, [helper, "workspace-status", "--path", root, "--all", "--json"], {
    cwd: root, env, encoding: "utf8"
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(status.stdout.trim().split("\n"), ["agents", "--cwd", root, "--all", "--json"]);

  const logs = spawnSync(process.execPath, [helper, "workspace-logs", "session-123"], {
    cwd: root, env, encoding: "utf8"
  });
  assert.equal(logs.status, 0, logs.stderr);
  assert.deepEqual(logs.stdout.trim().split("\n"), ["logs", "session-123"]);

  const stop = spawnSync(process.execPath, [helper, "workspace-stop", "session-123"], {
    cwd: root, env, encoding: "utf8"
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(stop.stdout.trim().split("\n"), ["stop", "session-123"]);
});
