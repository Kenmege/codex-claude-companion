import fs from "node:fs";

import { binaryAvailable, runCommand, runCommandChecked } from "./process.mjs";

export const DEFAULT_MODEL = "claude-opus-4-6";
export const DEFAULT_EFFORT = "high";
export const LONG_CONTEXT_MODEL = "claude-sonnet-4-6";
export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
export const AUTO_LONG_CONTEXT_BYTES = 250_000;
export const CLAUDE_SETTING_SOURCES = "project,local";
export const CLAUDE_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CLAUDE_SETUP_PROBE_TIMEOUT_MS = 60 * 1000;
export const CLAUDE_SETUP_PROBE_TIMEOUT_ENV = "CODEX_CLAUDE_SETUP_PROBE_TIMEOUT_MS";
const CLAUDE_SETUP_PROBE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: {
      type: "string"
    }
  }
});

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getClaudeSetupProbeTimeoutMs(env = process.env) {
  return parsePositiveInteger(env?.[CLAUDE_SETUP_PROBE_TIMEOUT_ENV]) ?? DEFAULT_CLAUDE_SETUP_PROBE_TIMEOUT_MS;
}

function buildClaudeCommandArgs(prompt, { model, effort, schema, betas = [] } = {}) {
  const args = [
    "-p",
    prompt,
    "--setting-sources",
    CLAUDE_SETTING_SOURCES,
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--effort",
    effort,
    "--tools",
    "",
    "--disable-slash-commands"
  ];

  if (schema) {
    args.push("--json-schema", schema);
  }

  for (const beta of betas) {
    args.push("--betas", beta);
  }

  return args;
}

