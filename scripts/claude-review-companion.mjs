#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  ALLOWED_PERMISSION_MODES,
  AUTO_LONG_CONTEXT_BYTES,
  DEEP_REVIEW_EFFORT,
  DEFAULT_AGENTIC_BUDGET_USD,
  DEFAULT_DEEP_REVIEW_BUDGET_USD,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  assertAllowedPermissionMode,
  getClaudeAuthStatus,
  getClaudeAvailability,
  isSubscriptionAuth,
  probeClaudeStructuredOutput,
  runClaudeStructuredReview,
  selectClaudeProfile,
  validateStructuredReviewOutput
} from "./lib/claude.mjs";
import { chooseContextMode, collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { spawnDetached, terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  buildJobRecord,
  createJob,
  generateJobId,
  listJobs,
  readJobInput,
  readLogTail,
  resolveJobLogFile,
  resolveJobPromptFile,
  updateJob,
  writeJob,
  writeJobInput
} from "./lib/state.mjs";
import { renderCancelReport, renderFailureReport, renderReviewResult, renderSetupReport, renderStatusReport } from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const ELITE_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "elite-review-output.schema.json");
const AGENTIC_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "agentic-review-output.schema.json");
const ADD_DIR_BOUNDARY_ENV = "CODEX_CLAUDE_ADD_DIR_BOUNDARY";
const CODEX_MARKETPLACE_KEY = "claude-review-private";
const CODEX_PLUGIN_KEY = `claude-review@${CODEX_MARKETPLACE_KEY}`;
const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");

function getPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const REVIEW_KIND_CONFIG = {
  review: {
    reviewLabel: "Review",
    title: "Claude review",
    schemaPath: SCHEMA_PATH,
    jobPrefix: "review",
    defaultAgentic: true,
    defaultEffort: DEFAULT_EFFORT,
    defaultTimeoutMs: 30 * 60 * 1000,
    richSchemaWhenAgentic: false
  },
  "adversarial-review": {
    reviewLabel: "Adversarial Review",
    title: "Claude adversarial review",
    schemaPath: SCHEMA_PATH,
    jobPrefix: "adversarial",
    defaultAgentic: true,
    defaultEffort: DEFAULT_EFFORT,
    defaultTimeoutMs: 30 * 60 * 1000,
    richSchemaWhenAgentic: false
  },
  "elite-review": {
    reviewLabel: "Elite Review",
    title: "Claude elite review",
    schemaPath: ELITE_SCHEMA_PATH,
    agenticSchemaPath: AGENTIC_SCHEMA_PATH,
    jobPrefix: "elite",
    defaultAgentic: true,
    defaultEffort: DEFAULT_EFFORT,
    defaultTimeoutMs: 30 * 60 * 1000,
    richSchemaWhenAgentic: true
  },
  "deep-review": {
    reviewLabel: "Deep Review",
    title: "Claude deep review",
    schemaPath: AGENTIC_SCHEMA_PATH,
    agenticSchemaPath: AGENTIC_SCHEMA_PATH,
    jobPrefix: "deep",
    defaultAgentic: true,
    defaultEffort: DEEP_REVIEW_EFFORT,
    defaultTimeoutMs: 30 * 60 * 1000,
    richSchemaWhenAgentic: true,
    defaultBudgetUsd: DEFAULT_DEEP_REVIEW_BUDGET_USD
  },
  "security-review": {
    reviewLabel: "Security Review",
    title: "Claude security review",
    schemaPath: AGENTIC_SCHEMA_PATH,
    agenticSchemaPath: AGENTIC_SCHEMA_PATH,
    jobPrefix: "security",
    defaultAgentic: true,
    defaultEffort: DEFAULT_EFFORT,
    defaultTimeoutMs: 30 * 60 * 1000,
    richSchemaWhenAgentic: true
  }
};

const REVIEW_LIKE_BOOLEAN_OPTIONS = [
  "background",
  "long-context",
  "agentic",
  "legacy",
  "strict-mcp",
  "inherit-mcp",
  "unrestricted",
  "quiet",
  "debug"
];
const REVIEW_LIKE_VALUE_OPTIONS = [
  "base",
  "scope",
  "model",
  "effort",
  "profile",
  "cwd",
  "mcp-config",
  "max-budget-usd",
  "add-dir",
  "system-prompt-extra",
  "permission-mode",
  "timeout-ms",
  "web-domain"
];

