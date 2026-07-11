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

test("runCommandCapture stops retaining output at maxBuffer while terminating a noisy child", { skip: process.platform === "win32" }, async () => {
  const maxBuffer = 1_024;
  const result = await runCommandCapture(
    process.execPath,
    [
      "-e",
      [
        "process.on('SIGTERM',()=>{",
        "process.stdout.write('stdout-after-limit');",
        "process.stderr.write('stderr-after-limit');",
        "setTimeout(()=>process.exit(0),20);",
        "});",
        "process.stdout.write('x'.repeat(4096));",
        "setInterval(()=>{},1000);"
      ].join("")
    ],
    { timeout: 5_000, terminationGraceMs: 200, maxBuffer, tailBytes: maxBuffer }
  );

  assert.equal(result.error?.code, "EMAXBUFFER");
  assert.equal(result.reason, "buffer");
  assert.ok(result.stdoutBytes > maxBuffer, `expected observed bytes > ${maxBuffer}, got ${result.stdoutBytes}`);
  assert.ok(Buffer.byteLength(result.stdout) <= maxBuffer);
  assert.ok(Buffer.byteLength(result.stdoutTail) <= maxBuffer);
  assert.match(result.stdoutTail, /stdout-after-limit/);
  assert.match(result.stderrTail, /stderr-after-limit/);
  assert.ok(result.stdoutBytes >= 4096 + Buffer.byteLength("stdout-after-limit"));
  assert.ok(result.stderrBytes >= Buffer.byteLength("stderr-after-limit"));
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

test("spawnDetached closes an opened input descriptor when log setup fails", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-process-fd-"));
  const inputPath = path.join(cwd, "input.txt");
  const logFile = path.join(cwd, "child.log");
  fs.writeFileSync(inputPath, "prompt\n", "utf8");

  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  let inputFd;
  let inputCloseCount = 0;
  fs.openSync = function patchedOpenSync(file, ...args) {
    if (file === logFile) {
      const error = new Error("simulated log open failure");
      error.code = "EACCES";
      throw error;
    }
    const fd = originalOpenSync.call(this, file, ...args);
    if (file === inputPath) inputFd = fd;
    return fd;
  };
  fs.closeSync = function patchedCloseSync(fd) {
    if (fd === inputFd) inputCloseCount += 1;
    return originalCloseSync.call(this, fd);
  };

  try {
    assert.throws(
      () => spawnDetached(process.execPath, ["-e", ""], { cwd, inputPath, logFile }),
      /simulated log open failure/
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
  }
  assert.equal(inputCloseCount, 1);
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

test("runCommandCapture catches descendants launched during early-stop termination", {
  skip: process.platform === "win32"
}, async () => {
  const startedAt = Date.now();
  const result = await runCommandCapture(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "});",
        "setTimeout(() => process.stdout.write('ready'), 50);",
        "setInterval(() => {}, 1000);"
      ].join("")
    ],
    {
      timeout: 1_500,
      shouldStopEarly: ({ stdout }) => stdout.includes("ready"),
      earlyStopReason: "structured_output_complete"
    }
  );

  assert.equal(result.error, null);
  assert.equal(result.completedEarly, true);
  assert.ok(result.killEscalated, "early completion should re-signal the process group after a short grace period");
  assert.ok(Date.now() - startedAt < 900, "a late descendant must not keep inherited output pipes open");
});

test("runCommandCapture confirms a TERM-resistant process tree is closed before early success", {
  skip: process.platform === "win32"
}, async () => {
  let childPid = null;
  const startedAt = Date.now();
  const result = await runCommandCapture(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(`descendant:${descendant.pid}\\nready\\n`);",
        "setInterval(() => {}, 1000);"
      ].join("")
    ],
    {
      timeout: 5_000,
      terminationGraceMs: 75,
      onSpawn: ({ pid }) => { childPid = pid; },
      shouldStopEarly: ({ stdout }) => stdout.includes("ready"),
      earlyStopReason: "structured_output_complete"
    }
  );

  const descendantPid = Number(result.stdout.match(/descendant:(\d+)/)?.[1]);
  assert.equal(result.error, null);
  assert.equal(result.completedEarly, true);
  assert.equal(result.killEscalated, true);
  assert.ok(Date.now() - startedAt >= 60, "resolution must wait for bounded kill escalation");
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
});

test("runCommandCapture preserves cumulative callback output across many chunks", async () => {
  const callbackLengths = [];
  const result = await runCommandCapture(
    process.execPath,
    ["-e", "let n=0;const t=setInterval(()=>{process.stdout.write(String(n%10));if(++n===128)clearInterval(t)},1)"],
    {
      timeout: 5_000,
      onStdout: ({ stdout }) => callbackLengths.push(stdout.length)
    }
  );

  assert.equal(result.error, null, result.stderr);
  assert.equal(result.stdout.length, 128);
  assert.ok(callbackLengths.length > 1);
  assert.equal(callbackLengths.at(-1), result.stdout.length);
  assert.ok(callbackLengths.every((length, index) => index === 0 || length >= callbackLengths[index - 1]));
});

test("runCommandCapture preserves UTF-8 characters split across chunks", async () => {
  const callbackOutput = [];
  const result = await runCommandCapture(
    process.execPath,
    [
      "-e",
      "process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x9a,0x80])),10)"
    ],
    {
      timeout: 5_000,
      onStdout: ({ stdout }) => callbackOutput.push(stdout)
    }
  );

  assert.equal(result.error, null, result.stderr);
  assert.equal(result.stdout, "🚀");
  assert.equal(callbackOutput.at(-1), "🚀");
});
