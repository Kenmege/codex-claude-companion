import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadBrokerSession, teardownBrokerSession, clearBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const createdTempDirs = [];

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
export function cleanupLeakedBrokers() {
  for (const dir of createdTempDirs) {
    let session;
    try {
      session = loadBrokerSession(dir);
    } catch {
      continue;
    }
    if (!session) {
      continue;
    }
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: session.pid ?? null,
      killProcess: terminateProcessTree
    });
    clearBrokerSession(dir);
  }
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
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
