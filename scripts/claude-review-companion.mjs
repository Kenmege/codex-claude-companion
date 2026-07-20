#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
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
  getClaudeVersion,
  isSubscriptionAuth,
  normalizeReviewVerdict,
  normalizeShipRecommendation,
  probeClaudeStructuredOutput,
  runClaudeStructuredReview,
  selectClaudeProfile,
  validateStructuredReviewOutput
} from "./lib/claude.mjs";
import { chooseContextMode, collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { stageMcpConfigs } from "./lib/mcp-config.mjs";
import { createDirectorySnapshot, isGitRepository } from "./lib/snapshot.mjs";
import { runCommand, spawnDetached, terminateProcessTree } from "./lib/process.mjs";
import { handleBridgeCommand, isBridgeJobInvocation } from "./lib/bridge-cli.mjs";
import {
  JOB_DIR_ENV_VAR,
  appendLogLine,
  assertValidJobId,
  buildJobRecord,
  createJob,
  generateJobId,
  listJobs,
  readJobInput,
  readLogTail,
  resolveJobLogFile,
  resolveJobPromptFile,
  resolveJobsDir,
  updateJob,
  writeJob,
  writeJobInput
} from "./lib/state.mjs";
import { renderCancelReport, renderFailureReport, renderReviewResult, renderSetupReport, renderStatusReport } from "./lib/render.mjs";
import {
  buildClaudeLogsArgs,
  buildClaudeStatusArgs,
  buildClaudeStopArgs,
  createWorkspaceConfig,
  formatShellCommand,
  resolveWorkspaceRoot,
  runWorkspace,
  runWorkspaceControl
} from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const ELITE_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "elite-review-output.schema.json");
const AGENTIC_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "agentic-review-output.schema.json");
const ADD_DIR_BOUNDARY_ENV = "CODEX_CLAUDE_ADD_DIR_BOUNDARY";
const CODEX_MARKETPLACE_KEY = "claude-review-private";
const CODEX_PLUGIN_NAME = "claude-review";
const CODEX_PLUGIN_KEY = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_KEY}`;
const CODEX_MARKETPLACE_WRAPPER_DIR = "marketplaces";
const CODEX_MARKETPLACE_PLUGIN_SUBDIR = `plugins/${CODEX_PLUGIN_NAME}`;
const MINIMUM_CLAUDE_VERSION = "2.1.183";
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

const PRESET_CONFIG = {
  quick: {
    reviewKind: "review",
    description: "fast everyday diff review",
    systemPromptExtra: "Preset quick: prioritize likely regressions, missing tests, and obvious safety issues. Keep findings high-signal."
  },
  ship: {
    reviewKind: "elite-review",
    description: "pre-merge ship/no-ship gate",
    systemPromptExtra: "Preset ship: act as a release gate. Lead with ship-blocking defects, rollback risk, migration risk, and missing verification. Treat vague confidence as a reason to list a blind spot."
  },
  security: {
    reviewKind: "security-review",
    description: "security-focused OWASP/CWE review",
    systemPromptExtra: "Preset security: focus on exploitable behavior, authz/authn boundaries, injection, SSRF, path traversal, secret handling, supply-chain risk, and dependency claims verified from lockfiles."
  },
  research: {
    reviewKind: "deep-review",
    description: "research or evidence-heavy review",
    systemPromptExtra: "Preset research: evaluate source quality, methodology, reproducibility, unsupported claims, stale citations, and uncertainty. Separate verified claims from assumptions and name the artifact needed to close each blind spot."
  },
  deep: {
    reviewKind: "deep-review",
    description: "deep multi-agent investigation",
    systemPromptExtra: "Preset deep: use Task sub-agents to split independent investigation paths when useful. Cover architecture, correctness, tests, release safety, and blind spots."
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
  "path",
  "mcp-config",
  "max-budget-usd",
  "add-dir",
  "system-prompt-extra",
  "permission-mode",
  "timeout-ms",
  "web-domain",
  "snapshot-temp-root",
  "exclude",
  "job-dir",
  "preset"
];
const REVIEW_LIKE_REPEATABLE_VALUE_OPTIONS = ["add-dir", "exclude", "mcp-config", "web-domain"];

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, config);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  codex-claude enable",
      "  codex-claude setup",
      "  codex-claude doctor [--json]",
      "  codex-claude folder <path> [flags] [focus text]",
      "  codex-claude review [flags] [focus text]",
      "  codex-claude adversarial-review [flags] [focus text]",
      "  codex-claude elite-review [flags] [focus text]",
      "  codex-claude deep-review [flags] [focus text]",
      "  codex-claude security-review [flags] [focus text]",
      "  codex-claude workspace [flags] -- <coding request>",
      "  codex-claude workspace-status [--path <dir>] [--all] [--json]",
      "  codex-claude workspace-logs <session-id>",
      "  codex-claude workspace-stop <session-id>",
      "  codex-claude status [job-id]",
      "  codex-claude result <job-id>",
      "  codex-claude cancel <job-id>",
      "  codex-claude delegate --thread-id <id> --verify-command '[\"npm\",\"test\"]' -- <task>",
      "  codex-claude wait|status|logs|cancel|recover|attach <ccb_job-id>",
      "  codex-claude logs <ccb_job-id> [--stderr|--broker] [--follow --timeout <seconds>]",
      "  codex-claude recover --all",
      "  codex-claude send <ccb_job-id> [--question-id <id>] [--wait] --message <text>",
      "  codex-claude list [--json]",
      "  codex-claude gc [--older-than-days <days>] [--limit <1-64>] [--apply] [--json]",
      "  codex-claude bridge-doctor [--json]",
      "  --verify-command <JSON argv> repeatable; required origin-supplied independent verification command",
      "  Compatibility alias: codex-claude-review",
      "",
      "Flags (bridge delegate):",
      "  --path <dir>                worker cwd (default: cwd)",
      "  --repo-root <dir>           immutable repository origin (default: --path)",
      "  --permitted-root <dir>      containment root (default: --repo-root)",
      "  --profile <name>            bridge permission profile",
      "  --agent <name>              active Claude agent; composes with one definition source",
      "  --agents-json <JSON>        inline Claude agent definitions (exclusive with --agents-file)",
      "  --agents-file <path>        Claude agent definitions (exclusive with --agents-json)",
      "  --plugin-dir <dir>          repeatable Claude plugin directory",
      "  --mcp-config <path>         repeatable MCP configuration file",
      "  --add-dir <dir>             repeatable additional working directory",
      "  --setting-sources <list>    opt in to user,project,local Claude settings",
      "  --model <name>              Claude model selector (default: opus alias)",
      "  --effort <level>            Claude effort selector",
      "  --timeout <seconds>         bounded worker timeout",
      "  --accept <text>             repeatable acceptance criterion",
      "  --verify-command <JSON>     repeatable required independent argv array",
      "  --max-repairs <0|1>         bounded production repair attempts (default: 0)",
      "  --thread-id <id>            Codex origin (or CODEX_THREAD_ID)",
      "  --turn-id <id>              optional Codex turn origin",
      "  --prompt <text>             task text (or positional text)",
      "  --state-dir <dir>           bridge state root override",
      "  --tmux|--claude|--codex <path> executable overrides",
      "  --interval <ms>             broker polling interval",
      "  --wait                      wait for terminal verification and delivery",
      "  --json                      machine-readable output",
      "",
      "Flags (bridge operations):",
      "  --state-dir <dir>           bridge state root override",
      "  --stderr|--broker           select worker stderr or broker log",
      "  --follow                    follow logs until terminal or timeout",
      "  --poll-interval <ms>        log follow polling interval (50-5000)",
      "  --timeout <seconds>         bounded wait/follow/send timeout",
      "  --reason <text>             cancellation reason",
      "  --exec                      execute tmux attach (default: print command)",
      "  --wait                      wait for send replay acknowledgement",
      "  gc is a bounded dry run by default; --apply removes only listed expired terminal jobs",
      "  --message <text>            same-session Claude input",
      "  --question-id <id>          correlate input to a pending Claude question",
      "  --all                       recover every unsettled durable job",
      "  --json                      machine-readable output",
      "",
      "Flags (workspace):",
      "  --path <dir>                coding directory (default: cwd)",
      "  --model <name>              Claude model selector (default: rolling opus alias)",
      "  --plan                      start Claude in analysis-only plan mode",
      "  --panel-only                open Claude's agents panel without dispatching work",
      "  --no-panel                  dispatch without opening another panel",
      "  --json-events               emit privacy-safe lifecycle events as JSON Lines to stderr",
      "",
      "Flags (review-like commands):",
      "  --path <dir>                target directory (default: cwd). Works for Git and non-Git dirs.",
      "  --background                run as a detached job",
      "  --base <ref>                base ref for branch diff",
      "  --scope auto|working-tree|branch|directory",
      "  --preset quick|ship|security|research|deep",
      "  --exclude <basename>        repeatable; extra dirs to exclude from non-Git snapshot",
      "  --snapshot-temp-root <dir>  override private snapshot root (default: ~/.claude-review/snapshots)",
      "  --job-dir <path>            override job artifact directory (env: CODEX_CLAUDE_REVIEW_JOB_DIR)",
      "  --model <name>              override model (default: opus)",
      "  --effort low|medium|high|xhigh|max",
      "  --profile quality|long-context",
      "  --long-context              opt into Claude Code's Opus 1M long-context alias",
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
      "  --config <path>             override Codex config path (default: $CODEX_HOME/config.toml or ~/.codex/config.toml)",
      "",
      "Flags (setup):",
      "  --json                      emit machine-parseable setup status with auth identity redacted",
      "",
      "Flags (doctor):",
      "  --json                      emit machine-parseable diagnostic status",
      "  --probe-runtime             run a live Claude non-interactive model probe"
    ].join("\n")
  );
}

const BRIDGE_COMMAND_USAGE = Object.freeze({
  delegate: [
    "codex-claude delegate --thread-id <id> --verify-command '<JSON argv>' [flags] -- <task>",
    "Create a durable Claude delegation and start its broker.",
    "Key flags: --agent, --agents-json|--agents-file, --profile, --model, --effort, --max-repairs <0|1>, --wait, --json",
    "With --wait: exit 0=verified+acknowledged, 3=terminal gate failure, 4=pending Claude question."
  ],
  result: ["codex-claude result <job-id> [--cwd <dir>] [--job-dir <dir>]", "Return the stored output for a finished review job."],
  wait: [
    "codex-claude wait <ccb_job-id> [--timeout <seconds>] [--state-dir <dir>] [--json]",
    "Wait for verified terminal state and origin delivery.",
    "Exit 0=verified+acknowledged, 3=terminal gate failure, 4=pending Claude question; timeout is exit 1."
  ],
  status: ["codex-claude status <ccb_job-id> [--state-dir <dir>] [--json]", "Show one durable bridge job."],
  logs: ["codex-claude logs <ccb_job-id> [--stderr|--broker] [--follow] [--timeout <seconds>] [--state-dir <dir>]", "Read bounded worker or broker logs."],
  cancel: ["codex-claude cancel <ccb_job-id> [--reason <text>] [--state-dir <dir>] [--json]", "Request durable cancellation through the owning broker."],
  recover: ["codex-claude recover <ccb_job-id>|--all [--state-dir <dir>] [--json]", "Reconcile and restart unsettled durable jobs."],
  list: ["codex-claude list [--state-dir <dir>] [--json]", "List durable bridge jobs."],
  attach: ["codex-claude attach <ccb_job-id> [--exec] [--state-dir <dir>]", "Print or execute the exact tmux attach command."],
  "bridge-doctor": ["codex-claude bridge-doctor [--state-dir <dir>] [--json]", "Check bridge runtime prerequisites and durable state."],
  send: [
    "codex-claude send <ccb_job-id> --message <text> [--question-id <id>] [--wait] [--state-dir <dir>] [--json]",
    "Send same-session input through the durable broker inbox while the authoritative worker is live.",
    "Without --wait, exit 0 means queued; with --wait, exit 0 requires replay acknowledgement."
  ],
  gc: ["codex-claude gc [--older-than-days <days>] [--limit <1-64>] [--apply] [--state-dir <dir>] [--json]", "Preview bounded terminal-job cleanup; --apply performs it."]
});

function printBridgeCommandUsage(command) {
  const lines = BRIDGE_COMMAND_USAGE[command];
  if (!lines) return false;
  process.stdout.write(["Usage:", `  ${lines[0]}`, "", ...lines.slice(1), "", "Run `codex-claude --help` for the complete flag reference."].join("\n") + "\n");
  return true;
}

function bridgeCommandHelpRequested(argv) {
  const terminatorIndex = argv.indexOf("--");
  const optionArguments = terminatorIndex === -1 ? argv : argv.slice(0, terminatorIndex);
  return optionArguments.some((argument) => argument === "--help" || argument === "-h");
}

async function handleWorkspace(argv) {
  const { options, positionals, optionTerminatorIndex } = parseCommandInput(argv, {
    booleanOptions: ["plan", "panel-only", "no-panel", "json-events"],
    valueOptions: ["path", "model"]
  });
  const config = createWorkspaceConfig(
    {
      path: options.path,
      model: options.model,
      plan: options.plan,
      panelOnly: options["panel-only"],
      noPanel: options["no-panel"],
      jsonEvents: options["json-events"],
      positionals,
      optionTerminatorIndex
    },
    process.cwd()
  );
  const result = await runWorkspace(config);
  if (result.sessionId) console.log(`Claude workspace session: ${result.sessionId}`);
  if (result.panelOpened) {
    console.log(`Claude control panel opened via ${result.terminalBackend}.`);
  } else if (result.manualPanelCommand) {
    console.log(`Worker is still running. Open the panel manually: ${formatShellCommand(result.manualPanelCommand)}`);
  }
  if (result.status !== 0) process.exitCode = result.status;
}

function relayWorkspaceControlResult(result) {
  if (result.stdout) process.stdout.write(String(result.stdout));
  if (result.stderr) process.stderr.write(String(result.stderr));
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function handleWorkspaceStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["all", "json"],
    valueOptions: ["path"]
  });
  if (positionals.length) throw new Error(`Unexpected workspace-status argument: ${positionals[0]}`);
  const cwd = path.resolve(process.cwd(), options.path ?? ".");
  relayWorkspaceControlResult(runWorkspaceControl(
    "claude",
    buildClaudeStatusArgs({ cwd, all: options.all, json: options.json }),
    { cwd }
  ));
}

function requireSessionId(positionals, command) {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error(`${command} requires exactly one Claude session ID`);
  }
  return positionals[0];
}

function handleWorkspaceLogs(argv) {
  const { positionals } = parseCommandInput(argv);
  relayWorkspaceControlResult(runWorkspaceControl(
    "claude",
    buildClaudeLogsArgs(requireSessionId(positionals, "workspace-logs"))
  ));
}

function handleWorkspaceStop(argv) {
  const { positionals } = parseCommandInput(argv);
  relayWorkspaceControlResult(runWorkspaceControl(
    "claude",
    buildClaudeStopArgs(requireSessionId(positionals, "workspace-stop"))
  ));
}

function redactAuthDetail(auth) {
  if (!auth.loggedIn) return auth.detail;
  const method = auth.raw?.authMethod ? String(auth.raw.authMethod) : "authenticated";
  return `${method} auth detected`;
}

function buildSetupPayload(cwd) {
  const claudeAvailability = getClaudeAvailability(cwd);
  const claudeVersion = claudeAvailability.available ? getClaudeVersion(cwd) : { version: null, detail: "claude unavailable" };
  const claude = { ...claudeAvailability, version: claudeVersion.version, versionDetail: claudeVersion.detail };
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
    const raw = String(options["max-budget-usd"]).trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) {
      throw new Error(`Invalid --max-budget-usd: expected a positive decimal number, got ${JSON.stringify(raw)}`);
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --max-budget-usd: expected a positive decimal number, got ${JSON.stringify(raw)}`);
    }
    if (!agentic) {
      throw new Error("--max-budget-usd requires agentic mode; legacy structured reviews do not enforce Claude budget caps.");
    }
    return parsed;
  }
  if (!agentic) return null;
  if (reviewConfig.defaultBudgetUsd) return reviewConfig.defaultBudgetUsd;
  return DEFAULT_AGENTIC_BUDGET_USD;
}

