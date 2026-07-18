import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runCommandCapture } from "./process.mjs";

const AUTO_RECOVERY_GUARD = "CODEX_CLAUDE_BRIDGE_AUTO_RECOVERY";

function run(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env
  });
}

function verifierEnvironment(environment = process.env) {
  const blocked = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|COOKIE|CREDENTIAL|ANTHROPIC|OPENAI|AWS_|AZURE_|GITHUB_|GITLAB_)/i;
  return Object.fromEntries(Object.entries(environment)
    .filter(([key]) => key !== AUTO_RECOVERY_GUARD && !blocked.test(key))
    .concat([["CI", "1"], ["CODEX_CLAUDE_BRIDGE_VERIFIER", "1"]]));
}

function boundedStream(value, limit = 1_800) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  const lines = text.split(/\r?\n/);
  const primary = lines.filter((line) =>
    /^\s*not ok\b/i.test(line) ||
    /\bERR_[A-Z0-9_]+\b/.test(line) ||
    /^\s*(?:error|failureType)\s*:/i.test(line));
  const secondary = lines.filter((line) =>
    !/^\s*ok\b/i.test(line) &&
    /(?:\b(?:fail(?:ed|ure)?|error)\b|\bexit(?:ed)?(?: with)?\s+(?:code\s+)?[1-9]\d*\b)/i.test(line));
  const salient = [...new Set([...primary, ...secondary])]
    .join("\n")
    .slice(0, Math.floor(limit / 3));
  const remaining = limit - salient.length;
  const headLength = Math.floor(remaining / 3);
  const tailLength = remaining - headLength;
  return [
    text.slice(0, headLength),
    `... ${Math.max(0, text.length - remaining)} characters omitted ...`,
    ...(salient ? [`salient failures:\n${salient}`] : []),
    text.slice(-tailLength)
  ].join("\n");
}

function processDiagnostics(outcome) {
  return [
    outcome.error?.message ? `error: ${boundedStream(outcome.error.message)}` : "",
    outcome.signal ? `signal: ${outcome.signal}` : "",
    outcome.stdout ? `stdout:\n${boundedStream(outcome.stdout)}` : "",
    outcome.stderr ? `stderr:\n${boundedStream(outcome.stderr)}` : ""
  ].filter(Boolean).join("\n");
}

