import fs from "node:fs";
import path from "node:path";
import { tap } from "node:test/reporters";

const metrics = ["Line", "Branch", "Function"];

// Use Node's merged V8 results, including inherited child-process collection.
// Never average percentages or treat the tests' own coverage as product coverage.
export function sourceCoverage(summary) {
  const root = fs.realpathSync(summary.workingDirectory);
  const observed = new Map(summary.files.map((file) => [path.resolve(file.path), file]));
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !["test", "tests", "fixtures", "node_modules"].includes(entry.name)) visit(absolute);
      else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        const measured = observed.get(absolute);
        files.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          measured: Boolean(measured),
          totalLineCount: measured?.totalLineCount ?? fs.readFileSync(absolute, "utf8").split(/(?<=\n)/).length,
          coveredLineCount: measured?.coveredLineCount ?? 0,
          totalBranchCount: measured?.totalBranchCount ?? 0,
          coveredBranchCount: measured?.coveredBranchCount ?? 0,
          totalFunctionCount: measured?.totalFunctionCount ?? 0,
          coveredFunctionCount: measured?.coveredFunctionCount ?? 0
        });
      }
    }
  }
  for (const directory of ["scripts", "plugins/codex/scripts"]) {
    const absolute = path.join(root, directory);
    if (fs.existsSync(absolute)) visit(absolute);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) throw new Error("coverage: no source files found");
  if (!files.some((file) => file.measured)) throw new Error("coverage: no source coverage collected");
  const totals = {};
  for (const metric of metrics) {
    for (const prefix of ["total", "covered"]) {
      const key = `${prefix}${metric}Count`;
      totals[key] = files.reduce((sum, file) => sum + file[key], 0);
    }
  }
  return { files, totals };
}

function percentage(file, metric) {
  if (file.measured === false && metric !== "Line") return "n/a";
  const total = file[`total${metric}Count`];
  return (total === 0 ? 100 : 100 * file[`covered${metric}Count`] / total).toFixed(2);
}

export function coverageMarkdown(report) {
  const row = (name, file) => `| ${name} | ${metrics.map((metric) => percentage(file, metric)).join(" | ")} |`;
  return [
    "## Source coverage",
    "",
    "Node built-in V8 coverage; merged across test and child processes. No threshold gate.",
    "Scope: JavaScript in scripts/ and plugins/codex/scripts/ (including maintenance tools); tests, fixtures, dependencies and temporary copies excluded.",
    "",
    "| File | Line % | Branch % | Function % |",
    "| --- | ---: | ---: | ---: |",
    ...report.files.map((file) => row(file.path, file)),
    row("**All source files**", report.totals),
    "",
    "Counts (covered/total): " + metrics.map((metric) => `${metric.toLowerCase()} ${report.totals[`covered${metric}Count`]}/${report.totals[`total${metric}Count`]}`).join(", ") + ".",
    "Unobserved files count as zero covered lines; their branch/function counts are unknown (n/a), so those totals describe observed V8 ranges only. V8 may omit dynamically created functions that never ran; these are execution-range metrics, not static syntax counts.",
    "",
    "Five least-covered source files (by line coverage):",
    ...[...report.files].sort((a, b) => Number(percentage(a, "Line")) - Number(percentage(b, "Line")) || a.path.localeCompare(b.path)).slice(0, 5)
      .map((file) => `- ${file.path}: ${percentage(file, "Line")}% lines, ${percentage(file, "Branch")}% branches, ${percentage(file, "Function")}% functions`),
    ""
  ].join("\n");
}

export default async function* coverageReporter(source) {
  let markdown;
  async function* testEvents() {
    for await (const event of source) {
      if (event.type === "test:coverage") {
        markdown = coverageMarkdown(sourceCoverage(event.data.summary));
      } else {
        yield event;
      }
    }
  }
  yield* tap(testEvents());
  if (!markdown) {
    // Node 18 exits non-zero on a reporter error but does not print it; say why explicitly.
    process.stderr.write("coverage: missing test:coverage event (run with --experimental-test-coverage)\n");
    throw new Error("coverage: missing test:coverage event");
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  yield markdown;
}
