import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TERMINATION_GRACE_MS = 7_500;
export const DEFAULT_CAPTURE_TAIL_BYTES = 64 * 1024;

export function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout
  });
}

export function formatCommandFailure(result) {
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const output = stderr || stdout || "no output";
  return `${result.status ?? "unknown"}: ${output}`;
}

export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function makeProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function appendTail(current, chunk, limitBytes) {
  const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
  if (next.length <= limitBytes) return next;
  return next.subarray(next.length - limitBytes);
}

function safeCallback(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(payload);
  } catch {}
}

function terminateChildProcessTree(child) {
  if (!child?.pid) {
    return false;
  }
  return terminateProcessTree(child.pid);
}

function killChildProcessTree(child) {
  if (!child?.pid) {
    return false;
  }
  return killProcessTree(child.pid);
}

export function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const tailBytes = options.tailBytes ?? DEFAULT_CAPTURE_TAIL_BYTES;

    // Optional input transport: pipe a file's contents into the child's stdin so the
    // caller does not have to put a large prompt into argv. Avoids platform argv
    // length limits (Windows ~32K, macOS ~256K) and removes a class of quoting bugs.
    let stdinFd = null;
    if (options.inputPath) {
      try {
        stdinFd = fs.openSync(options.inputPath, "r");
      } catch (err) {
        resolve({
          pid: null,
          command,
          args,
          cwd: options.cwd,
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTail: "",
          stderrTail: "",
          reason: "input_open_error",
          error: err
        });
        return;
      }
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [stdinFd ?? "ignore", "pipe", "pipe"]
    });

    if (stdinFd !== null) {
      // Once spawn() dup's the fd into the child, our handle is no longer needed.
      // JUSTIFIED: close-on-already-closed fd is harmless and uncommon — node owns fd lifecycle for the child after spawn
      try { fs.closeSync(stdinFd); } catch (_closeErr) { /* fd handed to child */ }
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let finished = false;
    let reason = null;
    let timedOut = false;
    let noOutputTimedOut = false;
    let interrupted = false;
    let bufferExceeded = false;
    let earlyCompleted = false;
    let terminationStarted = false;
    let killEscalated = false;
    let killTimer = null;
    let firstOutputSeen = false;

    safeCallback(options.onSpawn, { pid: child.pid, command, args, cwd: options.cwd });

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (noOutputTimeout) clearTimeout(noOutputTimeout);
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };

    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const stopChild = (stopReason) => {
      reason = reason ?? stopReason;
      if (stopReason === "timeout") timedOut = true;
      if (stopReason === "no_output_timeout") noOutputTimedOut = true;
      if (stopReason === "interrupt") interrupted = true;
      if (stopReason === "buffer") bufferExceeded = true;
      if (stopReason === (options.earlyStopReason ?? "early_complete")) earlyCompleted = true;
      if (earlyCompleted) {
        if (timeout) clearTimeout(timeout);
        if (noOutputTimeout) clearTimeout(noOutputTimeout);
        safeCallback(options.onEarlyStop, { pid: child.pid, reason: stopReason });
      }
      if (stopReason === "timeout") {
        safeCallback(options.onTimeout, { pid: child.pid, timeoutMs: options.timeout });
      }
      if (stopReason === "no_output_timeout") {
        safeCallback(options.onNoOutputTimeout, { pid: child.pid, noOutputTimeoutMs: options.noOutputTimeout });
      }
      if (terminationStarted) return;
      terminationStarted = true;
      terminateChildProcessTree(child);
      if (earlyCompleted) {
        killEscalated = killChildProcessTree(child) || killEscalated;
        const stdout = Buffer.concat(stdoutChunks).toString(options.encoding ?? "utf8");
        const stderr = Buffer.concat(stderrChunks).toString(options.encoding ?? "utf8");
        const payload = {
          pid: child.pid,
          command,
          args,
          cwd: options.cwd,
          status: null,
          signal: null,
          stdout,
          stderr,
          stdoutTail: stdoutTail.toString(options.encoding ?? "utf8"),
          stderrTail: stderrTail.toString(options.encoding ?? "utf8"),
          stdoutBytes,
          stderrBytes,
          reason,
          timeoutMs: options.timeout ?? null,
          noOutputTimeoutMs: options.noOutputTimeout ?? null,
          killEscalated,
          completedEarly: true,
          error: null
        };
        safeCallback(options.onClose, payload);
        finish(payload);
        return;
      }
      const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
      killTimer = setTimeout(() => {
        killEscalated = killChildProcessTree(child);
      }, terminationGraceMs);
    };

    const onInterrupt = () => stopChild("interrupt");
    const onTerminate = () => stopChild("interrupt");

    const timeout = options.timeout
      ? setTimeout(() => stopChild("timeout"), options.timeout)
      : null;
    const noOutputTimeout = options.noOutputTimeout
      ? setTimeout(() => {
          if (!firstOutputSeen) stopChild("no_output_timeout");
        }, options.noOutputTimeout)
      : null;

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);

    child.stdout.on("data", (chunk) => {
      firstOutputSeen = true;
      if (noOutputTimeout) clearTimeout(noOutputTimeout);
      stdoutBytes += chunk.length;
      stdoutTail = appendTail(stdoutTail, chunk, tailBytes);
      stdoutChunks.push(chunk);
      const stdout = Buffer.concat(stdoutChunks).toString(options.encoding ?? "utf8");
      const stderr = Buffer.concat(stderrChunks).toString(options.encoding ?? "utf8");
      safeCallback(options.onStdout, { pid: child.pid, chunk, text: chunk.toString(options.encoding ?? "utf8"), stdoutBytes, stdout, stderr });
      if (stdoutBytes > maxBuffer) {
        stopChild("buffer");
        return;
      }
      if (typeof options.shouldStopEarly === "function") {
        let shouldStop = false;
        try {
          shouldStop = Boolean(options.shouldStopEarly({
            pid: child.pid,
            stdout,
            stderr,
            stdoutTail: stdoutTail.toString(options.encoding ?? "utf8"),
            stderrTail: stderrTail.toString(options.encoding ?? "utf8"),
            stdoutBytes,
            stderrBytes
          }));
        } catch {}
        if (shouldStop) {
          stopChild(options.earlyStopReason ?? "early_complete");
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      firstOutputSeen = true;
      if (noOutputTimeout) clearTimeout(noOutputTimeout);
      stderrBytes += chunk.length;
      stderrTail = appendTail(stderrTail, chunk, tailBytes);
      safeCallback(options.onStderr, { pid: child.pid, chunk, text: chunk.toString(options.encoding ?? "utf8"), stderrBytes });
      if (stderrBytes > maxBuffer) {
        stopChild("buffer");
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      if (finished) return;
      finish({
        pid: child.pid,
        command,
        args,
        cwd: options.cwd,
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTail: stdoutTail.toString(options.encoding ?? "utf8"),
        stderrTail: stderrTail.toString(options.encoding ?? "utf8"),
        reason: "spawn_error",
        error
      });
    });

    child.on("close", (status, signal) => {
      if (finished) return;
      const stdout = Buffer.concat(stdoutChunks).toString(options.encoding ?? "utf8");
      const stderr = Buffer.concat(stderrChunks).toString(options.encoding ?? "utf8");
      const error = earlyCompleted
        ? null
        : timedOut
          ? makeProcessError(
            killEscalated
              ? `timed out after ${options.timeout}ms; escalated to SIGKILL after grace period`
              : `timed out after ${options.timeout}ms`,
            killEscalated ? "ETIMEDOUT_KILL" : "ETIMEDOUT"
          )
        : noOutputTimedOut
          ? makeProcessError(`no output from child after ${options.noOutputTimeout}ms`, "ENOOUTPUT")
          : interrupted
            ? makeProcessError("interrupted", "EINTERRUPTED")
            : bufferExceeded
              ? makeProcessError(`output exceeded ${maxBuffer} bytes`, "EMAXBUFFER")
              : null;
      const payload = {
        pid: child.pid,
        command,
        args,
        cwd: options.cwd,
        status,
        signal,
        stdout,
        stderr,
        stdoutTail: stdoutTail.toString(options.encoding ?? "utf8"),
        stderrTail: stderrTail.toString(options.encoding ?? "utf8"),
        stdoutBytes,
        stderrBytes,
        reason,
        timeoutMs: options.timeout ?? null,
        noOutputTimeoutMs: options.noOutputTimeout ?? null,
        killEscalated,
        error
      };
      safeCallback(options.onClose, payload);
      finish(payload);
    });
  });
}

