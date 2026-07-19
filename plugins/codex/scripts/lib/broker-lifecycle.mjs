// Modified by Kennedy Umege for Codex-Claude Bridge, 2026.
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

function defaultBrokerScriptPath() {
  return fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
}

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, identityToken, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [
    scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile,
    "--identity-token", identityToken
  ], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function inspectBrokerProcessIdentity(session, cwd, options = {}) {
  if (!Number.isInteger(session?.pid) || session.pid < 1) return { alive: false, exact: false };
  const alive = (options.processAlive ?? processIsAlive)(session.pid);
  if (!alive) return { alive: false, exact: false };

  const platform = options.platform ?? process.platform;
  const listProcess = options.listProcess ?? spawnSync;
  const result = platform === "win32"
    ? listProcess("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${session.pid}').CommandLine`
      ], { encoding: "utf8", windowsHide: true })
    : listProcess("ps", ["-ww", "-p", String(session.pid), "-o", "command="], {
        encoding: "utf8", windowsHide: true
      });
  if (result.status !== 0 || typeof result.stdout !== "string") return { alive: true, exact: false };
  const command = result.stdout.trim();

  if (BROKER_IDENTITY_PATTERN.test(session.identityToken ?? "")) {
    const tokenFlag = `--identity-token ${session.identityToken}`;
    const tokenEquals = `--identity-token=${session.identityToken}`;
    return { alive: true, exact: command.includes(tokenFlag) || command.includes(tokenEquals) };
  }
  if (platform === "win32") return { alive: true, exact: false };

  const canonicalCwd = fs.realpathSync.native(path.resolve(cwd));
  const expectedCommand = [
    process.execPath,
    session.scriptPath ?? defaultBrokerScriptPath(),
    "serve",
    "--endpoint", session.endpoint,
    "--cwd", canonicalCwd,
    "--pid-file", session.pidFile
  ].join(" ");
  return { alive: true, exact: command === expectedCommand };
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    const identity = (options.inspectProcess ?? inspectBrokerProcessIdentity)(existing, cwd, options);
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: identity.alive && identity.exact ? (options.killProcess ?? null) : null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath = options.scriptPath ?? defaultBrokerScriptPath();
  const identityToken = options.identityToken ?? crypto.randomBytes(32).toString("hex");
  if (!BROKER_IDENTITY_PATTERN.test(identityToken)) {
    throw new Error("broker identity token must be a 64-character lowercase hexadecimal value");
  }

  const child = (options.spawnBrokerProcess ?? spawnBrokerProcess)({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    identityToken,
    env: options.env ?? process.env
  });

  const ready = await (options.waitForBrokerEndpoint ?? waitForBrokerEndpoint)(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    scriptPath,
    identityToken
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
