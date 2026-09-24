#!/usr/bin/env node

// Runs `node --test` inside a private temporary root and removes that root however the run ends.
//
// The suites create hundreds of fs.mkdtempSync() directories, and the code under test creates its own
// (broker session dirs, MCP staging, panels, the codex-companion fallback state root). Almost none of them
// are removed, so every local run left several hundred entries in the shared system temp directory.
// Pointing TMPDIR/TMP/TEMP at one per-run root isolates all of them — including those made by child
// processes the tests spawn — and lets a single removal clean up after the whole run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

// Keep the root name short: Unix socket paths (broker.sock) are created beneath it, and macOS limits
// them to 104 bytes.
// Absolute even when the incoming TMPDIR is relative: children run with other working directories.
const root = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "cct-")));
const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };

function removeRoot() {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (error) {
    process.stderr.write(`run-tests: could not remove temporary root ${root}: ${error.message}\n`);
    return false;
  }
}

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit", env });

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
for (const signal of forwardedSignals) process.on(signal, forward);

child.on("error", (error) => {
  process.stderr.write(`run-tests: could not start node --test: ${error.message}\n`);
  removeRoot();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  const removed = removeRoot();
  if (signal) {
    // Re-raise so callers see the same signal; the exit code covers a platform that cannot deliver it,
    // so a killed run can never end as a success.
    process.exitCode = 128 + (os.constants.signals[signal] ?? 0);
    for (const forwarded of forwardedSignals) process.off(forwarded, forward);
    process.kill(process.pid, signal);
    return;
  }
  // A run that could not clean up after itself fails even when every test passed.
  const status = code ?? 1;
  process.exit(status === 0 && !removed ? 1 : status);
});