function resolveTimeout(options, reviewConfig) {
  if (options["timeout-ms"] != null) {
    const raw = String(options["timeout-ms"]).trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error(`Invalid --timeout-ms: expected a positive integer millisecond value, got ${JSON.stringify(raw)}`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --timeout-ms: expected a positive integer millisecond value, got ${JSON.stringify(raw)}`);
    }
    return parsed;
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

function parseNodeVersion(value) {
  const [major, minor, patch] = String(value ?? "").split(".").map((part) => Number.parseInt(part, 10));
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0
  };
}

function nodeVersionAtLeast(current, minimum) {
  const left = parseNodeVersion(current);
  const right = parseNodeVersion(minimum);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] > right[key]) return true;
    if (left[key] < right[key]) return false;
  }
  return true;
}

function resolvePreset(kind, options) {
  const rawPreset = options.preset == null ? null : String(options.preset).trim();
  if (!rawPreset) {
    return { kind, preset: null, options };
  }
  const preset = PRESET_CONFIG[rawPreset];
  if (!preset) {
    throw new Error(`Invalid --preset "${rawPreset}". Allowed values: ${Object.keys(PRESET_CONFIG).join(", ")}.`);
  }
  const nextOptions = { ...options };
  const promptParts = [preset.systemPromptExtra];
  if (nextOptions["system-prompt-extra"]) {
    promptParts.push(String(nextOptions["system-prompt-extra"]));
  }
  nextOptions["system-prompt-extra"] = promptParts.join("\n\n");
  return { kind: preset.reviewKind ?? kind, preset: rawPreset, options: nextOptions };
}

function reviewHasShipBlockers(parsed) {
  const verdict = normalizeReviewVerdict(parsed?.verdict);
  const shipRecommendation = normalizeShipRecommendation(parsed?.ship_recommendation);
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  return (
    verdict === "REQUEST_CHANGES" ||
    shipRecommendation === "NO_SHIP" ||
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
  if (options.preset && PRESET_CONFIG[options.preset]) {
    notes.push(`Preset: ${options.preset} (${PRESET_CONFIG[options.preset].description}).`);
  }
  if (contextSelection.mode === "summarized" && selectedProfile.profile === "quality") {
    if (agentic) {
      notes.push("The diff snapshot was summarized to fit the inline envelope; the agentic loop will fetch full file content via Read/Grep tools.");
    } else {
      notes.push("The review snapshot was summarized to stay inside the reliable Opus inline context envelope.");
    }
  }
  if (agentic && !unrestricted) {
    notes.push("Running in agentic SAFE mode with read-only native tools (Read/Glob/Grep/Task/WebSearch) and a curated WebFetch domain allowlist; no shell tool is exposed.");
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
  const strictMcp = resolveStrictMcp(options);
  if (strictMcp) {
    notes.push("MCP scope: strict (only --mcp-config entries; project/local MCPs not inherited).");
  } else {
    notes.push("MCP scope: inheriting project and local MCPs in addition to --mcp-config.");
  }
  const timeoutMs = resolveTimeout(options, reviewConfig);
  const permissionMode = resolvePermissionMode(options);
  const webDomains = coerceMultiValue(options["web-domain"]);
  const addDirs = validateAddDirs(cwd, options["add-dir"]);
  const stagedMcp = stageMcpConfigs(cwd, options["mcp-config"]);

  return {
    reviewKind: kind,
    preset: options.preset ?? null,
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
    mcpConfigs: stagedMcp.configs,
    mcpConfigTempRoots: stagedMcp.tempRoots,
    strictMcpConfig: strictMcp,
    addDirs,
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

function buildBackgroundJob(cwd, kind, snapshot, stateOptions = {}) {
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
  createJob(cwd, jobId, job, stateOptions);
  writeJobInput(cwd, jobId, snapshot, stateOptions);
  const childArgs = [SCRIPT_PATH, "run-job", jobId, "--cwd", cwd];
  if (stateOptions.jobDir) childArgs.push("--job-dir", stateOptions.jobDir);
  const pid = spawnDetached(process.execPath, childArgs, {
    cwd,
    logFile: resolveJobLogFile(cwd, jobId, stateOptions)
  });
  writeJob(cwd, jobId, { ...job, pid, status: "running", updatedAt: new Date().toISOString() }, stateOptions);
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

function cleanupSnapshotArtifacts(snapshot) {
  const snapshotRoot = snapshot?.directorySnapshot?.snapshotRoot;
  if (snapshotRoot) {
    try {
      fs.rmSync(snapshotRoot, { recursive: true, force: true });
    } catch {}
  }
  for (const tempRoot of snapshot?.mcpConfigTempRoots ?? []) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

function persistJobDiagnostics(cwd, jobId, patch, stateOptions = {}) {
  try {
    const current = listJobs(cwd, stateOptions).find((job) => job.id === jobId) ?? {};
    updateJob(cwd, jobId, {
      diagnostics: mergeDiagnostics(current.diagnostics, patch),
      currentPhase: patch?.currentPhase ?? current.currentPhase
    }, stateOptions);
  } catch {}
}

async function runSnapshot(cwd, jobId, snapshot, stateOptions = {}) {
  const log = (line, level = "info") => appendLogLine(cwd, jobId, line, level, stateOptions);
  log(
    `Starting ${snapshot.reviewKind} (${snapshot.unrestricted ? "UNRESTRICTED" : snapshot.agentic ? "agentic-safe" : "structured"}) with ${snapshot.model}/${snapshot.effort}`
  );
  log(`Context mode: ${snapshot.contextMode} (${snapshot.inputBytes} bytes)`);
  persistJobDiagnostics(cwd, jobId, {
    cwd,
    model: snapshot.model,
    effort: snapshot.effort,
    permissionMode: snapshot.permissionMode,
    contextBytes: snapshot.inputBytes,
    currentPhase: "prompt_context_built"
  }, stateOptions);
  log("Prompt/context built");
  if (snapshot.debug) {
    log(`Changed files: ${snapshot.changedFiles.join(", ") || "(none)"}`, "debug");
    log(`MCP scope: ${snapshot.strictMcpConfig ? "strict" : "inherited"}; add-dir count: ${snapshot.addDirs.length}`, "debug");
  }
  if (snapshot.maxBudgetUsd && !snapshot.subscriptionAuth) {
    log(`Budget cap: $${snapshot.maxBudgetUsd.toFixed(2)}`);
  } else if (snapshot.maxBudgetUsd && snapshot.subscriptionAuth) {
    log(`Budget cap requested ($${snapshot.maxBudgetUsd.toFixed(2)}) but suppressed under subscription auth`);
  }
  const promptPath = resolveJobPromptFile(cwd, jobId, stateOptions);
  let stdoutSeen = false;
  let stderrSeen = false;
  const hooks = {
    promptPath,
    onInvocation(meta) {
      log(`Claude invocation built; prompt saved to ${meta.promptPath}`);
      persistJobDiagnostics(cwd, jobId, meta, stateOptions);
    },
    onSpawn(meta) {
      log(`Claude process spawned pid=${meta.pid}`);
      persistJobDiagnostics(cwd, jobId, {
        childPid: meta.pid,
        command: meta.command,
        currentPhase: meta.phase ?? "claude_spawned"
      }, stateOptions);
    },
    onFirstStdout(meta) {
      if (stdoutSeen) return;
      stdoutSeen = true;
      log("First stdout byte received");
      persistJobDiagnostics(cwd, jobId, { stdoutTail: meta.text, currentPhase: meta.phase ?? "claude_stdout" }, stateOptions);
    },
    onFirstStderr(meta) {
      if (stderrSeen) return;
      stderrSeen = true;
      log("First stderr byte received");
      persistJobDiagnostics(cwd, jobId, { stderrTail: meta.text, currentPhase: meta.phase ?? "claude_stderr" }, stateOptions);
    },
    onDiagnosticUpdate(patch) {
      persistJobDiagnostics(cwd, jobId, patch, stateOptions);
    },
    onExit(meta) {
      log(`Claude exited code=${meta.status ?? "null"} signal=${meta.signal ?? "null"}`);
      persistJobDiagnostics(cwd, jobId, {
        childPid: meta.pid,
        command: meta.command,
        exitCode: meta.status,
        signal: meta.signal,
        stdoutTail: meta.stdoutTail,
        stderrTail: meta.stderrTail,
        currentPhase: `${meta.phase ?? "claude"}_exited`
      }, stateOptions);
    },
    onPhase(phase, meta = {}) {
      log(`Phase: ${phase}`);
      persistJobDiagnostics(cwd, jobId, { currentPhase: phase, ...meta }, stateOptions);
    }
  };

  try {
    const result = await runClaudeStructuredReview(cwd, snapshot, snapshot.reviewKind, snapshot.schemaPath, hooks);
    log(
      `Claude returned ${result.parsed.findings?.length ?? 0} finding(s) using ${result.activity?.toolUseCount ?? 0} tool call(s)`
    );
    if (result.invocationMeta?.fallbackUsed) {
      log("Claude-only markdown fallback was used after structured path probe timeout", "warn");
    }
    if (result.invocationMeta?.earlyStructuredOutput) {
      log("Claude structured output completed before process exit; stopped child early to avoid CLI stall");
    }
    if (result.activity?.parseErrors > 0) {
      log(
        `WARNING: stream parser saw ${result.activity.parseErrors} malformed JSON line(s); structured output recovered but some events may have been dropped`,
        "warn"
      );
    }
    return result;
  } catch (error) {
    log(`Failed: ${error.message}`, "error");
    persistJobDiagnostics(cwd, jobId, {
      ...(error.diagnostics ?? {}),
      reason: reasonFromError(error),
      currentPhase: error.diagnostics?.currentPhase ?? "failed"
    }, stateOptions);
    throw error;
  }
}

// Normalize a TOML line for header comparison: strip leading whitespace, drop
// inline comments, strip trailing whitespace (handles CRLF \r). Returns null for
// comment-only lines so they cannot mask a real registration.
function stripTomlInlineComment(line) {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && inDouble) { i += 1; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === "#" && !inDouble && !inSingle) {
      return line.slice(0, i);
    }
  }
  return line;
}

function normalizeTomlLine(line) {
  const left = line.trimStart();
  if (left.startsWith("#")) return null;
  return stripTomlInlineComment(left).trimEnd();
}

// Count unescaped `[` and `]` that appear outside double/single quoted strings on a line.
// Used to track multiline-array depth so an array element line like `  ["a"]` is not
// mistaken for a section header.
function countBracketsOutsideStrings(line) {
  let open = 0;
  let close = 0;
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && (inDouble || inSingle)) { i += 1; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (inDouble || inSingle) continue;
    if (ch === "[") open += 1;
    else if (ch === "]") close += 1;
  }
  return { open, close };
}

// True iff the normalised line is a complete TOML table header line:
//   [key.path]   or   [[key.path]]
// Rejects multiline-array element lines like `["a"]` ON ITS OWN — the depth tracker
// in findTomlSectionStart / findNextSectionStart provides the surrounding context.
function isCompleteTableHeader(normalized) {
  if (normalized.startsWith("[[") && normalized.endsWith("]]")) {
    return /^\[\[[^[\]]+\]\]$/.test(normalized);
  }
  if (
    normalized.startsWith("[")
    && !normalized.startsWith("[[")
    && normalized.endsWith("]")
    && !normalized.endsWith("]]")
  ) {
    return /^\[[^[\]]+\]$/.test(normalized);
  }
  return false;
}

// Returns the byte offset where a non-commented header line equal to bareHeader
// (or the optional quoted-key variant) begins. Tolerant of indentation, inline
// comments, and CRLF line endings. Ignores lines inside a multiline value.
function findTomlSectionStart(content, bareHeader, quotedHeader) {
  let pos = 0;
  let bracketDepth = 0;
  for (const line of content.split("\n")) {
    const normalized = normalizeTomlLine(line);
    if (
      normalized !== null
      && bracketDepth === 0
      && (normalized === bareHeader || (quotedHeader && normalized === quotedHeader))
    ) {
      return pos;
    }
    if (normalized !== null) {
      const { open, close } = countBracketsOutsideStrings(normalized);
      bracketDepth = Math.max(0, bracketDepth + open - close);
    }
    pos += line.length + 1;
  }
  return -1;
}

// Returns the byte offset of the NEXT TOML table header at or after fromOffset,
// or -1 if none. Treats both `[foo]` and `[[foo]]` as boundaries; ignores lines
// inside a multiline array value (depth tracking).
function findNextSectionStart(content, fromOffset) {
  let pos = fromOffset;
  let bracketDepth = 0;
  while (pos < content.length) {
    const nlIdx = content.indexOf("\n", pos);
    const lineEnd = nlIdx === -1 ? content.length : nlIdx;
    const line = content.slice(pos, lineEnd);
    const normalized = normalizeTomlLine(line);
    if (normalized !== null && bracketDepth === 0 && isCompleteTableHeader(normalized)) {
      return pos;
    }
    if (normalized !== null) {
      const { open, close } = countBracketsOutsideStrings(normalized);
      bracketDepth = Math.max(0, bracketDepth + open - close);
    }
    if (nlIdx === -1) return -1;
    pos = nlIdx + 1;
  }
  return -1;
}

function getTomlSection(content, bareHeader, quotedHeader = null) {
  const start = findTomlSectionStart(content, bareHeader, quotedHeader);
  if (start === -1) return null;
  const afterHeaderLine = content.indexOf("\n", start);
  const scanFrom = afterHeaderLine === -1 ? content.length : afterHeaderLine + 1;
  const nextSection = findNextSectionStart(content, scanFrom);
  const end = nextSection === -1 ? content.length : nextSection;
  return content.slice(start, end);
}

function readTomlScalar(stanza, key) {
  if (!stanza) return undefined;
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`);
  let bracketDepth = 0;
  for (const line of stanza.split("\n")) {
    const normalized = normalizeTomlLine(line);
    if (normalized === null) continue;
    if (bracketDepth === 0) {
      const match = normalized.match(keyPattern);
      if (match) {
        const rawValue = match[1].trim();
        if (rawValue.startsWith("[") || rawValue.startsWith("{")) return undefined;
        if (rawValue === "true") return true;
        if (rawValue === "false") return false;
        if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
          const body = rawValue.slice(1, -1);
          if (rawValue.startsWith('"')) {
            try {
              return JSON.parse(rawValue);
            } catch {
              return body;
            }
          }
          return body;
        }
        return rawValue;
      }
    }
    const { open, close } = countBracketsOutsideStrings(normalized);
    bracketDepth = Math.max(0, bracketDepth + open - close);
  }
  return undefined;
}

