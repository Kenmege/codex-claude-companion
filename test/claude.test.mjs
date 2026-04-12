import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_SETUP_PROBE_TIMEOUT_ENV,
  CLAUDE_SETTING_SOURCES,
  DEFAULT_CLAUDE_SETUP_PROBE_TIMEOUT_MS,
  getClaudeSetupProbeTimeoutMs,
  parseClaudeStructuredOutput,
  probeClaudeStructuredOutput,
  runClaudeStructuredReview
} from "../scripts/lib/claude.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REVIEW_SCHEMA_PATH = path.join(ROOT, "schemas", "review-output.schema.json");

function withFakeClaude(handler) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-bin-"));
  const argsFile = path.join(binDir, "claude-args.txt");
  const scriptPath = path.join(binDir, "claude");
  const script = `#!/bin/sh
printf '%s\n' "$@" > "$CLAUDE_ARGS_FILE"
cat <<'EOF'
${handler}
EOF
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.CLAUDE_ARGS_FILE;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  process.env.CLAUDE_ARGS_FILE = argsFile;

  return {
    argsFile,
    restore() {
      process.env.PATH = previousPath;
      if (previousArgsFile === undefined) {
        delete process.env.CLAUDE_ARGS_FILE;
      } else {
        process.env.CLAUDE_ARGS_FILE = previousArgsFile;
      }
    }
  };
}

function readArgs(argsFile) {
  return fs.readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean);
}

test("parseClaudeStructuredOutput reads the structured result payload", () => {
  const parsed = parseClaudeStructuredOutput(
    [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { answer: "fallback" } }] } }),
      JSON.stringify({ type: "result", structured_output: { answer: "OK" } })
    ].join("\n")
  );

  assert.deepEqual(parsed, { answer: "OK" });
});

test("getClaudeSetupProbeTimeoutMs accepts a positive integer override", () => {
  assert.equal(
    getClaudeSetupProbeTimeoutMs({
      [CLAUDE_SETUP_PROBE_TIMEOUT_ENV]: "90000"
    }),
    90000
  );
});

test("getClaudeSetupProbeTimeoutMs falls back on invalid override values", () => {
  assert.equal(
    getClaudeSetupProbeTimeoutMs({
      [CLAUDE_SETUP_PROBE_TIMEOUT_ENV]: "not-a-number"
    }),
    DEFAULT_CLAUDE_SETUP_PROBE_TIMEOUT_MS
  );
  assert.equal(
    getClaudeSetupProbeTimeoutMs({
      [CLAUDE_SETUP_PROBE_TIMEOUT_ENV]: "0"
    }),
    DEFAULT_CLAUDE_SETUP_PROBE_TIMEOUT_MS
  );
});

test("probeClaudeStructuredOutput verifies the non-interactive runtime with clean setting sources", () => {
  const fake = withFakeClaude(JSON.stringify({ type: "result", structured_output: { answer: "OK" } }));

  try {
    const report = probeClaudeStructuredOutput(ROOT);
    const args = readArgs(fake.argsFile);

    assert.equal(report.ready, true);
    assert.match(report.detail, new RegExp(CLAUDE_SETTING_SOURCES.replace(",", "\\,")));
    assert.deepEqual(args.slice(0, 6), [
      "-p",
      "Return structured output with answer set to OK.",
      "--setting-sources",
      CLAUDE_SETTING_SOURCES,
      "--output-format",
      "stream-json"
    ]);
  } finally {
    fake.restore();
  }
});

test("runClaudeStructuredReview parses stream-json structured output", () => {
  const fake = withFakeClaude(
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "StructuredOutput",
              input: {
                verdict: "request changes",
                summary: "Guard the empty array case.",
                findings: [
                  {
                    severity: "high",
                    title: "Missing empty-state guard",
                    body: "items[0] will throw when the input is empty.",
                    file: "app.js",
                    line_start: 2,
                    line_end: 2,
                    recommendation: "Return early when the array is empty."
                  }
                ],
                next_steps: ["Add a guard clause before indexing the array."]
              }
            }
          ]
        }
      }),
      JSON.stringify({
        type: "result",
        structured_output: {
          verdict: "request changes",
          summary: "Guard the empty array case.",
          findings: [
            {
              severity: "high",
              title: "Missing empty-state guard",
              body: "items[0] will throw when the input is empty.",
              file: "app.js",
              line_start: 2,
              line_end: 2,
              recommendation: "Return early when the array is empty."
            }
          ],
          next_steps: ["Add a guard clause before indexing the array."]
        }
      })
    ].join("\n")
  );

  try {
    const result = runClaudeStructuredReview(
      ROOT,
      {
        targetLabel: "working tree diff",
        focusText: "",
        contextText: "diff --git a/app.js b/app.js",
        model: "claude-opus-4-6",
        effort: "high",
        betas: []
      },
      "review",
      REVIEW_SCHEMA_PATH
    );
    const args = readArgs(fake.argsFile);

    assert.equal(result.parsed.verdict, "request changes");
    assert.equal(result.parsed.findings[0].title, "Missing empty-state guard");
    assert.ok(args.includes("--json-schema"));
    assert.ok(args.includes("--disable-slash-commands"));
    assert.ok(args.includes("stream-json"));
  } finally {
    fake.restore();
  }
});