function parseClaudeStreamEvents(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseClaudeStructuredOutput(stdout) {
  const events = parseClaudeStreamEvents(stdout);
  const resultEvent = [...events].reverse().find((event) => event.type === "result");
  if (resultEvent?.structured_output) {
    return resultEvent.structured_output;
  }

  const toolUseInput = [...events]
    .flatMap((event) => event.message?.content ?? [])
    .find((item) => item?.type === "tool_use" && item.name === "StructuredOutput")?.input;

  if (toolUseInput) {
    return toolUseInput;
  }

  throw new Error("Claude completed without returning structured output.");
}

export function getClaudeAvailability(cwd) {
  return binaryAvailable("claude", ["--help"], { cwd });
}

export function getClaudeAuthStatus(cwd) {
  const result = runCommand("claude", ["auth", "status"], { cwd });
  if (result.error) {
    return {
      loggedIn: false,
      detail: `claude auth status failed (${result.error.code ?? "error"})`
    };
  }
  if (result.status !== 0) {
    return {
      loggedIn: false,
      detail: String(result.stderr || result.stdout || "").trim() || "claude auth status failed"
    };
  }
  try {
    const parsed = JSON.parse(String(result.stdout));
    return {
      loggedIn: Boolean(parsed.loggedIn),
      detail: parsed.loggedIn ? `${parsed.email} via ${parsed.authMethod}` : "not logged in",
      raw: parsed
    };
  } catch {
    return {
      loggedIn: false,
      detail: "claude auth status returned an unexpected format"
    };
  }
}

export function selectClaudeProfile(options = {}) {
  const notes = [];
  let model = options.model ?? DEFAULT_MODEL;
  let effort = options.effort ?? DEFAULT_EFFORT;
  let betas = [];
  let profile = "quality";

  const explicitModel = Boolean(options.model);
  const wantsLongContext = Boolean(options.longContext);
  if (!explicitModel && (wantsLongContext || (options.inputBytes ?? 0) > AUTO_LONG_CONTEXT_BYTES)) {
    model = LONG_CONTEXT_MODEL;
    effort = options.effort ?? DEFAULT_EFFORT;
    betas = [LONG_CONTEXT_BETA];
    profile = "long-context";
    if (!wantsLongContext) {
      notes.push("Auto-switched to the long-context Sonnet profile because the review snapshot exceeded the Opus inline threshold.");
    }
  } else if (options.model && wantsLongContext) {
    notes.push("Long-context was requested with an explicit model override, so the helper kept the explicit model and did not force the documented Sonnet long-context profile.");
  }

  return { model, effort, betas, profile, notes };
}

export function buildReviewPrompt(snapshot, reviewKind) {
  if (reviewKind === "elite-review") {
    return [
      "You are performing an elite adversarial software review over changes likely produced by Codex or GPT.",
      "Your job is to identify the strongest reasons this change should not ship yet.",
      "Review at two levels simultaneously:",
      "- System level: architecture, invariants, rollback safety, operability, observability, compatibility, trust boundaries, concurrency, retries, and degraded dependency behavior.",
      "- Code level: concrete execution failures, empty/null behavior, stale state, race conditions, partial failure, migration hazards, and missing tests.",
      "Default to skepticism. Do not reward good intent, plausible follow-up work, or happy-path correctness.",
      "Prefer a few highly defensible findings over many shallow ones.",
      "Every finding must be tied to a real file and line range from the provided context.",
      "For every finding, explain the failure scenario, why the code is vulnerable, the likely impact, the confidence level, and the test gap.",
      "Use ship_recommendation to state whether this should ship now at all.",
      "Use systemic_risks for cross-cutting design weaknesses that span multiple code paths.",
      "Use blind_spots for material things you could not verify from the provided context.",
      "Do not invent code paths, incidents, files, or runtime behavior you cannot support from the supplied review input.",
      `Review target: ${snapshot.targetLabel}`,
      `Focus: ${snapshot.focusText || "No extra focus provided."}`,
      "",
      "Review input:",
      snapshot.contextText
    ].join("\n");
  }

  const adversarial = reviewKind === "adversarial-review";
  return [
    `You are performing a ${adversarial ? "skeptical adversarial" : "high-scrutiny"} code review over changes likely produced by Codex or GPT.`,
    "Use only the supplied review input.",
    "Do not invent files or line numbers.",
    "Prefer concrete, file-grounded findings over generic advice.",
    adversarial
      ? "Challenge the chosen approach, hidden assumptions, operational risk, rollback safety, migration risk, concurrency issues, and whether a simpler design would have been safer."
      : "Prioritize correctness, regressions, security, migration safety, concurrency, data-loss risk, and missing tests.",
    "If there are no findings, return an empty findings array and make that explicit in the summary.",
    `Review target: ${snapshot.targetLabel}`,
    `Focus: ${snapshot.focusText || "No extra focus provided."}`,
    "",
    "Review input:",
    snapshot.contextText
  ].join("\n");
}

export function probeClaudeStructuredOutput(cwd) {
  const timeoutMs = getClaudeSetupProbeTimeoutMs();
  const prompt = "Return structured output with answer set to OK.";
  const result = runCommand(
    "claude",
    buildClaudeCommandArgs(prompt, {
      model: DEFAULT_MODEL,
      effort: "low",
      schema: CLAUDE_SETUP_PROBE_SCHEMA
    }),
    {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs
    }
  );

  if (result.error) {
    const detail =
      result.error.code === "ETIMEDOUT"
        ? `timed out after ${timeoutMs / 1000}s`
        : `probe failed (${result.error.code ?? "error"})`;
    return { ready: false, detail };
  }

  if (result.status !== 0) {
    return {
      ready: false,
      detail: String(result.stderr || result.stdout || "").trim() || `probe exited with ${result.status}`
    };
  }

  try {
    const parsed = parseClaudeStructuredOutput(result.stdout);
    if (String(parsed.answer ?? "").trim().toUpperCase() !== "OK") {
      return {
        ready: false,
        detail: "probe returned unexpected structured output"
      };
    }
    return {
      ready: true,
      detail: `non-interactive print verified using ${CLAUDE_SETTING_SOURCES}`
    };
  } catch (error) {
    return {
      ready: false,
      detail: `probe output was not parseable (${error.message})`
    };
  }
}

export function runClaudeStructuredReview(cwd, snapshot, reviewKind, schemaPath) {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const prompt = buildReviewPrompt(snapshot, reviewKind);
  const args = buildClaudeCommandArgs(prompt, {
    model: snapshot.model,
    effort: snapshot.effort,
    schema,
    betas: snapshot.betas
  });

  const result = runCommandChecked("claude", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLAUDE_REVIEW_TIMEOUT_MS
  });
  return {
    stdout: String(result.stdout ?? ""),
    parsed: parseClaudeStructuredOutput(result.stdout)
  };
}