function parseCommandInput(argv, config = {}) {
  if (argv.length === 1 && argv[0]?.includes(" ")) {
    return parseArgs(splitRawArgumentString(argv[0]), config);
  }
  return parseArgs(argv, config);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  codex-claude-review enable",
      "  codex-claude-review setup",
      "  codex-claude-review review [flags] [focus text]",
      "  codex-claude-review adversarial-review [flags] [focus text]",
      "  codex-claude-review elite-review [flags] [focus text]",
      "  codex-claude-review deep-review [flags] [focus text]",
      "  codex-claude-review security-review [flags] [focus text]",
      "  codex-claude-review status [job-id]",
      "  codex-claude-review result <job-id>",
      "  codex-claude-review cancel <job-id>",
      "",
      "Flags (review-like commands):",
      "  --background                run as a detached job",
      "  --base <ref>                base ref for branch diff",
      "  --scope auto|working-tree|branch",
      "  --model <name>              override model (default: claude-opus-4-7)",
      "  --effort low|medium|high|xhigh|max",
      "  --profile quality|long-context",
      "  --long-context              opt into the Sonnet 1M long-context profile",
      "  --legacy                    disable agentic mode (structured output only)",
      "  --agentic                   force agentic mode on (default: on)",
      "  --unrestricted              raw shell access (LOUDLY logged; trust boundary off)",
      "  --mcp-config <file-or-json> repeatable MCP config",
      "  --inherit-mcp               also inherit project/local MCPs (default: off, strict-mcp on)",
      "  --max-budget-usd <n>        cap review spend (api-key auth only; suppressed under subscription)",
      "  --add-dir <path>            additional dir for tool access (repeatable)",
      "  --web-domain <pattern>      additional WebFetch allowlist entry (repeatable)",
      "  --system-prompt-extra <s>   append workspace-specific reviewer guidance",
      "  --quiet                     suppress non-essential rendered detail",
      "  --debug                     include extra diagnostic log lines",
      `  --permission-mode <mode>    one of: ${ALLOWED_PERMISSION_MODES.join(", ")}`,
      "  --timeout-ms <n>            override review timeout (lane default: 30 minutes)",
      "",
      "Flags (enable):",
      "  --json                      emit machine-parseable registration status",
      "  --dry-run                   show what would be written without modifying the config",
      "  --config <path>             override Codex config path (default: ~/.codex/config.toml)",
      "",
      "Flags (setup):",
      "  --json                      emit machine-parseable setup status with auth identity redacted"
    ].join("\n")
  );
}

function redactAuthDetail(auth) {
  if (!auth.loggedIn) return auth.detail;
  const method = auth.raw?.authMethod ? String(auth.raw.authMethod) : "authenticated";
  return `${method} auth detected`;
}

function buildSetupPayload(cwd) {
  const claude = getClaudeAvailability(cwd);
  const auth = claude.available ? getClaudeAuthStatus(cwd) : { loggedIn: false, detail: "claude unavailable" };
  const runtime = claude.available && auth.loggedIn ? probeClaudeStructuredOutput(cwd) : { ready: false, detail: "runtime probe skipped" };
  const subscription = auth.loggedIn ? isSubscriptionAuth(auth) : false;
  const authReport = {
    loggedIn: Boolean(auth.loggedIn),
    detail: redactAuthDetail(auth),
    authMethod: auth.raw?.authMethod ?? null,
    apiProvider: auth.raw?.apiProvider ?? null,
    subscriptionType: auth.raw?.subscriptionType ?? null,
    redacted: Boolean(auth.loggedIn)
  };
  const nextSteps = [];
  if (!claude.available) {
    nextSteps.push("Install Claude Code CLI and ensure `claude` is on PATH.");
  }
  if (claude.available && !auth.loggedIn) {
    nextSteps.push("Run `claude auth login` and complete the Claude sign-in flow.");
  }
  if (claude.available && auth.loggedIn && !runtime.ready) {
    nextSteps.push("The Claude CLI is authenticated but the non-interactive print path is unhealthy. Re-run setup after fixing Claude CLI runtime issues.");
  }

  return {
    ready: claude.available && auth.loggedIn && runtime.ready,
    claude,
    auth: authReport,
    runtime,
    subscription,
    defaults: {
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      autoLongContextBytes: AUTO_LONG_CONTEXT_BYTES
    },
    nextSteps
  };
}

