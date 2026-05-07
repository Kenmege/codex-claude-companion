import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_TERMINATION_GRACE_MS = 7_500;

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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    let timedOut = false;
    let interrupted = false;
    let bufferExceeded = false;
    let terminationStarted = false;
    let killEscalated = false;
    let killTimer = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
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

    const stopChild = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "interrupt") interrupted = true;
      if (reason === "buffer") bufferExceeded = true;
      if (terminationStarted) return;
      terminationStarted = true;
      terminateChildProcessTree(child);
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

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        stopChild("buffer");
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        stopChild("buffer");
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      finish({
        status: null,
        stdout: "",
        stderr: "",
        error
      });
    });

    child.on("close", (status, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString(options.encoding ?? "utf8");
      const stderr = Buffer.concat(stderrChunks).toString(options.encoding ?? "utf8");
      const error = timedOut
        ? makeProcessError(
            killEscalated
              ? `timed out after ${options.timeout}ms; escalated to SIGKILL after grace period`
              : `timed out after ${options.timeout}ms`,
            killEscalated ? "ETIMEDOUT_KILL" : "ETIMEDOUT"
          )
        : interrupted
          ? makeProcessError("interrupted", "EINTERRUPTED")
          : bufferExceeded
            ? makeProcessError(`output exceeded ${maxBuffer} bytes`, "EMAXBUFFER")
            : null;
      finish({ status, signal, stdout, stderr, error });
    });
  });
}

export async function runCommandCaptureChecked(command, args, options = {}) {
  const result = await runCommandCapture(command, args, options);
  if (result.error) {
    throw result.error;
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
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: "ignore"
  });
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