export async function runCommandCaptureChecked(command, args, options = {}) {
  const result = await runCommandCapture(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.completedEarly) {
    return result;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, args = ["--help"], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    const code = typeof result.error === "object" && result.error && "code" in result.error ? result.error.code : "error";
    return { available: false, detail: `${command} unavailable (${code})` };
  }
  return {
    available: result.status === 0 || result.status === 1,
    detail: String(result.stdout || result.stderr || "").split(/\r?\n/).find(Boolean) ?? `${command} available`
  };
}

export function spawnDetached(command, args, options = {}) {
  const openFds = [];
  let stdinFd = "ignore";

  // Pipe a file's contents to the detached child's stdin (avoid putting large
  // prompts into argv, which hits the Windows command-line length limit).
  if (options.inputPath) {
    const fd = fs.openSync(options.inputPath, "r");
    openFds.push(fd);
    stdinFd = fd;
  }

  let stdio = stdinFd === "ignore" ? "ignore" : [stdinFd, "ignore", "ignore"];

  if (options.logFile) {
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    const logFd = fs.openSync(options.logFile, "a", 0o600);
    openFds.push(logFd);
    stdio = [stdinFd === "ignore" ? "ignore" : stdinFd, logFd, logFd];
  }

  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio
    });
  } finally {
    for (const fd of openFds) {
      // JUSTIFIED: fds have been dup'd into the spawned child; closing the parent handle is best-effort
      try { fs.closeSync(fd); } catch (_closeErr) { /* parent handle release */ }
    }
  }
  child.unref();
  return child.pid;
}

export function terminateProcessTree(pid) {
  if (!pid) {
    return false;
  }

  for (const target of [-Math.abs(pid), Math.abs(pid)]) {
    try {
      process.kill(target, "SIGTERM");
      return true;
    } catch {}
  }

  return false;
}

export function killProcessTree(pid) {
  if (!pid) {
    return false;
  }

  const targets = process.platform === "win32" ? [Math.abs(pid)] : [-Math.abs(pid), Math.abs(pid)];
  for (const target of targets) {
    try {
      process.kill(target, "SIGKILL");
      return true;
    } catch {}
  }

  return false;
}