function codexPluginConfigured(raw, pluginRoot) {
  const marketplaceHeader = `[marketplaces.${CODEX_MARKETPLACE_KEY}]`;
  const marketplaceHeaderQuoted = `[marketplaces."${CODEX_MARKETPLACE_KEY}"]`;
  const pluginHeader = `[plugins."${CODEX_PLUGIN_KEY}"]`;
  const pluginHeaderDotted = `[plugins.claude-review.${CODEX_MARKETPLACE_KEY}]`;
  const marketplaceStanza = getTomlSection(raw, marketplaceHeader, marketplaceHeaderQuoted);
  const pluginStanza = getTomlSection(raw, pluginHeader) ?? getTomlSection(raw, pluginHeaderDotted);
  if (!marketplaceStanza || !pluginStanza) return false;

  const expectedSource = pluginRoot.split(path.sep).join("/");
  return (
    readTomlScalar(marketplaceStanza, "source_type") === "local" &&
    readTomlScalar(marketplaceStanza, "source") === expectedSource &&
    readTomlScalar(pluginStanza, "enabled") === true
  );
}

function safeTimestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function writeTextFileAtomically(filePath, content, { backupExisting = false } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let backupPath = null;
  if (backupExisting && fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak.${safeTimestampForPath()}`;
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original error; close failure is cleanup-only.
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Preserve the original error; temp cleanup is best-effort.
    }
    throw err;
  }

  return { backupPath };
}

function resolveCodexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function resolveDefaultCodexConfigPath() {
  return path.join(resolveCodexHome(), "config.toml");
}

function buildMarketplaceWrapperManifest() {
  return {
    name: CODEX_MARKETPLACE_KEY,
    interface: {
      displayName: "Claude Review Private"
    },
    plugins: [
      {
        name: CODEX_PLUGIN_NAME,
        source: {
          source: "local",
          path: `./${CODEX_MARKETPLACE_PLUGIN_SUBDIR}`
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        },
        category: "Coding"
      }
    ]
  };
}

function codexPluginCliAvailable(cwd = process.cwd()) {
  const result = runCommand("codex", ["plugin", "marketplace", "add", "--help"], { cwd, timeout: 10_000 });
  return !result.error && result.status === 0;
}

function formatProcessFailure(result) {
  return String(result.stderr || result.stdout || result.error?.message || "no output").trim();
}

function ensureMarketplaceWrapper(wrapperRoot, pluginRoot) {
  const wrapperPluginDir = path.join(wrapperRoot, CODEX_MARKETPLACE_PLUGIN_SUBDIR);
  fs.mkdirSync(path.dirname(wrapperPluginDir), { recursive: true });

  const desiredRealPath = fs.realpathSync(pluginRoot);
  let needsLink = true;
  try {
    const existing = fs.lstatSync(wrapperPluginDir);
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink marketplace plugin path: ${wrapperPluginDir}`);
    }
    const currentRealPath = fs.realpathSync(wrapperPluginDir);
    if (currentRealPath === desiredRealPath) {
      needsLink = false;
    } else {
      fs.rmSync(wrapperPluginDir, { force: true, recursive: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (needsLink) {
    fs.symlinkSync(pluginRoot, wrapperPluginDir, process.platform === "win32" ? "junction" : "dir");
  }

  const manifestPath = path.join(wrapperRoot, ".agents", "plugins", "marketplace.json");
  const manifest = `${JSON.stringify(buildMarketplaceWrapperManifest(), null, 2)}\n`;
  writeTextFileAtomically(manifestPath, manifest);
  return { wrapperRoot, wrapperPluginDir, manifestPath };
}

function resolveCodexPluginSourcePath(entry) {
  const rawSourcePath = entry?.source?.path;
  if (!rawSourcePath) return null;
  const sourcePathText = String(rawSourcePath);
  if (path.isAbsolute(sourcePathText)) return sourcePathText;

  const marketplaceRoot = entry.marketplaceSource?.source ? String(entry.marketplaceSource.source) : null;
  if (marketplaceRoot && path.isAbsolute(marketplaceRoot)) {
    return path.resolve(marketplaceRoot, sourcePathText);
  }

  return path.resolve(sourcePathText);
}

function getCodexPluginCliStatus(pluginRoot, cwd = process.cwd()) {
  const result = runCommand("codex", ["plugin", "list", "--json"], { cwd, timeout: 15_000 });
  if (result.error || result.status !== 0) {
    return { available: false, configured: false, enabled: false, detail: formatProcessFailure(result) };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || "{}"));
    const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
    const entry = installed.find((item) => item?.pluginId === CODEX_PLUGIN_KEY);
    if (!entry) {
      return { available: true, configured: false, enabled: false, detail: "plugin not installed" };
    }
    const sourcePath = resolveCodexPluginSourcePath(entry);
    let sourceMatches = false;
    try {
      sourceMatches = Boolean(sourcePath && fs.realpathSync(sourcePath) === fs.realpathSync(pluginRoot));
    } catch (err) {
      return {
        available: true,
        configured: false,
        enabled: Boolean(entry.enabled),
        detail: `plugin source path did not resolve: ${err.message}`,
        sourcePath,
        version: entry.version ?? null
      };
    }
    return {
      available: true,
      configured: Boolean(entry.enabled && sourceMatches),
      enabled: Boolean(entry.enabled),
      detail: sourceMatches ? "plugin installed via Codex plugin CLI" : "plugin installed from a different source",
      sourcePath,
      version: entry.version ?? null
    };
  } catch (err) {
    return { available: true, configured: false, enabled: false, detail: `codex plugin list parse failed: ${err.message}` };
  }
}

