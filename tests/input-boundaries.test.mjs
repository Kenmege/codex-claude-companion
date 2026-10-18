import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";
import { renderCancelReport, renderJobStatusReport, renderStatusReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("Codex inline option values preserve additional equals signs", () => {
  assert.equal(parseArgs(["--prompt=="], { valueOptions: ["prompt"] }).options.prompt, "=");
});

test("Codex table cells escape existing backslashes before pipes and flatten line separators", () => {
  const output = renderStatusReport({ sessionRuntime: { label: "test" }, config: {}, recent: [], running: [
    { id: "job-safe", status: "running", summary: "\\|x\ry\u2028z\u2029w" }
  ] });
  const row = output.split("\n").find(line => line.startsWith("| job-safe"));
  assert.equal(row, "| job-safe |  | running |  |  |  | \\\\\\|x y z w | `/codex:status job-safe`<br>`/codex:cancel job-safe` |");
});

test("Codex renderers display a non-string stored summary without throwing", () => {
  // Job records are read from disk; a parseable record may carry any JSON value here.
  const job = JSON.parse('{"id":"job-odd","status":"completed","summary":{"toString":null}}');
  const outputs = [
    renderStatusReport({ sessionRuntime: { label: "test" }, config: {}, recent: [], running: [{ ...job, status: "running" }] }),
    renderJobStatusReport(job),
    renderStoredJobResult(job, {}),
    renderCancelReport(job)
  ];
  for (const output of outputs) {
    assert.match(output, /\{"toString":null\}/);
  }
});
