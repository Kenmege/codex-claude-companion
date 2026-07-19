// Modified by Kennedy Umege for Codex-Claude Bridge, 2026.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadBrokerSession, teardownBrokerSession, clearBrokerSession, inspectBrokerProcessIdentity } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const createdTempDirs = [];
const observedRunContexts = new Map();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

/**
 * Reaps any app-server-broker process a test left running against a temp dir
 * created by makeTempDir(). Tests exercise the real CLI (review/task), which
 * lazily spawns a detached broker per repo; without this, a test that never
 * runs the SessionEnd hook leaks that broker (and its codex app-server child)
 * for the lifetime of the machine. Safe to call even when no broker exists.
 */
export function cleanupLeakedBrokers(options = {}) {
  const inspectProcess = options.inspectProcess ?? ((session, cwd) => inspectBrokerProcessIdentity(session, cwd, options));
  const killProcess = options.killProcess ?? terminateProcessTree;
  const receipt = { cleaned: 0, skippedIdentityMismatch: 0, terminatedPids: [] };

  for (const { cwd, pluginDataDir } of observedRunContexts.values()) {
    // The workspace is the ownership boundary. CLAUDE_PLUGIN_DATA may point at
    // an ambient directory outside the test's temp roots, but broker.json is
    // still namespaced to this exact registered workspace and process identity.
    // Skipping that state root would orphan the test's detached broker.
    if (!isRegisteredTempPath(cwd)) {
      continue;
    }
    withPluginDataDir(pluginDataDir, () => {
      let session;
      try {
        session = loadBrokerSession(cwd);
      } catch {
        return;
      }
      if (!session) return;

      const identity = inspectProcess(session, cwd);
      if (identity.alive && !identity.exact) {
        receipt.skippedIdentityMismatch += 1;
        return;
      }

      if (identity.alive) receipt.terminatedPids.push(session.pid);

      teardownBrokerSession({
        endpoint: session.endpoint ?? null,
        pidFile: session.pidFile ?? null,
        logFile: session.logFile ?? null,
        sessionDir: session.sessionDir ?? null,
        pid: session.pid ?? null,
        killProcess: identity.alive ? killProcess : null
      });
      clearBrokerSession(cwd);
      receipt.cleaned += 1;
    });
  }

  return receipt;
}

function defaultProcessTreeAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

/**
 * Waits until every detached broker process group signalled by
 * cleanupLeakedBrokers() is gone. Test teardown must not return while the
 * broker's app-server child is still exiting, otherwise the suite itself
 * leaks production-shaped processes into the host.
 */
export async function waitForTerminatedProcessTrees(pids, options = {}) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const processTreeAlive = options.processTreeAlive ?? defaultProcessTreeAlive;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let pending = uniquePids.filter((pid) => processTreeAlive(pid));

  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(intervalMs);
    pending = pending.filter((pid) => processTreeAlive(pid));
  }

  if (pending.length > 0) {
    throw new Error(`Timed out waiting for terminated broker process groups: ${pending.join(", ")}`);
  }

  return { reaped: uniquePids.length };
}

export function assertBrokerCleanupComplete(receipt) {
  if ((receipt?.skippedIdentityMismatch ?? 0) > 0) {
    throw new Error(
      `Test cleanup could not verify ${receipt.skippedIdentityMismatch} live broker process identity; refusing a false-green teardown.`
    );
  }
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isRegisteredTempPath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const candidate = canonicalPath(value);
  return createdTempDirs.some((root) => {
    const registeredRoot = canonicalPath(root);
    return candidate === registeredRoot || candidate.startsWith(`${registeredRoot}${path.sep}`);
  });
}

function withPluginDataDir(pluginDataDir, callback) {
  const hadValue = Object.hasOwn(process.env, "CLAUDE_PLUGIN_DATA");
  const previousValue = process.env.CLAUDE_PLUGIN_DATA;
  try {
    if (pluginDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    return callback();
  } finally {
    if (hadValue) process.env.CLAUDE_PLUGIN_DATA = previousValue;
    else delete process.env.CLAUDE_PLUGIN_DATA;
  }
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  if (options.cwd) {
    // Record the environment the child actually receives. An explicit env
    // object does not inherit omitted keys from the parent process.
    const pluginDataDir = options.env === undefined
      ? process.env.CLAUDE_PLUGIN_DATA
      : options.env && Object.hasOwn(options.env, "CLAUDE_PLUGIN_DATA")
        ? options.env.CLAUDE_PLUGIN_DATA
        : undefined;
    observedRunContexts.set(`${options.cwd}\0${pluginDataDir ?? ""}`, {
      cwd: options.cwd,
      pluginDataDir
    });
  }
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