function coerceMultiValue(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function hasParentTraversalSegment(value) {
  return String(value)
    .split(/[\\/]+/)
    .some((segment) => segment === "..");
}

function isPathInsideBoundary(realPath, boundary) {
  const relative = path.relative(boundary, realPath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveAddDirBoundary(cwd) {
  const rawBoundary = process.env[ADD_DIR_BOUNDARY_ENV];
  const boundary = rawBoundary
    ? path.resolve(cwd, rawBoundary)
    : path.dirname(resolveWorkspaceRoot(cwd));
  return fs.realpathSync(boundary);
}

function validateAddDir(cwd, value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("--add-dir requires a non-empty path");
  }
  if (raw.includes("\0")) {
    throw new Error(`Invalid --add-dir path: ${raw}`);
  }
  const resolved = path.resolve(cwd, raw);
  let stat;
  let real;
  try {
    stat = fs.statSync(resolved);
    fs.accessSync(resolved, fs.constants.R_OK);
    real = fs.realpathSync(resolved);
  } catch (error) {
    throw new Error(`Invalid --add-dir path: ${raw} (${error.code ?? error.message})`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Invalid --add-dir path: ${raw} is not a directory`);
  }
  const root = path.parse(real).root;
  if (real === root) {
    throw new Error("Invalid --add-dir path: refusing to grant filesystem root");
  }
  const boundary = resolveAddDirBoundary(cwd);
  if (!isPathInsideBoundary(real, boundary)) {
    throw new Error(`Invalid --add-dir path: ${raw} resolves outside allowed boundary ${boundary}`);
  }
  return real;
}

function validateAddDirs(cwd, values) {
  return coerceMultiValue(values).map((value) => validateAddDir(cwd, value));
}

function parseMcpConfigJson(source, label) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid --mcp-config ${label}: JSON parse failed (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid --mcp-config ${label}: expected a JSON object`);
  }
  const serverContainer = parsed.mcpServers ?? parsed.servers;
  if (serverContainer != null && (typeof serverContainer !== "object" || Array.isArray(serverContainer))) {
    throw new Error(`Invalid --mcp-config ${label}: mcpServers/servers must be an object`);
  }
  if (serverContainer == null && !Object.values(parsed).some((value) => value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error(`Invalid --mcp-config ${label}: no server definitions found`);
  }
  return parsed;
}

function validateMcpConfig(cwd, value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("--mcp-config requires a non-empty file path or JSON object");
  }
  if (raw.startsWith("{")) {
    parseMcpConfigJson(raw, "inline JSON");
    return raw;
  }
  if (raw.includes("\0") || hasParentTraversalSegment(raw)) {
    throw new Error(`Invalid --mcp-config path: ${raw}`);
  }
  const resolved = path.resolve(cwd, raw);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Invalid --mcp-config path: ${raw} is not a file`);
  }
  if (stat.size > MAX_MCP_CONFIG_BYTES) {
    throw new Error(`Invalid --mcp-config path: ${raw} exceeds ${MAX_MCP_CONFIG_BYTES} bytes`);
  }
  parseMcpConfigJson(fs.readFileSync(resolved, "utf8"), raw);
  return resolved;
}

function validateMcpConfigs(cwd, values) {
  return coerceMultiValue(values).map((value) => validateMcpConfig(cwd, value));
}

function resolveAgenticPreference(reviewConfig, options) {
  if (options.legacy) return false;
  if (typeof options.agentic === "boolean") return options.agentic;
  return reviewConfig.defaultAgentic ?? true;
}

function resolveSchemaPath(reviewConfig, agentic) {
  if (agentic && reviewConfig.richSchemaWhenAgentic && reviewConfig.agenticSchemaPath) {
    return reviewConfig.agenticSchemaPath;
  }
  return reviewConfig.schemaPath;
}

function resolveBudget(reviewConfig, options, agentic) {
  if (options["max-budget-usd"] != null) {
    const parsed = Number.parseFloat(options["max-budget-usd"]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (!agentic) return null;
  if (reviewConfig.defaultBudgetUsd) return reviewConfig.defaultBudgetUsd;
  return DEFAULT_AGENTIC_BUDGET_USD;
}

function resolveTimeout(options, reviewConfig) {
  if (options["timeout-ms"] != null) {
    const parsed = Number.parseInt(options["timeout-ms"], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return reviewConfig.defaultTimeoutMs ?? null;
}

function resolvePermissionMode(options) {
  if (options["permission-mode"] == null) return "default";
  const value = String(options["permission-mode"]);
  assertAllowedPermissionMode(value);
  return value;
}

function resolveStrictMcp(options) {
  if (options["inherit-mcp"] === true) return false;
  if (options["strict-mcp"] === false) return false;
  return true;
}

function reviewHasShipBlockers(parsed) {
  const verdict = String(parsed?.verdict ?? "").toLowerCase();
  const shipRecommendation = String(parsed?.ship_recommendation ?? "").toLowerCase();
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  return (
    verdict.includes("request") ||
    verdict.includes("changes") ||
    shipRecommendation.includes("no_ship") ||
    shipRecommendation.includes("no ship") ||
    findings.some((finding) => ["critical", "high"].includes(String(finding.severity ?? "").toLowerCase()))
  );
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isUsageOrValidationError(error) {
  return /^(Invalid --|--.+ requires|run-job requires|result requires|cancel requires|Expected|Missing)/.test(error.message);
}

function prepareSnapshot(cwd, kind, options, focusText) {
  const reviewConfig = REVIEW_KIND_CONFIG[kind];
  const agentic = resolveAgenticPreference(reviewConfig, options);
  const unrestricted = Boolean(options.unrestricted);
  const target = resolveReviewTarget(cwd, options);
  const reviewContext = collectReviewContext(cwd, target);
  const wantsLongContext = options.profile === "long-context" || Boolean(options["long-context"]);
  const contextSelection = chooseContextMode(reviewContext, { longContext: wantsLongContext });
  const selectedProfile = selectClaudeProfile({
    model: options.model,
    effort: options.effort ?? reviewConfig.defaultEffort,
    longContext: wantsLongContext || contextSelection.bytes > AUTO_LONG_CONTEXT_BYTES,
    inputBytes: contextSelection.bytes
  });

  const authStatus = getClaudeAuthStatus(cwd);
  const subscriptionAuth = isSubscriptionAuth(authStatus);

  const notes = [...selectedProfile.notes];
  if (contextSelection.mode === "summarized" && selectedProfile.profile === "quality") {
    if (agentic) {
      notes.push("The diff snapshot was summarized to fit the inline envelope; the agentic loop will fetch full file content via Read/Grep tools.");
    } else {
      notes.push("The review snapshot was summarized to stay inside the reliable Opus inline context envelope.");
    }
  }
  if (agentic && !unrestricted) {
    notes.push("Running in agentic SAFE mode with read-only native tools (Read/Glob/Grep/Task/WebSearch), a fenced git wrapper, and a curated WebFetch domain allowlist.");
  } else if (agentic && unrestricted) {
    notes.push("WARNING: --unrestricted set. Trust boundary disabled. Claude has full default tool catalog including raw Bash. Do not use against untrusted diffs.");
  } else {
    notes.push("Running in legacy structured-output mode (no tool access).");
  }

  const schemaPath = resolveSchemaPath(reviewConfig, agentic);
  const budget = resolveBudget(reviewConfig, options, agentic);
  if (agentic && budget) {
    if (subscriptionAuth) {
      notes.push(`Budget cap of $${budget.toFixed(2)} requested but suppressed: --max-budget-usd is enforced by Claude only on api-key auth. Subscription auth detected. Use --timeout-ms for a wall-clock cap instead.`);
    } else {
      notes.push(`Budget cap: $${budget.toFixed(2)} via --max-budget-usd.`);
    }
  }
  if (agentic && selectedProfile.betas?.length && subscriptionAuth) {
    notes.push("Long-context Sonnet beta header was requested but Claude only honors --betas on api-key auth; suppressed under subscription. The Sonnet model still runs but without the 1M context beta.");
  }
  const strictMcp = resolveStrictMcp(options);
  if (strictMcp) {
    notes.push("MCP scope: strict (only --mcp-config entries; project/local MCPs not inherited).");
  } else {
    notes.push("MCP scope: inheriting project and local MCPs in addition to --mcp-config.");
  }
  const timeoutMs = resolveTimeout(options, reviewConfig);
  const permissionMode = resolvePermissionMode(options);
  const webDomains = coerceMultiValue(options["web-domain"]);

  return {
    reviewKind: kind,
    reviewLabel: reviewConfig.reviewLabel,
    target,
    targetLabel: target.label,
    focusText,
    summary: reviewContext.summary,
    changedFiles: reviewContext.changedFiles,
    contextText: contextSelection.content,
    contextMode: contextSelection.mode,
    inputBytes: contextSelection.bytes,
    model: selectedProfile.model,
    effort: selectedProfile.effort,
    profile: selectedProfile.profile,
    betas: selectedProfile.betas,
    notes,
    schemaPath,
    agentic,
    unrestricted,
    permissionMode,
    mcpConfigs: validateMcpConfigs(cwd, options["mcp-config"]),
    strictMcpConfig: strictMcp,
    addDirs: validateAddDirs(cwd, options["add-dir"]),
    maxBudgetUsd: budget,
    systemPromptExtra: options["system-prompt-extra"] ?? null,
    timeoutMs,
    quiet: Boolean(options.quiet),
    debug: Boolean(options.debug),
    webDomains,
    authStatus,
    subscriptionAuth
  };
}

function buildBackgroundJob(cwd, kind, snapshot) {
  const reviewConfig = REVIEW_KIND_CONFIG[kind];
  const jobId = generateJobId(reviewConfig.jobPrefix);
  const title = reviewConfig.title;
  const job = buildJobRecord(cwd, jobId, {
    kind,
    title,
    summary: snapshot.summary,
    model: snapshot.model,
    effort: snapshot.effort,
    profile: snapshot.profile,
    agentic: snapshot.agentic,
    unrestricted: snapshot.unrestricted
  });
  createJob(cwd, jobId, job);
  writeJobInput(cwd, jobId, snapshot);
  const pid = spawnDetached(process.execPath, [SCRIPT_PATH, "run-job", jobId, "--cwd", cwd], {
    cwd,
    logFile: resolveJobLogFile(cwd, jobId)
  });
  writeJob(cwd, jobId, { ...job, pid, status: "running", updatedAt: new Date().toISOString() });
  return { ...job, pid, status: "running" };
}

function reasonFromError(error) {
  if (error?.failureReason) return error.failureReason;
  if (error?.code === "ETIMEDOUT" || error?.code === "ETIMEDOUT_KILL") return "timeout";
  if (error?.code === "ENOOUTPUT") return "no_output_timeout";
  if (error?.code === "EINTERRUPTED") return "interrupted";
  if (error?.code === "EMAXBUFFER") return "output_limit";
  return "claude_failed";
}

function mergeDiagnostics(base, patch) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    ...(patch && typeof patch === "object" ? patch : {})
  };
}

function persistJobDiagnostics(cwd, jobId, patch) {
  try {
    const current = listJobs(cwd).find((job) => job.id === jobId) ?? {};
    updateJob(cwd, jobId, {
      diagnostics: mergeDiagnostics(current.diagnostics, patch),
      currentPhase: patch?.currentPhase ?? current.currentPhase
    });
  } catch {}
}

async function runSnapshot(cwd, jobId, snapshot) {
  appendLogLine(
    cwd,
    jobId,
    `Starting ${snapshot.reviewKind} (${snapshot.unrestricted ? "UNRESTRICTED" : snapshot.agentic ? "agentic-safe" : "structured"}) with ${snapshot.model}/${snapshot.effort}`
  );
  appendLogLine(cwd, jobId, `Context mode: ${snapshot.contextMode} (${snapshot.inputBytes} bytes)`);
  persistJobDiagnostics(cwd, jobId, {
    cwd,
    model: snapshot.model,
    effort: snapshot.effort,
    permissionMode: snapshot.permissionMode,
    contextBytes: snapshot.inputBytes,
    currentPhase: "prompt_context_built"
  });
  appendLogLine(cwd, jobId, "Prompt/context built");
  if (snapshot.debug) {
    appendLogLine(cwd, jobId, `Changed files: ${snapshot.changedFiles.join(", ") || "(none)"}`, "debug");
    appendLogLine(cwd, jobId, `MCP scope: ${snapshot.strictMcpConfig ? "strict" : "inherited"}; add-dir count: ${snapshot.addDirs.length}`, "debug");
  }
  if (snapshot.maxBudgetUsd && !snapshot.subscriptionAuth) {
    appendLogLine(cwd, jobId, `Budget cap: $${snapshot.maxBudgetUsd.toFixed(2)}`);
  } else if (snapshot.maxBudgetUsd && snapshot.subscriptionAuth) {
    appendLogLine(cwd, jobId, `Budget cap requested ($${snapshot.maxBudgetUsd.toFixed(2)}) but suppressed under subscription auth`);
  }
  const promptPath = resolveJobPromptFile(cwd, jobId);
  let stdoutSeen = false;
  let stderrSeen = false;
  const hooks = {
    promptPath,
    onInvocation(meta) {
      appendLogLine(cwd, jobId, `Claude invocation built; prompt saved to ${meta.promptPath}`);
      persistJobDiagnostics(cwd, jobId, meta);
    },
    onSpawn(meta) {
      appendLogLine(cwd, jobId, `Claude process spawned pid=${meta.pid}`);
      persistJobDiagnostics(cwd, jobId, {
        childPid: meta.pid,
        command: meta.command,
        currentPhase: meta.phase ?? "claude_spawned"
      });
    },
    onFirstStdout(meta) {
      if (stdoutSeen) return;
      stdoutSeen = true;
      appendLogLine(cwd, jobId, "First stdout byte received");
      persistJobDiagnostics(cwd, jobId, { stdoutTail: meta.text, currentPhase: meta.phase ?? "claude_stdout" });
    },
    onFirstStderr(meta) {
      if (stderrSeen) return;
      stderrSeen = true;
      appendLogLine(cwd, jobId, "First stderr byte received");
      persistJobDiagnostics(cwd, jobId, { stderrTail: meta.text, currentPhase: meta.phase ?? "claude_stderr" });
    },
    onDiagnosticUpdate(patch) {
      persistJobDiagnostics(cwd, jobId, patch);
    },
    onExit(meta) {
      appendLogLine(cwd, jobId, `Claude exited code=${meta.status ?? "null"} signal=${meta.signal ?? "null"}`);
      persistJobDiagnostics(cwd, jobId, {
        childPid: meta.pid,
        command: meta.command,
        exitCode: meta.status,
        signal: meta.signal,
        stdoutTail: meta.stdoutTail,
        stderrTail: meta.stderrTail,
        currentPhase: `${meta.phase ?? "claude"}_exited`
      });
    },
    onPhase(phase, meta = {}) {
      appendLogLine(cwd, jobId, `Phase: ${phase}`);
      persistJobDiagnostics(cwd, jobId, { currentPhase: phase, ...meta });
    }
  };

  try {
    const result = await runClaudeStructuredReview(cwd, snapshot, snapshot.reviewKind, snapshot.schemaPath, hooks);
    appendLogLine(
      cwd,
      jobId,
      `Claude returned ${result.parsed.findings?.length ?? 0} finding(s) using ${result.activity?.toolUseCount ?? 0} tool call(s)`
    );
    if (result.invocationMeta?.fallbackUsed) {
      appendLogLine(cwd, jobId, "Claude-only markdown fallback was used after structured path probe timeout", "warn");
    }
    if (result.invocationMeta?.earlyStructuredOutput) {
      appendLogLine(cwd, jobId, "Claude structured output completed before process exit; stopped child early to avoid CLI stall");
    }
    if (result.activity?.parseErrors > 0) {
      appendLogLine(
        cwd,
        jobId,
        `WARNING: stream parser saw ${result.activity.parseErrors} malformed JSON line(s); structured output recovered but some events may have been dropped`,
        "warn"
      );
    }
    return result;
  } catch (error) {
    appendLogLine(cwd, jobId, `Failed: ${error.message}`, "error");
    persistJobDiagnostics(cwd, jobId, {
      ...(error.diagnostics ?? {}),
      reason: reasonFromError(error),
      currentPhase: error.diagnostics?.currentPhase ?? "failed"
    });
    throw error;
  }
}

function handleEnable(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json", "dry-run"], valueOptions: ["config"] });
  const configPath = options.config
    ? path.resolve(options.config)
    : path.join(os.homedir(), ".codex", "config.toml");
  const pluginRoot = ROOT_DIR;

  const pluginJsonPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    throw new Error(`plugin manifest not found at ${pluginJsonPath} — run 'enable' from the installed plugin directory`);
  }
  const marketplaceManifestPath = path.join(pluginRoot, ".agents", "plugins", "marketplace.json");
  if (!fs.existsSync(marketplaceManifestPath)) {
    throw new Error(`marketplace manifest not found at ${marketplaceManifestPath} — run 'enable' from the installed plugin directory`);
  }

  let existing = "";
  try {
    existing = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const marketplaceHeader = `[marketplaces.${CODEX_MARKETPLACE_KEY}]`;
  const pluginHeader = `[plugins."${CODEX_PLUGIN_KEY}"]`;

  // JSON.stringify produces a valid TOML basic string — quotes and backslashes are properly escaped.
  const safeSource = JSON.stringify(pluginRoot.split(path.sep).join("/"));

  let updated = existing;
  const toAdd = [];
  const toUpdate = [];

  if (!updated.includes(marketplaceHeader)) {
    updated += `\n${marketplaceHeader}\nsource_type = "local"\nsource = ${safeSource}\n`;
    toAdd.push(marketplaceHeader);
  } else {
    // Refresh a stale source= value within this stanza (bounded by the next section header).
    const hIdx = updated.indexOf(marketplaceHeader);
    const nextSec = updated.indexOf("\n[", hIdx + marketplaceHeader.length);
    const stanzaEnd = nextSec === -1 ? updated.length : nextSec;
    const stanza = updated.slice(hIdx, stanzaEnd);
    const newStanza = stanza.replace(/\nsource\s*=\s*"[^"]*"/, `\nsource = ${safeSource}`);
    if (newStanza !== stanza) {
      updated = updated.slice(0, hIdx) + newStanza + updated.slice(stanzaEnd);
      toUpdate.push("source");
    }
  }

  if (!updated.includes(pluginHeader)) {
    updated += `\n${pluginHeader}\nenabled = true\n`;
    toAdd.push(pluginHeader);
  } else {
    // Flip enabled = false → enabled = true within this stanza.
    const hIdx = updated.indexOf(pluginHeader);
    const nextSec = updated.indexOf("\n[", hIdx + pluginHeader.length);
    const stanzaEnd = nextSec === -1 ? updated.length : nextSec;
    const stanza = updated.slice(hIdx, stanzaEnd);
    const newStanza = stanza.replace(/\nenabled\s*=\s*false/, "\nenabled = true");
    if (newStanza !== stanza) {
      updated = updated.slice(0, hIdx) + newStanza + updated.slice(stanzaEnd);
      toUpdate.push("enabled");
    }
  }

  const alreadyEnabled = toAdd.length === 0 && toUpdate.length === 0;
  const dryRun = options["dry-run"] ?? false;

  if (!dryRun && !alreadyEnabled) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, updated, "utf8");
  }

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ configPath, pluginRoot, alreadyEnabled, dryRun, added: toAdd, updated: toUpdate }, null, 2) + "\n"
    );
    return;
  }

  if (alreadyEnabled) {
    process.stdout.write(`Plugin already registered in ${configPath}\n`);
  } else if (dryRun) {
    const parts = [];
    if (toAdd.length > 0) parts.push(`add ${toAdd.join(", ")}`);
    if (toUpdate.length > 0) parts.push(`update ${toUpdate.join(", ")}`);
    process.stdout.write(`[dry-run] Would ${parts.join("; ")} in ${configPath}\n`);
  } else {
    const changed = [...toAdd, ...toUpdate];
    process.stdout.write(
      `Plugin registered in ${configPath}\n` +
        `Changed: ${changed.join(", ")}\n` +
        `Restart Codex CLI to activate the plugin.\n`
    );
  }
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json"], valueOptions: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const payload = buildSetupPayload(cwd);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderSetupReport(payload));
}

async function handleReviewLike(kind, argv) {
  const reviewConfig = REVIEW_KIND_CONFIG[kind];
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: REVIEW_LIKE_BOOLEAN_OPTIONS,
    valueOptions: REVIEW_LIKE_VALUE_OPTIONS
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const focusText = positionals.join(" ").trim();
  const snapshot = prepareSnapshot(cwd, kind, options, focusText);

  if (options.background) {
    const job = buildBackgroundJob(cwd, kind, snapshot);
    process.stdout.write(
      `# Claude Review Started\n\nJob: ${job.id}\nStatus: running\nMode: ${snapshot.unrestricted ? "UNRESTRICTED" : snapshot.agentic ? "agentic-safe" : "structured"}\nModel: ${snapshot.model}\nUse \`codex-claude-review status ${job.id}\` to check progress.\n`
    );
    return;
  }

  const jobId = generateJobId(reviewConfig.jobPrefix);
  const job = buildJobRecord(cwd, jobId, {
    kind,
    title: reviewConfig.title,
    summary: snapshot.summary,
    model: snapshot.model,
    effort: snapshot.effort,
    profile: snapshot.profile,
    agentic: snapshot.agentic,
    unrestricted: snapshot.unrestricted,
    status: "running"
  });
  createJob(cwd, jobId, job);
  writeJobInput(cwd, jobId, snapshot);
  try {
    const result = await runSnapshot(cwd, jobId, snapshot);
    updateJob(cwd, jobId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result.parsed,
      activity: result.activity,
      invocationMeta: result.invocationMeta,
      // Persist the M2 cross-check verification so background jobs and the
      // `result` reconstruction in handleResult render the same warnings as
      // foreground runs (Codex P2 finding on PR #11).
      evidenceVerification: result.evidenceVerification ?? null
    });
    process.stdout.write(renderReviewResult(snapshot, result, { id: jobId }));
    if (reviewHasShipBlockers(result.parsed)) {
      process.exitCode = 3;
    }
  } catch (error) {
    const current = listJobs(cwd).find((item) => item.id === jobId) ?? {};
    const failureReason = reasonFromError(error);
    updateJob(cwd, jobId, {
      status: error.code === "EINTERRUPTED" ? "cancelled" : "failed",
      completedAt: new Date().toISOString(),
      failureReason,
      error: error.message,
      diagnostics: mergeDiagnostics(current.diagnostics, { ...(error.diagnostics ?? {}), reason: failureReason })
    });
    throw error;
  }
}

