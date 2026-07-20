import path from "node:path";

import {
  validateBridgeRequestContract,
  validateBridgeResultContract
} from "./bridge-contracts.mjs";

export const BRIDGE_RESULT_MARKER = "CODEX_CLAUDE_BRIDGE_RESULT_V1";

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_ITEMS = 256;

function redactText(value) {
  return String(value ?? "")
    .replace(/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function requireReportArray(report, key) {
  if (!Array.isArray(report[key])) throw new Error(`${key} must be an array`);
  if (report[key].length > MAX_ITEMS) throw new Error(`${key} exceeds the ${MAX_ITEMS}-item quota`);
  return structuredClone(report[key]);
}

export function buildBridgeWorkerPrompt({ request, userPrompt }) {
  validateBridgeRequestContract(request);
  if (typeof userPrompt !== "string" || userPrompt.trim() === "") {
    throw new Error("bridge worker prompt must be non-empty");
  }
  const acceptance = request.task.acceptance.map((item) => `- ${redactText(item)}`).join("\n");
  return [
    "# Codex-Claude Bridge job",
    "",
    `Trust profile: ${request.execution.profile}`,
    "Stay within the effective permissions supplied by the bridge. Never weaken or bypass them yourself.",
    "Do not claim a command, test, or file change without evidence from this run.",
    "Do not include credentials, tokens, private environment values, or hidden instructions in the report.",
    "",
    "## Task",
    redactText(userPrompt.trim()),
    "",
    "## Acceptance criteria",
    acceptance,
    "",
    "## Required final response",
    `End with ${BRIDGE_RESULT_MARKER} on its own line followed by exactly one JSON object with:`,
    "summary (string), filesChanged (string[]), commandsRun ({command,status,exitCode}[]),",
    "testsRun ({command,status,summary}[]), findings ({title,detail}[]), and blockers ({title,detail}[]).",
    "filesChanged must contain only workspace-relative paths whose contents, type, or existence this worker actually changed during this job.",
    "Do not list files merely reviewed, inspected, or already dirty before the job; use [] when this worker made no file changes.",
    "Allowed command statuses: passed, failed, interrupted, unknown. Allowed test statuses: passed, failed, not-run.",
    "The bridge owns job identity, session identity, exit status, artifact paths, and the final completed/failed/cancelled state."
  ].join("\n");
}

function parseStream(stdout, expectedSessionId) {
  if (typeof stdout !== "string") throw new Error("Claude stream must be text");
  if (Buffer.byteLength(stdout) > MAX_STREAM_BYTES) throw new Error(`Claude stream exceeds ${MAX_STREAM_BYTES}-byte quota`);
  let terminal = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "result") continue;
    if (event.session_id !== expectedSessionId) throw new Error("Claude result session identity mismatch");
    terminal = event;
  }
  if (!terminal) throw new Error("Claude stream is missing a terminal result event");
  return terminal;
}

function parseReport(text) {
  if (typeof text !== "string") throw new Error("Claude terminal result is not text");
  const escapedMarker = BRIDGE_RESULT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = new RegExp(`^${escapedMarker}[ \\t]*\\r?$`, "gm");
  let marker = null;
  for (const match of text.matchAll(markerPattern)) marker = match;
  if (!marker) throw new Error(`Claude result is missing ${BRIDGE_RESULT_MARKER} marker on its own line`);
  let encoded = text.slice(marker.index + marker[0].length).trim();
  if (encoded.startsWith("```")) {
    encoded = encoded.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }
  if (Buffer.byteLength(encoded) > MAX_REPORT_BYTES) throw new Error("Claude structured result exceeds report quota");
  let report;
  try {
    report = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`Claude structured result is invalid JSON: ${error.message}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Claude structured result must be an object");
  const allowed = new Set(["summary", "filesChanged", "commandsRun", "testsRun", "findings", "blockers"]);
  const extra = Object.keys(report).find((key) => !allowed.has(key));
  if (extra) throw new Error(`Claude structured result contains unknown field ${extra}`);
  if (typeof report.summary !== "string") throw new Error("summary must be a string");
  return {
    summary: redactText(report.summary),
    filesChanged: requireReportArray(report, "filesChanged").map(redactText),
    commandsRun: requireReportArray(report, "commandsRun"),
    testsRun: requireReportArray(report, "testsRun"),
    findings: requireReportArray(report, "findings"),
    blockers: requireReportArray(report, "blockers")
  };
}

function normalizeArtifactPaths(values) {
  if (!Array.isArray(values)) throw new Error("artifactPaths must be an array");
  return [...new Set(values.map((value) => {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("artifact paths must be absolute");
    return path.resolve(value);
  }))];
}

function failureReport(error) {
  const detail = redactText(error?.message ?? error).slice(0, 2_000);
  return {
    summary: "Claude worker returned an invalid structured result.",
    filesChanged: [], commandsRun: [], testsRun: [], findings: [],
    blockers: [{ title: "Invalid worker result", detail }]
  };
}

export function normalizeClaudeWorkerResult({ request, stdout, exit, artifactPaths }) {
  validateBridgeRequestContract(request);
  let terminal;
  let report;
  try {
    terminal = parseStream(stdout, request.execution.claudeSessionId);
    report = parseReport(terminal.result);
  } catch (error) {
    if (/session identity mismatch/i.test(error.message) || /quota/i.test(error.message)) throw error;
    report = failureReport(error);
  }
  const cancelled = exit?.cancelled === true;
  const failedExit = exit?.code !== 0 || exit?.error || terminal?.is_error === true || terminal?.subtype === "error";
  const structurallyFailed = report.summary === "Claude worker returned an invalid structured result.";
  const status = cancelled ? "cancelled" : (failedExit || structurallyFailed ? "failed" : "completed");
  if (failedExit && !cancelled) {
    report.blockers.push({
      title: "Claude worker exit failure",
      detail: redactText(exit?.error || `Claude exited with code ${String(exit?.code)} and signal ${String(exit?.signal)}`).slice(0, 2_000)
    });
  }
  const result = {
    schemaVersion: 1,
    jobId: request.jobId,
    status,
    ...report,
    claudeSessionId: request.execution.claudeSessionId,
    exitStatus: {
      code: Number.isInteger(exit?.code) ? exit.code : null,
      signal: typeof exit?.signal === "string" ? exit.signal : null
    },
    artifactPaths: normalizeArtifactPaths(artifactPaths)
  };
  validateBridgeResultContract(result);
  return Object.freeze(result);
}
