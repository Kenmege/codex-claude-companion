import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_TERMINATION_GRACE_MS = 7_500;
export const DEFAULT_EARLY_TERMINATION_GRACE_MS = 100;
export const DEFAULT_CAPTURE_TAIL_BYTES = 64 * 1024;

function isPathCommand(command) {
  return command.includes("/") || command.includes("\\");
}

function findExecutableOnProcessPath(command) {
  const searchPath = String(process.env.PATH ?? "");
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return command;
}

function resolveExecutable(command) {
  if (typeof command !== "string" || command.trim() !== command || command.length === 0) {
    throw new Error("Command must be a non-empty executable name or path");
  }
  if (isPathCommand(command)) {
    return command;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(command)) {
    throw new Error(`Unsafe executable name: ${command}`);
  }
  return findExecutableOnProcessPath(command);
}

export function runCommand(command, args, options = {}) {
  return spawnSync(resolveExecutable(command), args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout,
    input: options.inputData,
    // Hard-kill on timeout so a child that ignores SIGTERM (e.g. a stalled
    // `claude` binary waiting on a first-run prompt) cannot wedge the caller.
    killSignal: options.killSignal ?? "SIGKILL"
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
    let executable;
    try {
      executable = resolveExecutable(command);
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
        reason: "unsafe_command",
        error: err
      });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutDecoder = new StringDecoder(options.encoding ?? "utf8");
    const stderrDecoder = new StringDecoder(options.encoding ?? "utf8");
    let stdoutText = "";
    let stderrText = "";
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const tailBytes = options.tailBytes ?? DEFAULT_CAPTURE_TAIL_BYTES;

    // Optional input transport: feed bytes into the child's stdin so the caller does
    // not have to put a large prompt into argv. Avoids platform argv length limits
    // (Windows ~32K, macOS ~256K) and removes a class of quoting bugs.
    //
    // Two flavours:
    //   - `inputPath` (file path) — preferred when the prompt is already persisted
    //     somewhere durable (e.g. .claude-review/jobs/<id>.prompt.md). We open the
    //     fd and hand it to spawn() as stdio[0]. NOT recommended for paths under
    //     os.tmpdir() — CodeQL's js/insecure-temporary-file flags that pattern.
    //   - `inputData` (string|Buffer) — preferred when the prompt is ephemeral.
    //     We pipe the bytes through child.stdin and end the stream. No file on
    //     disk, no temp dir, no cleanup, no CodeQL alert.
    let stdinFd = null;
    const stdinMode = options.inputData !== undefined ? "pipe" : (options.inputPath ? "fd" : "ignore");
    if (stdinMode === "fd") {
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

    const stdioStdin = stdinMode === "fd" ? stdinFd : (stdinMode === "pipe" ? "pipe" : "ignore");

    // codeql[js/shell-command-injection-from-environment]
    // codeql[js/indirect-command-line-injection]
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [stdioStdin, "pipe", "pipe"]
    });

    if (stdinMode === "fd") {
      // Once spawn() dup's the fd into the child, our handle is no longer needed.
      // JUSTIFIED: close-on-already-closed fd is harmless and uncommon — node owns fd lifecycle for the child after spawn
      try { fs.closeSync(stdinFd); } catch (_closeErr) { /* fd handed to child */ }
    } else if (stdinMode === "pipe") {
      // Some children (notably stub binaries that exit quickly, or claude in error
      // states) close stdin before we finish writing — surfaces as EPIPE here. The
      // child's exit code and stderr already tell the caller what happened; this
      // handler prevents the EPIPE from crashing the parent.
      // JUSTIFIED: EPIPE means the child closed stdin early — that's the child's signal, not our error
      child.stdin.on("error", (_err) => { /* child closed stdin — observed via exit code */ });
      // Write the entire prompt and close stdin so the child receives EOF.
      child.stdin.end(options.inputData);
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutRetainedBytes = 0;
    let stderrRetainedBytes = 0;
    let stdoutCaptureClosed = false;
    let stderrCaptureClosed = false;
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
      const terminationGraceMs = options.terminationGraceMs
        ?? (earlyCompleted ? DEFAULT_EARLY_TERMINATION_GRACE_MS : DEFAULT_TERMINATION_GRACE_MS);
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
      if (stdoutCaptureClosed) return;
      const remaining = Math.max(0, maxBuffer - stdoutRetainedBytes);
      const retained = chunk.subarray(0, remaining);
      if (retained.length > 0) {
        stdoutRetainedBytes += retained.length;
        stdoutChunks.push(retained);
      }
      const text = stdoutDecoder.write(retained);
      stdoutText += text;
      safeCallback(options.onStdout, { pid: child.pid, chunk: retained, text, stdoutBytes, stdout: stdoutText, stderr: stderrText });
      if (stdoutBytes > maxBuffer) {
        stdoutCaptureClosed = true;
        stopChild("buffer");
        return;
      }
      if (typeof options.shouldStopEarly === "function") {
        let shouldStop = false;
        try {
          shouldStop = Boolean(options.shouldStopEarly({
            pid: child.pid,
            stdout: stdoutText,
            stderr: stderrText,
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
      if (stderrCaptureClosed) return;
      const remaining = Math.max(0, maxBuffer - stderrRetainedBytes);
      const retained = chunk.subarray(0, remaining);
      if (retained.length > 0) {
        stderrRetainedBytes += retained.length;
        stderrChunks.push(retained);
      }
      const text = stderrDecoder.write(retained);
      stderrText += text;
      safeCallback(options.onStderr, { pid: child.pid, chunk: retained, text, stderrBytes });
      if (stderrBytes > maxBuffer) {
        stderrCaptureClosed = true;
        stopChild("buffer");
        return;
      }
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
        completedEarly: earlyCompleted,
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
  const executable = resolveExecutable(command);
  let child;
  try {
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

    child = spawn(executable, args, {
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

// On Windows, `process.kill(pid, signal)` only signals the single PID — descendants
// survive. The native equivalent of "kill the process tree" is `taskkill /t` (which
// recursively terminates child processes). We invoke it synchronously via spawnSync
// so existing callers (which assume sync termination) keep working unchanged.
function windowsTaskkill(pid, { force }) {
  const args = force ? ["/pid", String(pid), "/t", "/f"] : ["/pid", String(pid), "/t"];
  const result = spawnSync("taskkill", args, { windowsHide: true });
  if (result.error) return false;
  // taskkill returns 0 on success and 128 when the process is already gone — both
  // are "tree is dead" from our caller's perspective.
  return result.status === 0 || result.status === 128;
}

export function terminateProcessTree(pid) {
  if (!pid) {
    return false;
  }

  if (process.platform === "win32") {
    return windowsTaskkill(pid, { force: false });
  }

  for (const target of [-Math.abs(pid), Math.abs(pid)]) {
    try {
      process.kill(target, "SIGTERM");
      return true;
    } catch (_err) {
      // JUSTIFIED: kill races with the child exiting; try the next target form (group then direct)
    }
  }

  return false;
}

export function killProcessTree(pid) {
  if (!pid) {
    return false;
  }

  if (process.platform === "win32") {
    return windowsTaskkill(pid, { force: true });
  }

  for (const target of [-Math.abs(pid), Math.abs(pid)]) {
    try {
      process.kill(target, "SIGKILL");
      return true;
    } catch (_err) {
      // JUSTIFIED: kill races with the child exiting; try the next target form (group then direct)
    }
  }

  return false;
}