async function handleRunJob(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("run-job requires a job id");
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const snapshot = readJobInput(cwd, jobId);
  updateJob(cwd, jobId, { status: "running" });
  try {
    const result = await runSnapshot(cwd, jobId, snapshot);
    updateJob(cwd, jobId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result.parsed,
      activity: result.activity,
      invocationMeta: result.invocationMeta,
      // Persist M2 cross-check verification so the `result` reconstruction
      // in handleStatus/handleResult shows the same warnings as foreground
      // runs (Codex P2 finding on PR #11).
      evidenceVerification: result.evidenceVerification ?? null
    });
  } catch (error) {
    appendLogLine(cwd, jobId, `Failed: ${error.message}`, "error");
    const current = listJobs(cwd).find((item) => item.id === jobId) ?? {};
    const failureReason = reasonFromError(error);
    updateJob(cwd, jobId, {
      status: error.code === "EINTERRUPTED" ? "cancelled" : "failed",
      completedAt: new Date().toISOString(),
      failureReason,
      error: error.message,
      diagnostics: mergeDiagnostics(current.diagnostics, { ...(error.diagnostics ?? {}), reason: failureReason })
    });
  }
}

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const allJobs = listJobs(cwd).map((job) => markStaleJob(cwd, job)).map((job) => ({ ...job, logTail: readLogTail(cwd, job.id) }));
  const filteredJobs = positionals[0]
    ? allJobs.filter((job) => job.id.startsWith(positionals[0]))
    : allJobs;
  process.stdout.write(renderStatusReport(filteredJobs, workspaceRoot));
}

