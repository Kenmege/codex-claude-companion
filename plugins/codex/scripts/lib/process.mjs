import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

const PROCESS_INSPECTION_TIMEOUT_MS = 2_000;

function inspectProcessCommandLine(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const inspectProcess = options.inspectProcess ?? spawnSync;
  const inspection = {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.processInspectionTimeoutMs ?? PROCESS_INSPECTION_TIMEOUT_MS
  };
  const result = platform === "win32"
    ? inspectProcess("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`
      ], inspection)
    : inspectProcess("ps", ["-ww", "-p", String(pid), "-o", "command="], inspection);
  if (!result || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const command = result.stdout.trim();
  return command || null;
}

// Confirm the process still at `pid` is the detached background worker launched
// for exactly this job before signalling its group. Without this, a job whose
// worker already exited can have its recorded pid reused by an unrelated
// same-user process, and a blind process-group kill would take that process
// (and its children) down. The background worker is spawned as
// `node .../codex-companion.mjs task-worker --cwd <cwd> --job-id <jobId>`, so its
// argv carries a job-unique identity to match against — mirroring the durable
// bridge's ps/argv ownership checks.
export function processTreeOwnsJob(pid, jobId, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof jobId !== "string" || jobId.length === 0) {
    return false;
  }
  const command = inspectProcessCommandLine(pid, options);
  if (!command) {
    return false;
  }
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Tolerate a closing quote after the script name so a quoted argv path
  // (`"C:\\...\\codex-companion.mjs" task-worker ...`) still matches.
  return /(?:^|[/\\])codex-companion\.mjs(?=["']?(?:\s|$))/.test(command) &&
    /(?:^|\s)task-worker(?=\s)/.test(command) &&
    new RegExp(`(?:^|\\s)--job-id(?:=|\\s+)["']?${escapedJobId}["']?(?=\\s|$)`).test(command);
}

export function terminateTrackedJobProcessTree(job, options = {}) {
  const pid = job?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || !processTreeOwnsJob(pid, job?.id, options)) {
    return { attempted: false, delivered: false, method: null };
  }
  return (options.terminate ?? terminateProcessTree)(pid, options);
}
