#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  AUTO_LONG_CONTEXT_BYTES,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  getClaudeAuthStatus,
  getClaudeAvailability,
  probeClaudeStructuredOutput,
  runClaudeStructuredReview,
  selectClaudeProfile
} from "./lib/claude.mjs";
import { chooseContextMode, collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { spawnDetached, terminateProcessTree } from "./lib/process.mjs";
import {
  appendLogLine,
  buildJobRecord,
  generateJobId,
  listJobs,
  readJob,
  readJobInput,
  readLogTail,
  updateJob,
  writeJob,
  writeJobInput
} from "./lib/state.mjs";
import { renderCancelReport, renderReviewResult, renderSetupReport, renderStatusReport } from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const ELITE_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "elite-review-output.schema.json");

const REVIEW_KIND_CONFIG = {
  review: {
    reviewLabel: "Review",
    title: "Claude review",
    schemaPath: SCHEMA_PATH,
    jobPrefix: "review"
  },
  "adversarial-review": {
    reviewLabel: "Adversarial Review",
    title: "Claude adversarial review",
    schemaPath: SCHEMA_PATH,
    jobPrefix: "adversarial"
  },
  "elite-review": {
    reviewLabel: "Elite Review",
    title: "Claude elite review",
    schemaPath: ELITE_SCHEMA_PATH,
    jobPrefix: "elite"
  }
};

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
      "  codex-claude-review setup",
      "  codex-claude-review review [--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <name>] [--effort <low|medium|high|max>] [--profile quality|long-context] [--long-context]",
      "  codex-claude-review adversarial-review [same flags] [focus text]",
      "  codex-claude-review elite-review [same flags] [focus text]",
      "  codex-claude-review status [job-id]",
      "  codex-claude-review result <job-id>",
      "  codex-claude-review cancel <job-id>"
    ].join("\n")
  );
}

function buildSetupPayload(cwd) {
  const claude = getClaudeAvailability(cwd);
  const auth = claude.available ? getClaudeAuthStatus(cwd) : { loggedIn: false, detail: "claude unavailable" };
  const runtime = claude.available && auth.loggedIn ? probeClaudeStructuredOutput(cwd) : { ready: false, detail: "runtime probe skipped" };
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
    auth,
    runtime,
    defaults: {
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      autoLongContextBytes: AUTO_LONG_CONTEXT_BYTES
    },
    nextSteps
  };
}

function prepareSnapshot(cwd, kind, options, focusText) {
  const reviewConfig = REVIEW_KIND_CONFIG[kind];
  const target = resolveReviewTarget(cwd, options);
  const reviewContext = collectReviewContext(cwd, target);
  const wantsLongContext = options.profile === "long-context" || Boolean(options["long-context"]);
  const contextSelection = chooseContextMode(reviewContext, { longContext: wantsLongContext });
  const selectedProfile = selectClaudeProfile({
    model: options.model,
    effort: options.effort,
    longContext: wantsLongContext || contextSelection.bytes > AUTO_LONG_CONTEXT_BYTES,
    inputBytes: contextSelection.bytes
  });

  const notes = [...selectedProfile.notes];
  if (contextSelection.mode === "summarized" && selectedProfile.profile === "quality") {
    notes.push("The review snapshot was summarized to stay inside the reliable Opus inline context envelope.");
  }

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
    schemaPath: reviewConfig.schemaPath
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
    profile: snapshot.profile
  });
  writeJob(cwd, jobId, job);
  writeJobInput(cwd, jobId, snapshot);
  const pid = spawnDetached(process.execPath, [SCRIPT_PATH, "run-job", jobId, "--cwd", cwd], { cwd });
  writeJob(cwd, jobId, { ...job, pid, status: "running", updatedAt: new Date().toISOString() });
  return { ...job, pid, status: "running" };
}

function runSnapshot(cwd, jobId, snapshot) {
  appendLogLine(cwd, jobId, `Starting ${snapshot.reviewKind} with ${snapshot.model}/${snapshot.effort}`);
  appendLogLine(cwd, jobId, `Context mode: ${snapshot.contextMode} (${snapshot.inputBytes} bytes)`);
  const result = runClaudeStructuredReview(cwd, snapshot, snapshot.reviewKind, snapshot.schemaPath);
  appendLogLine(cwd, jobId, `Claude returned ${result.parsed.findings.length} finding(s)`);
  return result;
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  process.stdout.write(renderSetupReport(buildSetupPayload(cwd)));
}

function handleReviewLike(kind, argv) {
  const reviewConfig = REVIEW_KIND_CONFIG[kind];
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["background", "long-context"],
    valueOptions: ["base", "scope", "model", "effort", "profile", "cwd"]
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const focusText = kind === "review" ? "" : positionals.join(" ").trim();
  const snapshot = prepareSnapshot(cwd, kind, options, focusText);

  if (options.background) {
    const job = buildBackgroundJob(cwd, kind, snapshot);
    process.stdout.write(
      `# Claude Review Started\n\nJob: ${job.id}\nStatus: running\nModel: ${snapshot.model}\nUse \`codex-claude-review status ${job.id}\` to check progress.\n`
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
    status: "running"
  });
  writeJob(cwd, jobId, job);
  writeJobInput(cwd, jobId, snapshot);
  try {
    const result = runSnapshot(cwd, jobId, snapshot);
    updateJob(cwd, jobId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result.parsed
    });
    process.stdout.write(renderReviewResult(snapshot, result, { id: jobId }));
  } catch (error) {
    updateJob(cwd, jobId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error.message
    });
    throw error;
  }
}

function handleRunJob(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("run-job requires a job id");
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const snapshot = readJobInput(cwd, jobId);
  updateJob(cwd, jobId, { status: "running" });
  try {
    const result = runSnapshot(cwd, jobId, snapshot);
    updateJob(cwd, jobId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result.parsed
    });
  } catch (error) {
    appendLogLine(cwd, jobId, `Failed: ${error.message}`);
    updateJob(cwd, jobId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error.message
    });
  }
}

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let jobs = listJobs(cwd).map((job) => ({ ...job, logTail: readLogTail(cwd, job.id) }));
  if (positionals[0]) {
    jobs = jobs.filter((job) => job.id.startsWith(positionals[0]));
  }
  process.stdout.write(renderStatusReport(jobs, workspaceRoot));
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
    throw new Error(`Job ${job.id} is ${job.status}`);
  }
  const snapshot = readJobInput(cwd, job.id);
  process.stdout.write(renderReviewResult(snapshot, { parsed: job.result }, job));
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
  const cancelled = terminateProcessTree(job.pid);
  updateJob(cwd, job.id, {
    status: cancelled ? "cancelled" : job.status,
    completedAt: cancelled ? new Date().toISOString() : job.completedAt
  });
  process.stdout.write(renderCancelReport(job, cancelled));
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  try {
    switch (command) {
      case "setup":
        handleSetup(argv);
        break;
      case "review":
        handleReviewLike("review", argv);
        break;
      case "adversarial-review":
        handleReviewLike("adversarial-review", argv);
        break;
      case "elite-review":
        handleReviewLike("elite-review", argv);
        break;
      case "run-job":
        handleRunJob(argv);
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
        process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