function runCodexPluginCliEnable({ configPath, pluginRoot, dryRun, asJson }) {
  const codexHome = path.dirname(configPath);
  const wrapperRoot = path.join(codexHome, CODEX_MARKETPLACE_WRAPPER_DIR, CODEX_MARKETPLACE_KEY);
  const before = getCodexPluginCliStatus(pluginRoot);
  const alreadyEnabled = before.configured;

  if (dryRun) {
    const payload = {
      configPath,
      pluginRoot,
      method: "codex-plugin-cli",
      marketplaceRoot: wrapperRoot,
      alreadyEnabled,
      dryRun: true,
      added: alreadyEnabled ? [] : ["marketplace", CODEX_PLUGIN_KEY],
      updated: [],
      backupPath: null
    };
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (alreadyEnabled) {
      process.stdout.write(`[dry-run] Plugin already registered with Codex plugin CLI in ${configPath}\n`);
    } else {
      process.stdout.write(`[dry-run] Would install ${CODEX_PLUGIN_KEY} through Codex plugin CLI using ${wrapperRoot}\n`);
    }
    return;
  }

  const wrapper = ensureMarketplaceWrapper(wrapperRoot, pluginRoot);
  const marketplace = runCommand("codex", ["plugin", "marketplace", "add", wrapper.wrapperRoot, "--json"], {
    timeout: 60_000
  });
  if (marketplace.error || marketplace.status !== 0) {
    throw new Error(`codex plugin marketplace add failed: ${formatProcessFailure(marketplace)}`);
  }

  const install = runCommand("codex", ["plugin", "add", CODEX_PLUGIN_KEY, "--json"], { timeout: 60_000 });
  if (install.error || install.status !== 0) {
    throw new Error(`codex plugin add failed: ${formatProcessFailure(install)}`);
  }

  const after = getCodexPluginCliStatus(pluginRoot);
  if (!after.configured) {
    throw new Error(`codex plugin install did not verify: ${after.detail}`);
  }

  const payload = {
    configPath,
    pluginRoot,
    method: "codex-plugin-cli",
    marketplaceRoot: wrapper.wrapperRoot,
    alreadyEnabled,
    dryRun: false,
    added: alreadyEnabled ? [] : ["marketplace", CODEX_PLUGIN_KEY],
    updated: alreadyEnabled ? [CODEX_PLUGIN_KEY] : [],
    backupPath: null,
    installedVersion: after.version ?? null
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (alreadyEnabled) {
    process.stdout.write(
      `Plugin already registered with Codex plugin CLI in ${configPath}\n` +
        `Refreshed local marketplace wrapper at ${wrapper.wrapperRoot}\n` +
        `Restart Codex CLI to activate any refreshed plugin assets.\n`
    );
  } else {
    process.stdout.write(
      `Plugin registered with Codex plugin CLI in ${configPath}\n` +
        `Marketplace wrapper: ${wrapper.wrapperRoot}\n` +
        `Changed: marketplace, ${CODEX_PLUGIN_KEY}\n` +
        `Restart Codex CLI to activate the plugin.\n`
    );
  }
}

function handleEnable(argv) {
  // Pre-scan: detect `--config` passed with no value (parseArgs leaves it as undefined,
  // which is indistinguishable from `--config` not passed at all).
  const normalizedArgv = argv;
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    if (normalizedArgv[i] === "--config") {
      const next = normalizedArgv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--config requires a non-empty path argument");
      }
    }
  }

  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json", "dry-run"], valueOptions: ["config"] });

  if (positionals.length > 0) {
    throw new Error(`Expected no positional arguments, got: ${positionals.join(" ")} — use --dry-run (not --dryrun) to preview changes`);
  }
  if (options.config !== undefined && (typeof options.config !== "string" || options.config.trim() === "")) {
    throw new Error("--config requires a non-empty path argument");
  }

  const explicitConfigPath = options.config !== undefined;
  const configPath = explicitConfigPath
    ? path.resolve(options.config)
    : resolveDefaultCodexConfigPath();
  const pluginRoot = ROOT_DIR;

  const pluginJsonPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    throw new Error(`plugin manifest not found at ${pluginJsonPath} — run 'enable' from the installed plugin directory`);
  }
  const marketplaceManifestPath = path.join(pluginRoot, ".agents", "plugins", "marketplace.json");
  if (!fs.existsSync(marketplaceManifestPath)) {
    throw new Error(`marketplace manifest not found at ${marketplaceManifestPath} — run 'enable' from the installed plugin directory`);
  }

  if (!explicitConfigPath && codexPluginCliAvailable()) {
    runCodexPluginCliEnable({
      configPath,
      pluginRoot,
      dryRun: Boolean(options["dry-run"]),
      asJson: Boolean(options.json)
    });
    return;
  }

  let existing = "";
  try {
    existing = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const marketplaceHeader = `[marketplaces.${CODEX_MARKETPLACE_KEY}]`;
  const marketplaceHeaderQuoted = `[marketplaces."${CODEX_MARKETPLACE_KEY}"]`;
  const pluginHeader = `[plugins."${CODEX_PLUGIN_KEY}"]`;
  const pluginHeaderDotted = `[plugins.claude-review.${CODEX_MARKETPLACE_KEY}]`;

  // JSON.stringify produces a valid TOML basic string — quotes and backslashes are properly escaped.
  const safeSource = JSON.stringify(pluginRoot.split(path.sep).join("/"));

  let updated = existing;
  const toAdd = [];
  const toUpdate = [];

  const mIdx = findTomlSectionStart(updated, marketplaceHeader, marketplaceHeaderQuoted);
  if (mIdx === -1) {
    updated += `\n${marketplaceHeader}\nsource_type = "local"\nsource = ${safeSource}\n`;
    toAdd.push(marketplaceHeader);
  } else {
    const afterHeaderLine = updated.indexOf("\n", mIdx);
    const scanFrom = afterHeaderLine === -1 ? updated.length : afterHeaderLine + 1;
    const nextSec = findNextSectionStart(updated, scanFrom);
    const stanzaEnd = nextSec === -1 ? updated.length : nextSec;
    const stanza = updated.slice(mIdx, stanzaEnd);

    let newStanza = stanza;

    // Refresh source= (handles "double" and 'single' quoted values, indented keys).
    // Preserve any existing leading whitespace so an indented config stays indented.
    const sourceUpdated = newStanza.replace(
      /\n([ \t]*)source\s*=\s*(?:"[^"]*"|'[^']*')/,
      (_, indent) => `\n${indent}source = ${safeSource}`
    );
    if (sourceUpdated !== newStanza) {
      newStanza = sourceUpdated;
      toUpdate.push("source");
    } else if (!/\n[ \t]*source\s*=/.test(newStanza)) {
      newStanza = newStanza.trimEnd() + `\nsource = ${safeSource}\n`;
      toUpdate.push("source");
    }

    // Normalize source_type to "local" (repair wrong value or insert if absent). Preserve indent.
    const stMatch = newStanza.match(/\n[ \t]*source_type\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (stMatch) {
      const currentValue = stMatch[1] ?? stMatch[2] ?? "";
      if (currentValue !== "local") {
        newStanza = newStanza.replace(
          /\n([ \t]*)source_type\s*=\s*(?:"[^"]*"|'[^']*')/,
          (_, indent) => `\n${indent}source_type = "local"`
        );
        toUpdate.push("source_type");
      }
    } else if (!/\n[ \t]*source_type\s*=/.test(newStanza)) {
      newStanza = newStanza.trimEnd() + '\nsource_type = "local"\n';
      toUpdate.push("source_type");
    }

    if (newStanza !== stanza) {
      updated = updated.slice(0, mIdx) + newStanza + updated.slice(stanzaEnd);
    }
  }

  const pIdx = findTomlSectionStart(updated, pluginHeader, pluginHeaderDotted);
  if (pIdx === -1) {
    updated += `\n${pluginHeader}\nenabled = true\n`;
    toAdd.push(pluginHeader);
  } else {
    const afterHeaderLine = updated.indexOf("\n", pIdx);
    const scanFrom = afterHeaderLine === -1 ? updated.length : afterHeaderLine + 1;
    const nextSec = findNextSectionStart(updated, scanFrom);
    const stanzaEnd = nextSec === -1 ? updated.length : nextSec;
    const stanza = updated.slice(pIdx, stanzaEnd);

    let newStanza = stanza;

    // Flip enabled = false → true (preserving indent), or insert if absent entirely.
    const flipped = newStanza.replace(
      /\n([ \t]*)enabled\s*=\s*false/,
      (_, indent) => `\n${indent}enabled = true`
    );
    if (flipped !== newStanza) {
      newStanza = flipped;
      toUpdate.push("enabled");
    } else if (!/\n[ \t]*enabled\s*=/.test(newStanza)) {
      newStanza = newStanza.trimEnd() + "\nenabled = true\n";
      toUpdate.push("enabled");
    }

    if (newStanza !== stanza) {
      updated = updated.slice(0, pIdx) + newStanza + updated.slice(stanzaEnd);
    }
  }

  const alreadyEnabled = toAdd.length === 0 && toUpdate.length === 0;
  const dryRun = options["dry-run"] ?? false;
  let backupPath = null;

  if (!dryRun && !alreadyEnabled) {
    ({ backupPath } = writeTextFileAtomically(configPath, updated, { backupExisting: existing !== "" }));
  }

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ configPath, pluginRoot, alreadyEnabled, dryRun, added: toAdd, updated: toUpdate, backupPath }, null, 2) + "\n"
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
        (backupPath ? `Backup written to ${backupPath}\n` : "") +
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

