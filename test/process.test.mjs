import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommandCapture, spawnDetached } from "../scripts/lib/process.mjs";

test("runCommandCapture escalates timeout to SIGKILL when SIGTERM is ignored", { skip: process.platform === "win32" }, async () => {
  const result = await runCommandCapture(
    "sh",
    ["-c", "trap '' TERM; while :; do sleep 1; done"],
    { timeout: 50, terminationGraceMs: 50 }
  );

  assert.equal(result.error?.code, "ETIMEDOUT_KILL");
});

test("spawnDetached redirects early stdout and stderr to a log file", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-process-"));
  const logFile = path.join(cwd, "child.log");

  const pid = spawnDetached(
    process.execPath,
    ["-e", "console.log('early stdout'); console.error('early stderr')"],
    { cwd, logFile }
  );

  assert.equal(typeof pid, "number");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(logFile)) {
      const source = fs.readFileSync(logFile, "utf8");
      if (source.includes("early stdout") && source.includes("early stderr")) {
        assert.match(source, /early stdout/);
        assert.match(source, /early stderr/);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail(`detached child output was not written to ${logFile}`);
});


test("runCommandCapture exposes timeout diagnostics and lifecycle callbacks", async () => {
  const events = [];
  const result = await runCommandCapture(
    "sh",
    ["-c", "echo before-timeout; echo err-before-timeout >&2; sleep 2"],
    {
      timeout: 50,
      terminationGraceMs: 50,
      onSpawn: (meta) => events.push(["spawn", meta.pid]),
      onStdout: () => events.push(["stdout"]),
      onStderr: () => events.push(["stderr"]),
      onTimeout: (meta) => events.push(["timeout", meta.timeoutMs]),
      onClose: (meta) => events.push(["close", meta.status, meta.signal])
    }
  );

  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.reason, "timeout");
  assert.equal(result.timeoutMs, 50);
  assert.equal(typeof result.pid, "number");
  assert.match(result.stdoutTail, /before-timeout/);
  assert.match(result.stderrTail, /err-before-timeout/);
  assert.equal(events[0][0], "spawn");
  assert.ok(events.some(([name]) => name === "stdout"));
  assert.ok(events.some(([name]) => name === "stderr"));
  assert.ok(events.some(([name]) => name === "timeout"));
  assert.equal(events.at(-1)[0], "close");
});
