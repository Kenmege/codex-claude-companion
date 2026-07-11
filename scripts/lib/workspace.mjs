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

export function buildClaudeBackgroundArgs(config) {
  requireNonEmptyString(config.prompt, "coding request");
  return [
    "--model", config.model ?? DEFAULT_WORKSPACE_MODEL,
    "--permission-mode", config.plan ? "plan" : "default",
    "--bg",
    config.prompt
  ];
}

export function parseClaudeBackgroundSessionId(output) {
  const text = String(output ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const backgrounded = text.match(/^backgrounded\s+[\u00b7•]\s+([0-9a-f]{8})(?:\s|$)/im);
  if (backgrounded) return backgrounded[1];

  const controlCommand = text.match(/^\s*claude\s+(?:attach|logs|stop)\s+([0-9a-f]{8})(?:\s|$)/im);
  return controlCommand?.[1] ?? null;
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
    event.timestamp ? `at=${event.timestamp}` : null,
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

export function formatShellCommand(args) {
  return args.map(shellQuote).join(" ");
}

export function createPanelLauncher(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-panel-"));
  fs.chmodSync(directory, 0o700);
  const launcherPath = path.join(directory, "panel.command");
  const command = formatShellCommand(["/usr/bin/env", "claude", ...buildClaudePanelArgs(config)]);
  fs.writeFileSync(
    launcherPath,
    [
      "#!/bin/sh",
      `launcher_path=${shellQuote(launcherPath)}`,
      `launcher_dir=${shellQuote(directory)}`,
      '/bin/rm -f "$launcher_path"',
      '/bin/rmdir "$launcher_dir" 2>/dev/null || true',
      `cd ${shellQuote(config.cwd)} || exit 1`,
      `exec ${command}`,
      ""
    ].join("\n"),
    { mode: 0o700, flag: "wx" }
  );
  return launcherPath;
}

function removePanelLauncher(launcherPath) {
  if (!launcherPath) return;
  fs.rmSync(launcherPath, { force: true });
  try {
    fs.rmdirSync(path.dirname(launcherPath));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

export function openWorkspacePanel(config, backend, dependencies = {}) {
  if (!backend) return { opened: false, backend: null, launcherPath: null };
  const execute = dependencies.runCommand ?? runProcessCommand;
  let command;
  if (backend === "tmux") {
    command = "tmux";
  } else if (backend === "terminal-app") {
    command = "open";
  } else if (backend === "x-terminal-emulator") {
    command = "x-terminal-emulator";
  } else {
    return { opened: false, backend, launcherPath: null };
  }
  const launcherPath = (dependencies.createLauncher ?? createPanelLauncher)(config);
  const args = backend === "tmux"
    ? ["new-window", "-d", "-n", "claude-control", launcherPath]
    : backend === "terminal-app"
      ? ["-na", "Terminal.app", launcherPath]
      : ["-e", launcherPath];
  let result;
  try {
    result = execute(command, args, { cwd: config.cwd });
  } catch (error) {
    removePanelLauncher(launcherPath);
    throw error;
  }
  if (result.status !== 0) removePanelLauncher(launcherPath);
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
  const wallClock = dependencies.wallClock ?? Date.now;
  const emit = dependencies.emit ?? ((event) => defaultEmitter(event, config));
  const emitEvent = (event) => emit({
    schemaVersion: 1,
    timestamp: new Date(wallClock()).toISOString(),
    ...event
  });
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
    const dispatchStartedAt = now();
    const result = execute("claude", buildClaudeBackgroundArgs(config), { cwd: config.cwd });
    const durationMs = Math.max(0, now() - dispatchStartedAt);
    if (result.status !== 0) {
      emitEvent({ ...base, phase: "dispatch_failed", sessionId, durationMs, exitCode: result.status });
      return { status: result.status ?? 1, sessionId, panelOpened: false, error: result.error ?? null };
    }
    sessionId = parseClaudeBackgroundSessionId(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (!sessionId) {
      const error = new Error("Claude background dispatch succeeded without an authoritative session ID; refusing to report an uncontrollable worker.");
      emitEvent({ ...base, phase: "dispatch_failed", sessionId, durationMs, exitCode: 1, errorCode: "session_id_unavailable" });
      return { status: 1, sessionId, panelOpened: false, error };
    }
    emitEvent({ ...base, phase: "worker_dispatched", sessionId, durationMs });
  }

  if (!config.openPanel) {
    return { status: 0, sessionId, panelOpened: false, terminalBackend: null };
  }

  const backend = chooseBackend();
  const manualPanelCommand = ["claude", ...buildClaudePanelArgs(config)];
  if (!backend) {
    emitEvent({ ...base, phase: "panel_unavailable", sessionId });
    return { status: 0, sessionId, panelOpened: false, terminalBackend: null, manualPanelCommand };
  }

  const panelStartedAt = now();
  let panelResult;
  try {
    panelResult = openPanel(config, backend);
  } catch (error) {
    const durationMs = Math.max(0, now() - panelStartedAt);
    emitEvent({ ...base, phase: "panel_failed", sessionId, terminalBackend: backend, durationMs });
    return {
      status: 0,
      sessionId,
      panelOpened: false,
      terminalBackend: backend,
      manualPanelCommand,
      panelError: error
    };
  }
  const durationMs = Math.max(0, now() - panelStartedAt);
  if (!panelResult?.opened) {
    emitEvent({ ...base, phase: "panel_failed", sessionId, terminalBackend: backend, durationMs });
    return { status: 0, sessionId, panelOpened: false, terminalBackend: backend, manualPanelCommand };
  }
  emitEvent({ ...base, phase: "panel_opened", sessionId, terminalBackend: backend, durationMs });
  return { status: 0, sessionId, panelOpened: true, terminalBackend: backend };
}

export function runWorkspaceControl(command, args, options = {}, dependencies = {}) {
  const execute = dependencies.runCommand ?? runProcessCommand;
  return execute(command, args, { cwd: options.cwd ?? process.cwd() });
}
