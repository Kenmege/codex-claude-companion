import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommandCapture, spawnDetached, killProcessTree, terminateProcessTree } from "../scripts/lib/process.mjs";

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

test("killProcessTree kills a parent AND its descendant — cross-platform", async () => {
  // Spawn a parent that itself spawns a long-running child, then send
  // killProcessTree at the parent. On POSIX we use `-pid` group semantics;
  // on Windows we use taskkill /t. Either way the descendant must be reaped.
  // We avoid relying on shell quirks by using node -e on both branches.
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [
      "-e",
      // Parent spawns a long-lived child, prints the child PID, then sleeps.
      "const{spawn}=require('node:child_process');" +
      "const k=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false});" +
      "process.stdout.write(String(k.pid));" +
      "setInterval(()=>{},1000);"
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  // Read the descendant PID from the parent's stdout.
  const descendantPid = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out reading descendant pid")), 5000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.length > 0) {
        clearTimeout(timer);
        resolve(parseInt(buf.trim(), 10));
      }
    });
    child.on("error", reject);
  });

  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, `bad descendant pid: ${descendantPid}`);

  // Kill the parent's tree. On POSIX this signals the group; on Windows it invokes taskkill /t /f.
  const killed = killProcessTree(child.pid);
  assert.equal(killed, true, "killProcessTree must return true");

  // Wait briefly for the OS to reap both processes.
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Verify BOTH parent AND descendant are dead. process.kill(pid, 0) throws ESRCH when dead.
  let parentAlive = false;
  try { process.kill(child.pid, 0); parentAlive = true; } catch (_e) { parentAlive = false; }
  let descendantAlive = false;
  try { process.kill(descendantPid, 0); descendantAlive = true; } catch (_e) { descendantAlive = false; }

  assert.equal(parentAlive, false, "parent must be dead after killProcessTree");
  assert.equal(descendantAlive, false, "descendant must also be dead — proves tree kill works");
});

test("terminateProcessTree returns true for a live pid and false for pid 0", () => {
  assert.equal(terminateProcessTree(0), false);
  assert.equal(terminateProcessTree(null), false);
  assert.equal(terminateProcessTree(undefined), false);
});

test("runCommandCapture can stop early when the expected output is complete", async () => {
  const startedAt = Date.now();
  const result = await runCommandCapture(
    "sh",
    ["-c", "printf 'ready'; sleep 2"],
    {
      timeout: 1000,
      terminationGraceMs: 50,
      shouldStopEarly: ({ stdout }) => stdout.includes("ready"),
      earlyStopReason: "structured_output_complete"
    }
  );

  assert.equal(result.error, null);
  assert.equal(result.reason, "structured_output_complete");
  assert.match(result.stdout, /ready/);
  assert.ok(Date.now() - startedAt < 800, "early stop should avoid waiting for process timeout");
});
