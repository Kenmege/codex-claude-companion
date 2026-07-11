import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { binaryAvailable, runCommand as runProcessCommand } from "./process.mjs";

export const DEFAULT_WORKSPACE_MODEL = "opus";

export function resolveWorkspaceRoot(cwd) {
  const result = runProcessCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.status === 0) return String(result.stdout).trim();
  return path.resolve(cwd);
}

function requireNonEmptyString(value, flag) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value;
}

export function createWorkspaceConfig(input = {}, invocationCwd = process.cwd()) {
  if (input.model !== undefined) requireNonEmptyString(input.model, "--model");
  if (input.panelOnly && input.noPanel) {
    throw new Error("--panel-only and --no-panel cannot be used together");
  }

  const positionals = input.positionals ?? [];
  const unknownOption = positionals.find((value) => value.startsWith("-"));
  if (unknownOption) throw new Error(`Unknown workspace option: ${unknownOption}`);

  const prompt = positionals.join(" ").trim() || null;
  if (input.panelOnly && prompt) {
    throw new Error("--panel-only cannot include a coding request");
  }
  if (input.noPanel && !prompt) {
    throw new Error("--no-panel requires a coding request");
  }
  if (!input.panelOnly && !prompt) {
    throw new Error("workspace requires a coding request; use --panel-only to open the Claude control panel");
  }

  const cwd = path.resolve(invocationCwd, input.path ?? ".");
  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw new Error(`Workspace path is not a directory: ${cwd}`);
  }
  if (!stats.isDirectory()) throw new Error(`Workspace path is not a directory: ${cwd}`);

  return {
    cwd,
    model: input.model ?? DEFAULT_WORKSPACE_MODEL,
    plan: Boolean(input.plan),
    prompt,
    panelOnly: Boolean(input.panelOnly),
    openPanel: !input.noPanel,
    jsonEvents: Boolean(input.jsonEvents)
  };
}

export function buildClaudeBackgroundArgs(config, sessionId) {
  requireNonEmptyString(sessionId, "session ID");
  requireNonEmptyString(config.prompt, "coding request");
  return [
    "--model", config.model ?? DEFAULT_WORKSPACE_MODEL,
    "--permission-mode", config.plan ? "plan" : "default",
    "--session-id", sessionId,
    "--bg",
    config.prompt
  ];
}

export function buildClaudePanelArgs(config) {
  return ["agents", "--cwd", config.cwd];
}

export function buildClaudeStatusArgs(config = {}) {
  const args = ["agents", "--cwd", config.cwd ?? process.cwd()];
  if (config.all) args.push("--all");
  if (config.json) args.push("--json");
  return args;
}

export function buildClaudeLogsArgs(sessionId) {
  return ["logs", requireNonEmptyString(sessionId, "session ID")];
}

export function buildClaudeStopArgs(sessionId) {
  return ["stop", requireNonEmptyString(sessionId, "session ID")];
}

export function formatWorkspaceEvent(event, options = {}) {
  if (options.json) return JSON.stringify(event);
  return [
    `[claude-workspace] ${event.phase}`,
    event.mode ? `mode=${event.mode}` : null,
    event.model ? `model=${event.model}` : null,
    event.codexModelRouting ? `codex_model=${event.codexModelRouting}` : null,
    event.directory ? `cwd=${event.directory}` : null,
    event.sessionId ? `session=${event.sessionId}` : null,
    event.terminalBackend ? `terminal=${event.terminalBackend}` : null,
    Number.isFinite(event.durationMs) ? `duration_ms=${event.durationMs}` : null,
    Number.isInteger(event.exitCode) ? `exit=${event.exitCode}` : null
  ].filter(Boolean).join(" ");
}

function defaultCommandAvailable(command, cwd) {
  return binaryAvailable(command, ["--help"], { cwd }).available;
}