/**
 * Deep diagnostic — reports the live state of every dependency the helper needs:
 * plugin config in ~/.codex/config.toml, Codex session awareness (best-effort),
 * Claude CLI availability + auth, job-dir writability, snapshot capability,
 * prompt transport mode. Emits a structured `problems[]` and a `recommended_action`
 * so the user (or Codex) can fix the first failure deterministically.
 */
function handleDoctor(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json", "probe-runtime"], valueOptions: ["cwd", "config", "job-dir"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const minimumNodeVersion = String(JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).engines?.node ?? ">=18.18.0").replace(/^>=/, "");
  const nodeVersion = process.versions.node;
  const nodeSupported = nodeVersionAtLeast(nodeVersion, minimumNodeVersion);

  // Plugin configuration in ~/.codex/config.toml (or --config override).
  const explicitConfigPath = options.config !== undefined;
  const codexConfigPath = explicitConfigPath
    ? path.resolve(options.config)
    : resolveDefaultCodexConfigPath();
  let pluginConfigured = false;
  let configPathExists = false;
  let configReadError = null;
  try {
    const raw = fs.readFileSync(codexConfigPath, "utf8");
    configPathExists = true;
    pluginConfigured = codexPluginConfigured(raw, ROOT_DIR);
  } catch (err) {
    if (err.code !== "ENOENT") {
      configReadError = err.message;
    }
  }
  const pluginCliStatus = explicitConfigPath
    ? { available: false, configured: false, enabled: false, detail: "skipped for --config override" }
    : getCodexPluginCliStatus(ROOT_DIR);
  pluginConfigured = pluginConfigured || pluginCliStatus.configured;

  // Codex session awareness — heuristic. Codex doesn't expose a public env var yet,
  // so we look for any CODEX_* env var or the well-known CODEX_PLUGIN_ROOT marker.
  // When unknown we return `null` rather than `false` so the caller can disambiguate.
  const codexEnvSignals = Object.keys(process.env).filter((k) => k.startsWith("CODEX_"));
  const pluginLoadedInCurrentSession =
    process.env.CODEX_PLUGIN_ROOT
      ? true
      : codexEnvSignals.length > 0
        ? null
        : false;

  // Helper itself is by definition available — we are running it.
  const helperAvailable = true;
  const helperVersion = getPackageVersion();

  // Claude availability + auth — reuse the existing setup payload (without the
  // expensive runtime probe to keep doctor fast).
  const claude = getClaudeAvailability(cwd);
  const claudeVersion = claude.available ? getClaudeVersion(cwd) : { version: null, detail: "claude unavailable" };
  const auth = claude.available ? getClaudeAuthStatus(cwd) : { loggedIn: false, detail: "claude unavailable" };
  const claudeCliAvailable = Boolean(claude.available);
  const claudeAuthenticated = Boolean(claude.available && auth.loggedIn);
  const runtimeProbePerformed = Boolean(options["probe-runtime"] && claudeCliAvailable && claudeAuthenticated);
  const runtimeProbe = runtimeProbePerformed
    ? probeClaudeStructuredOutput(cwd)
    : {
        ready: null,
        detail: options["probe-runtime"]
          ? "runtime probe skipped because Claude CLI is unavailable or unauthenticated"
          : "runtime probe skipped; pass --probe-runtime to validate live model access"
      };

  // Job-dir writability — probe the fallback chain.
  let jobDir = null;
  let jobDirWritable = false;
  let jobDirError = null;
  try {
    jobDir = resolveJobsDir(cwd, options["job-dir"] ? { jobDir: options["job-dir"] } : {});
    jobDirWritable = true;
  } catch (err) {
    jobDirError = err.message;
  }

  // Snapshot capability — gated only on git binary being available.
  const gitProbe = runCommand("git", ["--version"], { cwd });
  const supportsNonGitDirectory = !gitProbe.error && gitProbe.status === 0;
  const gitVersion = supportsNonGitDirectory ? String(gitProbe.stdout ?? "").trim() : null;

  // Prompt transport — Wave 1 sets this to "stdin" unconditionally.
  const promptTransport = "stdin";

  // Problems + recommended action.
  const problems = [];
  if (!nodeSupported) {
    problems.push({
      code: "NODE_VERSION_UNSUPPORTED",
      message: `Node ${nodeVersion} is below the required ${minimumNodeVersion}.`,
      recovery: "Install Node.js 18.18 or newer, then re-run `codex-claude doctor`."
    });
  }
  if (!pluginConfigured) {
    problems.push({
      code: "PLUGIN_NOT_CONFIGURED",
      message: configPathExists
        ? `Codex config at ${codexConfigPath} does not contain the claude-review marketplace/plugin stanzas.`
        : `Codex config not found at ${codexConfigPath}.`,
      recovery: "Run `codex-claude enable` to register the plugin."
    });
  }
  if (!claudeCliAvailable) {
    problems.push({
      code: "CLAUDE_CLI_MISSING",
      message: claude.detail,
      recovery: "Install Claude Code CLI and ensure `claude` is on PATH."
    });
  } else if (!claudeAuthenticated) {
    problems.push({
      code: "CLAUDE_NOT_AUTHENTICATED",
      message: auth.detail || "Claude CLI is not signed in.",
      recovery: "Run `claude auth login`."
    });
  } else if (claudeVersion.version && !nodeVersionAtLeast(claudeVersion.version, MINIMUM_CLAUDE_VERSION)) {
    problems.push({
      code: "CLAUDE_VERSION_TOO_OLD",
      message: `Claude Code CLI ${claudeVersion.version} is below the required ${MINIMUM_CLAUDE_VERSION} for this release's default ${DEFAULT_MODEL} / ${DEFAULT_EFFORT} review profile.`,
      recovery: "Update Claude Code CLI, then re-run `codex-claude doctor --probe-runtime`."
    });
  }
  if (!jobDirWritable) {
    problems.push({
      code: "JOB_DIR_UNWRITABLE",
      message: jobDirError || "No writable job directory in the fallback chain.",
      recovery: `Set ${JOB_DIR_ENV_VAR}=<path> or pass --job-dir <path>.`
    });
  }
  if (!supportsNonGitDirectory) {
    problems.push({
      code: "GIT_BINARY_MISSING",
      message: "git binary not found; snapshot mode for non-Git directories will fail.",
      recovery: "Install git and ensure it is on PATH."
    });
  }
  if (runtimeProbePerformed && !runtimeProbe.ready) {
    problems.push({
      code: "CLAUDE_RUNTIME_UNHEALTHY",
      message: runtimeProbe.detail || "Claude CLI non-interactive model probe failed.",
      recovery: "Run `codex-claude setup` for the full auth/runtime report, then retry `codex-claude doctor --probe-runtime`."
    });
  }
  if (pluginLoadedInCurrentSession === false && pluginConfigured) {
    problems.push({
      code: "PLUGIN_NOT_LOADED_IN_SESSION",
      message: "Plugin is registered in config but the current shell does not appear to be a Codex session.",
      recovery: "Restart Codex CLI, or use the helper directly (`codex-claude folder <path>`)."
    });
  }

  const recommendedAction = problems.length > 0
    ? problems[0].recovery
    : "All checks passed. Run `codex-claude folder <path>` to review a directory.";

  const payload = {
    ok: problems.length === 0,
    node_version: nodeVersion,
    node_required: `>=${minimumNodeVersion}`,
    node_supported: nodeSupported,
    plugin_configured: pluginConfigured,
    plugin_config_method: pluginCliStatus.configured ? "codex-plugin-cli" : pluginConfigured ? "config-toml" : null,
    plugin_cli_available: pluginCliStatus.available,
    plugin_cli_detail: pluginCliStatus.detail,
    plugin_loaded_in_current_session: pluginLoadedInCurrentSession,
    requires_codex_reload: pluginConfigured && pluginLoadedInCurrentSession !== true,
    helper_available: helperAvailable,
    helper_version: helperVersion,
    claude_cli_available: claudeCliAvailable,
    claude_cli_version: claudeVersion.version,
    claude_cli_minimum_version: MINIMUM_CLAUDE_VERSION,
    claude_cli_version_detail: claudeVersion.detail,
    claude_authenticated: claudeAuthenticated,
    claude_runtime_probe_performed: runtimeProbePerformed,
    claude_runtime_ready: runtimeProbe.ready,
    claude_runtime_detail: runtimeProbe.detail,
    git_available: supportsNonGitDirectory,
    git_version: gitVersion,
    job_dir: jobDir,
    job_dir_writable: jobDirWritable,
    supports_non_git_directory: supportsNonGitDirectory,
    prompt_transport: promptTransport,
    codex_config_path: codexConfigPath,
    codex_config_exists: configPathExists,
    codex_config_read_error: configReadError,
    problems,
    recommended_action: recommendedAction
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  const lines = [
    "codex-claude doctor",
    "===================",
    "",
    `Node:                         ${payload.node_supported ? "YES" : "NO"} (${payload.node_version}; required ${payload.node_required})`,
    `Helper version:                 ${payload.helper_version}`,
    `Plugin configured in Codex:     ${payload.plugin_configured ? "YES" : "NO"} (${codexConfigPath}${payload.plugin_config_method ? `; ${payload.plugin_config_method}` : ""})`,
    `Plugin loaded in current session: ${payload.plugin_loaded_in_current_session === null ? "UNKNOWN" : payload.plugin_loaded_in_current_session ? "YES" : "NO"}`,
    `Claude CLI available:           ${payload.claude_cli_available ? "YES" : "NO"}${payload.claude_cli_version ? ` (${payload.claude_cli_version})` : ""}`,
    `Claude authenticated:           ${payload.claude_authenticated ? "YES" : "NO"}`,
    `Claude runtime probe:           ${payload.claude_runtime_probe_performed ? (payload.claude_runtime_ready ? "READY" : "FAILED") : "SKIPPED"} (${payload.claude_runtime_detail})`,
    `Git available:                  ${payload.git_available ? "YES" : "NO"}${payload.git_version ? ` (${payload.git_version})` : ""}`,
    `Job dir writable:               ${payload.job_dir_writable ? "YES" : "NO"} (${payload.job_dir ?? "—"})`,
    `Supports non-Git directory:     ${payload.supports_non_git_directory ? "YES" : "NO"}`,
    `Prompt transport:               ${payload.prompt_transport}`,
    ""
  ];
  if (problems.length > 0) {
    lines.push(`Problems (${problems.length}):`);
    for (const p of problems) {
      lines.push(`  - [${p.code}] ${p.message}`);
      lines.push(`        → ${p.recovery}`);
    }
    lines.push("");
  }
  lines.push(`Recommended action: ${recommendedAction}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));

  if (problems.length > 0) {
    process.exitCode = 1;
  }
}

async function handleFolder(argv) {
  // Extract the first positional that does not look like a flag and rewrite the argv
  // into `--path <positional> [...remaining]` so handleReviewLike can do the rest.
  // Multiple positionals are not supported — extra positionals after the first are
  // forwarded as focus text via the existing positional-passthrough in handleReviewLike.
  let folderPath = null;
  const rewritten = [];
  let seenPath = false;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!seenPath && typeof tok === "string" && !tok.startsWith("-")) {
      folderPath = tok;
      seenPath = true;
      continue;
    }
    rewritten.push(tok);
  }
  if (!folderPath) {
    throw new Error("Expected a directory path: codex-claude folder <path> [flags]");
  }
  rewritten.unshift("--path", folderPath);
  await handleReviewLike("review", rewritten);
}

async function handleReviewLike(kind, argv) {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: REVIEW_LIKE_BOOLEAN_OPTIONS,
    valueOptions: REVIEW_LIKE_VALUE_OPTIONS,
    repeatableValueOptions: REVIEW_LIKE_REPEATABLE_VALUE_OPTIONS
  });
  const presetResolution = resolvePreset(kind, options);
  kind = presetResolution.kind;
  const effectiveOptions = presetResolution.options;
  const reviewConfig = REVIEW_KIND_CONFIG[kind];
  // `--path` is the new directory-targeting flag; `--cwd` is retained for back-compat.
  const userCwd = path.resolve(effectiveOptions.path ?? effectiveOptions.cwd ?? process.cwd());
  const focusText = positionals.join(" ").trim();

  const stateOptions = effectiveOptions["job-dir"]
    ? { jobDir: path.resolve(effectiveOptions["job-dir"]) }
    : {};

  // Decide whether we need a directory snapshot:
  //   - explicit --scope directory
  //   - or the target directory is not a Git repo
  // Either way, the snapshot creates an isolated, git-initialised workspace and
  // becomes the effective cwd for the rest of the review flow. Source-relative paths
  // stay intact for the user; absolute snapshot paths in results are rewritten back.
  const scope = effectiveOptions.scope ?? "auto";
  const wantsDirectoryScope = scope === "directory";
  const targetIsGit = isGitRepository(userCwd);
  const needsSnapshot = wantsDirectoryScope || !targetIsGit;

  let directorySnapshot = null;
  let cwd = userCwd;
  let backgroundJobStarted = false;
  if (needsSnapshot) {
    directorySnapshot = createDirectorySnapshot(userCwd, {
      tempRoot: effectiveOptions["snapshot-temp-root"],
      excludes: coerceMultiValue(effectiveOptions.exclude)
    });
    cwd = directorySnapshot.snapshotRoot;
    if (!stateOptions.jobDir && !process.env[JOB_DIR_ENV_VAR]) {
      stateOptions.jobDir = path.join(directorySnapshot.sourceRoot, ".claude-review", "jobs");
    }
    // After snapshotting, resolveReviewTarget must scan the copied snapshot
    // contents directly — there is no meaningful branch diff to compute.
    effectiveOptions.scope = "directory";
  }
  let snapshot = null;
  try {
    snapshot = prepareSnapshot(cwd, kind, effectiveOptions, focusText);
    if (directorySnapshot) {
      const skippedPreview = directorySnapshot.skipped
        .slice(0, 12)
        .map((item) => `${item.path} (${item.reason})`)
        .join(", ");
      snapshot.directorySnapshot = {
        sourceRoot: directorySnapshot.sourceRoot,
        snapshotRoot: directorySnapshot.snapshotRoot,
        copiedFiles: directorySnapshot.copiedFiles,
        totalBytes: directorySnapshot.totalBytes,
        skippedCount: directorySnapshot.skipped.length
      };
      snapshot.notes.push(
        `Directory snapshot mode: copied ${directorySnapshot.copiedFiles} file(s) ` +
        `(${directorySnapshot.totalBytes} bytes) from ${directorySnapshot.sourceRoot} ` +
        `to temp git workspace ${directorySnapshot.snapshotRoot}. ` +
        `Skipped ${directorySnapshot.skipped.length} path(s) by excludes, .gitignore, ` +
        `secret-pattern filters, symlinks, or caps` +
        `${skippedPreview ? `: ${skippedPreview}${directorySnapshot.skipped.length > 12 ? ", ..." : ""}` : ""}. ` +
        `Source files are not edited; review job artifacts are stored under ${resolveJobsDir(cwd, stateOptions)}.`
      );
    }

    if (effectiveOptions.background) {
      const job = buildBackgroundJob(cwd, kind, snapshot, stateOptions);
      backgroundJobStarted = true;
      const jobDirArgs = stateOptions.jobDir ? ` --job-dir ${JSON.stringify(stateOptions.jobDir)}` : "";
      process.stdout.write(
        `# Claude Review Started\n\nJob: ${job.id}\nStatus: running\nMode: ${snapshot.unrestricted ? "UNRESTRICTED" : snapshot.agentic ? "agentic-safe" : "structured"}\nModel: ${snapshot.model}\nUse \`codex-claude status ${job.id}${jobDirArgs}\` to check progress.\n`
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
    createJob(cwd, jobId, job, stateOptions);
    writeJobInput(cwd, jobId, snapshot, stateOptions);
    try {
      const result = await runSnapshot(cwd, jobId, snapshot, stateOptions);
      updateJob(cwd, jobId, {
        status: "completed",
        pid: null,
        completedAt: new Date().toISOString(),
        result: result.parsed,
        activity: result.activity,
        invocationMeta: result.invocationMeta,
        // Persist the M2 cross-check verification so background jobs and the
        // `result` reconstruction in handleResult render the same warnings as
        // foreground runs (Codex P2 finding on PR #11).
        evidenceVerification: result.evidenceVerification ?? null
      }, stateOptions);
      process.stdout.write(renderReviewResult(snapshot, result, { id: jobId }));
      if (reviewHasShipBlockers(result.parsed)) {
        process.exitCode = 3;
      }
    } catch (error) {
      const current = listJobs(cwd, stateOptions).find((item) => item.id === jobId) ?? {};
      const failureReason = reasonFromError(error);
      updateJob(cwd, jobId, {
        status: error.code === "EINTERRUPTED" ? "cancelled" : "failed",
        pid: null,
        completedAt: new Date().toISOString(),
        failureReason,
        error: error.message,
        diagnostics: mergeDiagnostics(current.diagnostics, { ...(error.diagnostics ?? {}), reason: failureReason })
      }, stateOptions);
      throw error;
    }
  } finally {
    if (directorySnapshot && (!effectiveOptions.background || !backgroundJobStarted)) {
      directorySnapshot.cleanup();
    }
    if (!effectiveOptions.background || !backgroundJobStarted) {
      cleanupSnapshotArtifacts(snapshot);
    }
  }
}

async function handleRunJob(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "job-dir"] });
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("run-job requires a job id");
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stateOptions = options["job-dir"] ? { jobDir: options["job-dir"] } : {};
  const snapshot = readJobInput(cwd, jobId, stateOptions);
  updateJob(cwd, jobId, { status: "running" }, stateOptions);
  try {
    const result = await runSnapshot(cwd, jobId, snapshot, stateOptions);
    updateJob(cwd, jobId, {
      status: "completed",
      pid: null,
      completedAt: new Date().toISOString(),
      result: result.parsed,
      activity: result.activity,
      invocationMeta: result.invocationMeta,
      // Persist M2 cross-check verification so the `result` reconstruction
      // in handleStatus/handleResult shows the same warnings as foreground
      // runs (Codex P2 finding on PR #11).
      evidenceVerification: result.evidenceVerification ?? null
    }, stateOptions);
  } catch (error) {
    appendLogLine(cwd, jobId, `Failed: ${error.message}`, "error", stateOptions);
    const current = listJobs(cwd, stateOptions).find((item) => item.id === jobId) ?? {};
    const failureReason = reasonFromError(error);
    updateJob(cwd, jobId, {
      status: error.code === "EINTERRUPTED" ? "cancelled" : "failed",
      pid: null,
      completedAt: new Date().toISOString(),
      failureReason,
      error: error.message,
      diagnostics: mergeDiagnostics(current.diagnostics, { ...(error.diagnostics ?? {}), reason: failureReason })
    }, stateOptions);
  } finally {
    cleanupSnapshotArtifacts(snapshot);
  }
}

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "job-dir"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stateOptions = options["job-dir"] ? { jobDir: options["job-dir"] } : {};
  if (positionals[0]) assertValidJobId(positionals[0]);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const allJobs = listJobs(cwd, stateOptions)
    .map((job) => markStaleJob(cwd, job, stateOptions))
    .map((job) => ({ ...job, logTail: readLogTail(cwd, job.id, 6, stateOptions) }));
  const filteredJobs = positionals[0]
    ? allJobs.filter((job) => job.id.startsWith(positionals[0]))
    : allJobs;
  process.stdout.write(renderStatusReport(filteredJobs, workspaceRoot));
}