function git(workspace, args) {
  const outcome = run("git", ["-C", workspace, ...args], { timeout: 30_000 });
  if (outcome.error || outcome.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(outcome.stderr || outcome.error?.message).trim()}`);
  }
  return outcome.stdout;
}

function fingerprint(workspace, relative) {
  const file = path.join(workspace, relative);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return crypto.createHash("sha256").update("missing").digest("hex");
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return crypto.createHash("sha256").update(`symlink:${fs.readlinkSync(file)}`).digest("hex");
  }
  if (!stat.isFile()) return crypto.createHash("sha256").update(`other:${stat.mode}:${stat.size}`).digest("hex");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function captureGitWorkspace(workspace) {
  const root = fs.realpathSync(workspace);
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean).sort();
  if (files.length > 200_000) throw new Error("workspace snapshot exceeds 200000 files");
  const dirty = new Set();
  const porcelain = git(root, ["status", "--porcelain=v1", "-z"]).split("\0").filter(Boolean);
  for (let index = 0; index < porcelain.length; index += 1) {
    const record = porcelain[index];
    const status = record.slice(0, 2);
    dirty.add(record.slice(3));
    if (status.includes("R") || status.includes("C")) dirty.add(porcelain[++index]);
  }
  return {
    entries: files.map((relative) => ({
      path: relative,
      fingerprint: fingerprint(root, relative),
      dirty: dirty.has(relative)
    }))
  };
}

export function runProductionRepositoryChecks({ request }, options = {}) {
  const workspace = request.execution.canonicalWorkspacePath;
  const working = run("git", ["-C", workspace, "diff", "--check"], { timeout: 30_000 });
  const staged = run("git", ["-C", workspace, "diff", "--cached", "--check"], { timeout: 30_000 });
  const configured = options.verificationCommands ?? [];
  if (!Array.isArray(configured) || configured.length > 8 || configured.some((argv) =>
    !Array.isArray(argv) || argv.length === 0 || argv.length > 64 ||
    argv.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 4_096))) {
    throw new Error("verificationCommands must be at most 8 bounded argv arrays");
  }
  const commands = configured.slice(0, 8).map((argv) => {
    const outcome = run(argv[0], argv.slice(1), {
      cwd: workspace,
      timeout: 300_000,
      env: verifierEnvironment()
    });
    return {
      argv,
      status: outcome.status,
      error: outcome.error?.message ?? null,
      output: processDiagnostics(outcome)
    };
  });
  const passed = !working.error && !staged.error && working.status === 0 && staged.status === 0 &&
    commands.length > 0 && commands.every((entry) => entry.status === 0 && entry.error == null);
  return {
    passed,
    evidence: [
      `git diff --check exit=${working.status ?? "error"}`,
      `git diff --cached --check exit=${staged.status ?? "error"}`,
      ...(commands.length === 0
        ? ["independent checks: no origin-supplied command configured; failed closed"]
        : commands.map((entry) => `independent check ${JSON.stringify(entry.argv)} exit=${entry.status ?? "error"}`))
    ],
    findings: [
      ...[working, staged]
        .filter((outcome) => outcome.error || outcome.status !== 0)
        .map(processDiagnostics),
      ...commands.filter((entry) => entry.status !== 0 || entry.error).map((entry) => entry.output || entry.error)
    ].map((value) => String(value ?? "").trim()).filter(Boolean)
  };
}

function codexVerifierPrompt({ request, result, integrity, repository }) {
  const scope = {
    changedPaths: integrity.changedPaths,
    unexpectedChanges: integrity.unexpectedChanges,
    reportedButUnchanged: integrity.reportedButUnchanged,
    passed: integrity.passed
  };
  return [
    "Act as an independent read-only verifier for a Claude implementation worker.",
    repository.passed
      ? "Review only the acceptance criteria, worker result, and listed changed paths. Do not modify anything or inventory unrelated repository state."
      : "The repository gate already failed. Confirm its concrete failures from the supplied evidence and return promptly; do not perform a broad repository audit.",
    "Pass only if the reported work satisfies the request and all supplied gates pass; otherwise fail with concrete findings.",
    `Request acceptance: ${JSON.stringify(request.task.acceptance)}`,
    `Worker result: ${JSON.stringify(result)}`,
    `Scoped workspace integrity: ${JSON.stringify(scope)}`,
    `Repository checks: ${JSON.stringify(repository)}`
  ].join("\n");
}

async function codexReview(codexBinary, { request, result, integrity, repository, attempt }, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-codex-verifier-"));
  fs.chmodSync(temporary, 0o700);
  const schemaFile = path.join(temporary, "schema.json");
  const outputFile = path.join(temporary, "result.json");
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["passed", "evidence", "findings"],
    properties: {
      passed: { type: "boolean" },
      evidence: { type: "array", minItems: 1, items: { type: "string" } },
      findings: { type: "array", items: { type: "string" } }
    }
  };
  fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
  const prompt = codexVerifierPrompt({ request, result, integrity, repository });
  const heartbeat = typeof options.onHeartbeat === "function"
    ? setInterval(() => {
        try {
          const pending = options.onHeartbeat({ attempt });
          if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch {}
      }, options.heartbeatMs)
    : null;
  heartbeat?.unref();
  try {
    const outcome = await (options.runProcess ?? runCommandCapture)(codexBinary, [
      "exec", "--ephemeral", "--sandbox", "read-only", "--cd",
      request.execution.canonicalWorkspacePath, "--output-schema", schemaFile,
      "--output-last-message", outputFile, "-"
    ], {
      cwd: request.execution.canonicalWorkspacePath,
      inputData: prompt,
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: verifierEnvironment()
    });
    if (outcome.error || outcome.status !== 0 || !fs.existsSync(outputFile)) {
      return {
        passed: false,
        evidence: [
          `Codex verifier process failed closed (exit=${outcome.status ?? "error"}${outcome.signal ? ` signal=${outcome.signal}` : ""})`
        ],
        findings: [processDiagnostics(outcome) || "no verifier output"]
      };
    }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(outputFile, "utf8")); } catch (error) {
      return {
        passed: false,
        evidence: ["Codex verifier returned malformed JSON; failed closed"],
        findings: [String(error?.message ?? error).slice(0, 1_000)]
      };
    }
    return {
      passed: parsed.passed === true,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : ["Codex verifier returned invalid evidence"],
      findings: Array.isArray(parsed.findings) ? parsed.findings : []
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function createProductionBridgeVerificationDependencies(options) {
  if (typeof options?.codexBinary !== "string" || !path.isAbsolute(options.codexBinary)) {
    throw new Error("production bridge verification requires an absolute Codex executable");
  }
  if (typeof options?.recordVerification !== "function") {
    throw new Error("production bridge verification requires durable recordVerification");
  }
  if (typeof options?.recordVerificationAttempts !== "function") {
    throw new Error("production bridge verification requires immutable recordVerificationAttempts");
  }
  const verifierTimeoutMs = options.verifierTimeoutMs ?? 300_000;
  if (!Number.isInteger(verifierTimeoutMs) || verifierTimeoutMs < 30_000 || verifierTimeoutMs > 3_600_000) {
    throw new RangeError("verifierTimeoutMs must be an integer from 30000 through 3600000");
  }
  const verifierHeartbeatMs = options.verifierHeartbeatMs ?? 10_000;
  if (!Number.isInteger(verifierHeartbeatMs) || verifierHeartbeatMs < 1 || verifierHeartbeatMs > 60_000) {
    throw new RangeError("verifierHeartbeatMs must be an integer from 1 through 60000");
  }
  if (options.runProcess != null && typeof options.runProcess !== "function") {
    throw new TypeError("production bridge runProcess must be a function");
  }
  if (options.onVerifierHeartbeat != null && typeof options.onVerifierHeartbeat !== "function") {
    throw new TypeError("production bridge onVerifierHeartbeat must be a function");
  }
  if ((options.dispatchRepair == null) !== (options.awaitRepair == null) ||
      (options.dispatchRepair != null && (typeof options.dispatchRepair !== "function" ||
        typeof options.awaitRepair !== "function"))) {
    throw new Error("production bridge repair requires paired dispatchRepair and awaitRepair functions");
  }
  return Object.freeze({
    captureWorkspace: captureGitWorkspace,
    runRepositoryChecks: (input) => runProductionRepositoryChecks(input, {
      verificationCommands: options.verificationCommands ?? []
    }),
    runCodexReview: (input) => codexReview(options.codexBinary, input, {
      timeoutMs: verifierTimeoutMs,
      heartbeatMs: verifierHeartbeatMs,
      runProcess: options.runProcess,
      onHeartbeat: options.onVerifierHeartbeat
    }),
    persistVerification: async ({ jobId, verification, attempts, result }) => {
      await options.recordVerificationAttempts(jobId, {
        schemaVersion: 1,
        jobId,
        verification,
        attempts,
        result
      });
      return options.recordVerification(jobId, verification);
    },
    ...(options.dispatchRepair
      ? { dispatchRepair: options.dispatchRepair, awaitRepair: options.awaitRepair }
      : {})
  });
}
