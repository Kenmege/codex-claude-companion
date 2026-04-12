import { spawn, spawnSync } from "node:child_process";

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