function jobTimeoutMs(cwd, job, stateOptions = {}) {
  try {
    const snapshot = readJobInput(cwd, job.id, stateOptions);
    return snapshot.timeoutMs ?? 30 * 60 * 1000;
  } catch {
    return 30 * 60 * 1000;
  }
}

function markStaleJob(cwd, job, stateOptions = {}) {
  if (job.status === "stalled") {
    appendLogLine(cwd, job.id, "Legacy stalled job finalized as failed", "error", stateOptions);
    return updateJob(cwd, job.id, {
      status: "failed",
      pid: null,
      failureReason: job.failureReason ?? "stale_timeout",
      completedAt: job.completedAt ?? new Date().toISOString(),
      error: job.error ?? "job was previously marked stalled",
      diagnostics: mergeDiagnostics(job.diagnostics, {
        reason: job.failureReason ?? "stale_timeout",
        currentPhase: job.currentPhase ?? job.diagnostics?.currentPhase ?? "legacy_stalled_job"
      })
    }, stateOptions);
  }
  if (job.status !== "running") {
    return job;
  }
  const updatedAt = Date.parse(job.updatedAt ?? job.createdAt ?? "");
  if (!Number.isFinite(updatedAt)) {
    return job;
  }
  const timeoutMs = jobTimeoutMs(cwd, job, stateOptions);
  if (Date.now() - updatedAt <= timeoutMs) {
    return job;
  }
  appendLogLine(cwd, job.id, `Stale job finalized: exceeded timeout window of ${timeoutMs}ms`, "error", stateOptions);
  return updateJob(cwd, job.id, {
    status: "failed",
    pid: null,
    failureReason: "stale_timeout",
    completedAt: new Date().toISOString(),
    error: `running job exceeded timeout window of ${timeoutMs}ms`,
    diagnostics: mergeDiagnostics(job.diagnostics, {
      reason: "stale_timeout",
      timeoutMs,
      currentPhase: job.currentPhase ?? job.diagnostics?.currentPhase ?? "stale_running_job"
    })
  }, stateOptions);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "job-dir"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stateOptions = options["job-dir"] ? { jobDir: options["job-dir"] } : {};
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("result requires a job id");
  }
  assertValidJobId(jobId);
  const jobs = listJobs(cwd, stateOptions);
  const job = jobs.find((item) => item.id === jobId || item.id.startsWith(jobId));
  if (!job) {
    throw new Error(`Unknown job ${jobId}`);
  }
  if (job.status !== "completed") {
    const withTail = { ...job, logTail: readLogTail(cwd, job.id, 6, stateOptions) };
    process.stdout.write(renderFailureReport(withTail));
    process.exitCode = job.status === "failed" || job.status === "stalled" ? 1 : 2;
    return;
  }
  const snapshot = readJobInput(cwd, job.id, stateOptions);
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
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "job-dir"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stateOptions = options["job-dir"] ? { jobDir: options["job-dir"] } : {};
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("cancel requires a job id");
  }
  assertValidJobId(jobId);
  const jobs = listJobs(cwd, stateOptions);
  const job = jobs.find((item) => item.id === jobId || item.id.startsWith(jobId));
  if (!job) {
    throw new Error(`Unknown job ${jobId}`);
  }
  if (job.status !== "running") {
    process.stdout.write(renderCancelReport(job, false));
    return;
  }
  if (!isProcessAlive(job.pid)) {
    const stalledJob = updateJob(cwd, job.id, {
      status: "stalled",
      pid: null,
      error: "process is not running"
    }, stateOptions);
    process.stdout.write(renderCancelReport(stalledJob, false));
    return;
  }
  const cancelled = terminateProcessTree(job.pid);
  const updatedJob = updateJob(cwd, job.id, {
    status: cancelled ? "cancelled" : job.status,
    pid: cancelled ? null : job.pid,
    completedAt: cancelled ? new Date().toISOString() : job.completedAt
  }, stateOptions);
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
    if (bridgeCommandHelpRequested(argv) && printBridgeCommandUsage(command)) {
      return;
    }
    const bridgeExclusive = new Set(["delegate", "wait", "logs", "recover", "list", "attach", "bridge-doctor", "send", "gc"]);
    if (bridgeExclusive.has(command) || (["status", "cancel"].includes(command) && isBridgeJobInvocation(argv))) {
      const bridgeExitCode = await handleBridgeCommand(command, argv);
      if (typeof bridgeExitCode === "number") process.exitCode = bridgeExitCode;
      return;
    }
    switch (command) {
      case "enable":
        handleEnable(argv);
        break;
      case "setup":
        handleSetup(argv);
        break;
      case "doctor":
        handleDoctor(argv);
        break;
      case "review":
        await handleReviewLike("review", argv);
        break;
      case "folder":
        // `folder <path>` is shorthand for `review --path <path>` — the snapshot
        // path inside handleReviewLike auto-activates for non-Git directories.
        await handleFolder(argv);
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
      case "workspace":
        await handleWorkspace(argv);
        break;
      case "workspace-status":
        handleWorkspaceStatus(argv);
        break;
      case "workspace-logs":
        handleWorkspaceLogs(argv);
        break;
      case "workspace-stop":
        handleWorkspaceStop(argv);
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
    const usageOrValidationError = error.code === "USAGE_ERROR" || isUsageOrValidationError(error);
    const jsonRequested = process.argv.slice(2).includes("--json");
    if (jsonRequested) {
      // Structured error envelope — same shape Codex expects from the doctor
      // command so error handling is uniform across the CLI.
      const envelope = {
        ok: false,
        error_code: error.code ?? (usageOrValidationError ? "USAGE_ERROR" : "INTERNAL_ERROR"),
        message: error.message,
        recovery: error.recovery ?? null,
        retryable: Boolean(error.retryable ?? false)
      };
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    process.exitCode = usageOrValidationError ? 2 : 1;
  }
}

main();