function jobTimeoutMs(cwd, job) {
  try {
    const snapshot = readJobInput(cwd, job.id);
    return snapshot.timeoutMs ?? 30 * 60 * 1000;
  } catch {
    return 30 * 60 * 1000;
  }
}

function markStaleJob(cwd, job) {
  if (job.status === "stalled") {
    appendLogLine(cwd, job.id, "Legacy stalled job finalized as failed", "error");
    return updateJob(cwd, job.id, {
      status: "failed",
      failureReason: job.failureReason ?? "stale_timeout",
      completedAt: job.completedAt ?? new Date().toISOString(),
      error: job.error ?? "job was previously marked stalled",
      diagnostics: mergeDiagnostics(job.diagnostics, {
        reason: job.failureReason ?? "stale_timeout",
        currentPhase: job.currentPhase ?? job.diagnostics?.currentPhase ?? "legacy_stalled_job"
      })
    });
  }
  if (job.status !== "running") {
    return job;
  }
  const updatedAt = Date.parse(job.updatedAt ?? job.createdAt ?? "");
  if (!Number.isFinite(updatedAt)) {
    return job;
  }
  const timeoutMs = jobTimeoutMs(cwd, job);
  if (Date.now() - updatedAt <= timeoutMs) {
    return job;
  }
  appendLogLine(cwd, job.id, `Stale job finalized: exceeded timeout window of ${timeoutMs}ms`, "error");
  return updateJob(cwd, job.id, {
    status: "failed",
    failureReason: "stale_timeout",
    completedAt: new Date().toISOString(),
    error: `running job exceeded timeout window of ${timeoutMs}ms`,
    diagnostics: mergeDiagnostics(job.diagnostics, {
      reason: "stale_timeout",
      timeoutMs,
      currentPhase: job.currentPhase ?? job.diagnostics?.currentPhase ?? "stale_running_job"
    })
  });
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("result requires a job id");
  }
  const jobs = listJobs(cwd);
  const job = jobs.find((item) => item.id === jobId || item.id.startsWith(jobId));
  if (!job) {
    throw new Error(`Unknown job ${jobId}`);
  }
  if (job.status !== "completed") {
    const withTail = { ...job, logTail: readLogTail(cwd, job.id) };
    process.stdout.write(renderFailureReport(withTail));
    process.exitCode = job.status === "failed" || job.status === "stalled" ? 1 : 2;
    return;
  }
  const snapshot = readJobInput(cwd, job.id);
  try {
    validateStructuredReviewOutput(job.result, snapshot.reviewKind);
  } catch (error) {
    throw new Error(`Persisted result is invalid for ${job.id}: ${error.message}`);
  }
  process.stdout.write(
    renderReviewResult(
      snapshot,
      {
        parsed: job.result,
        activity: job.activity,
        invocationMeta: job.invocationMeta,
        // Surface the persisted M2 cross-check on `result` reconstruction.
        // null is acceptable — the renderer already guards
        // result.evidenceVerification?.findingCount.
        evidenceVerification: job.evidenceVerification ?? null
      },
      job
    )
  );
  if (reviewHasShipBlockers(job.result)) {
    process.exitCode = 3;
  }
}

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("cancel requires a job id");
  }
  const jobs = listJobs(cwd);
  const job = jobs.find((item) => item.id === jobId || item.id.startsWith(jobId));
  if (!job) {
    throw new Error(`Unknown job ${jobId}`);
  }
  if (!isProcessAlive(job.pid)) {
    const stalledJob = updateJob(cwd, job.id, {
      status: "stalled",
      error: "process is not running"
    });
    process.stdout.write(renderCancelReport(stalledJob, false));
    return;
  }
  const cancelled = terminateProcessTree(job.pid);
  const updatedJob = updateJob(cwd, job.id, {
    status: cancelled ? "cancelled" : job.status,
    completedAt: cancelled ? new Date().toISOString() : job.completedAt
  });
  process.stdout.write(renderCancelReport(updatedJob, cancelled));
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (!command || command === "--help" || command === "-h" || command === "help") {
      printUsage();
      return;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      process.stdout.write(`${getPackageVersion()}\n`);
      return;
    }
    switch (command) {
      case "enable":
        handleEnable(argv);
        break;
      case "setup":
        handleSetup(argv);
        break;
      case "review":
        await handleReviewLike("review", argv);
        break;
      case "adversarial-review":
        await handleReviewLike("adversarial-review", argv);
        break;
      case "elite-review":
        await handleReviewLike("elite-review", argv);
        break;
      case "deep-review":
        await handleReviewLike("deep-review", argv);
        break;
      case "security-review":
        await handleReviewLike("security-review", argv);
        break;
      case "run-job":
        await handleRunJob(argv);
        break;
      case "status":
        handleStatus(argv);
        break;
      case "result":
        handleResult(argv);
        break;
      case "cancel":
        handleCancel(argv);
        break;
      default:
        printUsage();
        process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = isUsageOrValidationError(error) ? 2 : 1;
  }
}

main();