export function selectTerminalBackend({
  platform = process.platform,
  env = process.env,
  commandAvailable = defaultCommandAvailable,
  cwd = process.cwd()
} = {}) {
  if (env.TMUX && commandAvailable("tmux", cwd)) return "tmux";
  if (platform === "darwin" && commandAvailable("open", cwd)) return "terminal-app";
  if (platform === "linux" && commandAvailable("x-terminal-emulator", cwd)) return "x-terminal-emulator";
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function createPanelLauncher(config) {
  const directory = path.join(os.tmpdir(), "codex-plugin-cc", "panels");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcherPath = path.join(directory, `claude-agents-${crypto.randomUUID()}.command`);
  const command = ["/usr/bin/env", "claude", ...buildClaudePanelArgs(config)]
    .map(shellQuote)
    .join(" ");
  fs.writeFileSync(
    launcherPath,
    `#!/bin/sh\ncd ${shellQuote(config.cwd)} || exit 1\nexec ${command}\n`,
    { mode: 0o700 }
  );
  return launcherPath;
}

export function openWorkspacePanel(config, backend, dependencies = {}) {
  if (!backend) return { opened: false, backend: null, launcherPath: null };
  const execute = dependencies.runCommand ?? runProcessCommand;
  const launcherPath = (dependencies.createLauncher ?? createPanelLauncher)(config);
  let command;
  let args;
  if (backend === "tmux") {
    command = "tmux";
    args = ["new-window", "-d", "-n", "claude-control", launcherPath];
  } else if (backend === "terminal-app") {
    command = "open";
    args = ["-na", "Terminal.app", launcherPath];
  } else if (backend === "x-terminal-emulator") {
    command = "x-terminal-emulator";
    args = ["-e", launcherPath];
  } else {
    return { opened: false, backend, launcherPath };
  }
  const result = execute(command, args, { cwd: config.cwd });
  return {
    opened: result.status === 0,
    backend,
    launcherPath,
    status: result.status,
    error: result.error ?? null
  };
}

function defaultEmitter(event, config) {
  process.stderr.write(`${formatWorkspaceEvent(event, { json: config.jsonEvents })}\n`);
}

export async function runWorkspace(config, dependencies = {}) {
  const commandAvailable = dependencies.commandAvailable ?? defaultCommandAvailable;
  const execute = dependencies.runCommand ?? runProcessCommand;
  const now = dependencies.now ?? Date.now;
  const emit = dependencies.emit ?? ((event) => defaultEmitter(event, config));
  const chooseBackend = dependencies.selectBackend ?? (() => selectTerminalBackend({
    commandAvailable,
    cwd: config.cwd
  }));
  const openPanel = dependencies.openPanel ?? ((panelConfig, backend) => openWorkspacePanel(
    panelConfig,
    backend,
    { runCommand: execute }
  ));

  if (!commandAvailable("claude", config.cwd)) {
    throw new Error("Claude Code CLI is not available. Install it and run `claude doctor`, then retry.");
  }

  const base = {
    command: "workspace",
    mode: config.plan ? "plan" : "coding",
    model: config.model ?? DEFAULT_WORKSPACE_MODEL,
    codexModelRouting: "active-session",
    directory: config.cwd
  };

  let sessionId = null;
  if (!config.panelOnly) {
    sessionId = (dependencies.generateSessionId ?? crypto.randomUUID)();
    const dispatchStartedAt = now();
    const result = execute("claude", buildClaudeBackgroundArgs(config, sessionId), { cwd: config.cwd });
    const durationMs = Math.max(0, now() - dispatchStartedAt);
    if (result.status !== 0) {
      emit({ ...base, phase: "dispatch_failed", sessionId, durationMs, exitCode: result.status });
      return { status: result.status ?? 1, sessionId, panelOpened: false, error: result.error ?? null };
    }
    emit({ ...base, phase: "worker_dispatched", sessionId, durationMs });
  }

  if (!config.openPanel) {
    return { status: 0, sessionId, panelOpened: false, terminalBackend: null };
  }

  const backend = chooseBackend();
  const manualPanelCommand = ["claude", ...buildClaudePanelArgs(config)];
  if (!backend) {
    emit({ ...base, phase: "panel_unavailable", sessionId });
    return { status: 0, sessionId, panelOpened: false, terminalBackend: null, manualPanelCommand };
  }

  const panelStartedAt = now();
  const panelResult = openPanel(config, backend);
  const durationMs = Math.max(0, now() - panelStartedAt);
  if (!panelResult?.opened) {
    emit({ ...base, phase: "panel_failed", sessionId, terminalBackend: backend, durationMs });
    return { status: 0, sessionId, panelOpened: false, terminalBackend: backend, manualPanelCommand };
  }
  emit({ ...base, phase: "panel_opened", sessionId, terminalBackend: backend, durationMs });
  return { status: 0, sessionId, panelOpened: true, terminalBackend: backend };
}

export function runWorkspaceControl(command, args, options = {}, dependencies = {}) {
  const execute = dependencies.runCommand ?? runProcessCommand;
  return execute(command, args, { cwd: options.cwd ?? process.cwd() });
}
