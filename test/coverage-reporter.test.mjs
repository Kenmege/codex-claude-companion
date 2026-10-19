import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coverageMarkdown, sourceCoverage } from "../scripts/dev/coverage-reporter.mjs";

const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
const reporter = fileURLToPath(new URL("../scripts/dev/coverage-reporter.mjs", import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coverage-fixture-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "plugins/codex/scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "scripts/child.mjs"), 'function choose(x) {\n  if (x) return "yes";\n  return "no";\n}\nchoose(process.argv[2]);\n');
  fs.writeFileSync(path.join(root, "plugins/codex/scripts/unobserved.mjs"), 'export function unused() {\n  return 42;\n}\n');
  fs.mkdirSync(path.join(root, "scripts/fixtures"));
  fs.writeFileSync(path.join(root, "scripts/fixtures/fake.mjs"), "throw 42;\n");
  fs.writeFileSync(path.join(root, "scripts/inside.test.mjs"), "// excluded test\n");
  return root;
}

test("coverage scope excludes tests and external copies, includes unobserved files and weights totals", (t) => {
  const root = fixture(t);
  const measured = {
    path: path.join(root, "scripts/child.mjs"), totalLineCount: 5, coveredLineCount: 4,
    totalBranchCount: 3, coveredBranchCount: 2, totalFunctionCount: 1, coveredFunctionCount: 1
  };
  const report = sourceCoverage({ workingDirectory: root, files: [measured,
    { ...measured, path: path.join(root, "test/probe.test.mjs"), coveredLineCount: 5 },
    { ...measured, path: path.join(root, "temporary/scripts/child.mjs"), coveredLineCount: 5 }
  ] });
  assert.equal(report.files.length, 2);
  assert.equal(report.totals.totalLineCount, 8);
  assert.equal(report.totals.coveredLineCount, 4);
  const markdown = coverageMarkdown(report);
  assert.match(markdown, /\*\*All source files\*\* \| 50\.00 \| 66\.67 \| 100\.00/);
  assert.match(markdown, /unobserved\.mjs \| 0\.00 \| n\/a \| n\/a/);
  assert.doesNotMatch(markdown, /probe\.test|temporary\/scripts/);
  assert.throws(() => sourceCoverage({ workingDirectory: root, files: [] }), /no source coverage collected/);
});

for (const fails of [false, true]) {
  test(`coverage CLI merges child-only execution, writes CI summary and preserves ${fails ? "failure" : "success"}`, (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, "test/probe.test.mjs"), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('child-only', () => {
  execFileSync(process.execPath, ['scripts/child.mjs']);
  execFileSync(process.execPath, ['scripts/child.mjs', 'yes']);
  ${fails ? "assert.fail('intentional coverage probe failure');" : "assert.ok(true);"}
});
`);
    const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _coverage, ...env } = process.env;
    const summary = path.join(root, "summary.md");
    const result = spawnSync(process.execPath, [runner, "--experimental-test-coverage", `--test-reporter=${reporter}`], {
      cwd: root, env: { ...env, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8", timeout: 30_000
    });
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    const markdown = fs.readFileSync(summary, "utf8");
    assert.ok(result.stdout.includes(markdown.trim()));
    assert.match(markdown, /scripts\/child\.mjs \| 100\.00 \| 100\.00 \| 100\.00/);
    assert.match(markdown, /unobserved\.mjs \| 0\.00 \| n\/a \| n\/a/);
    assert.doesNotMatch(markdown, /probe\.test\.mjs/);
    assert.match(result.stdout, /# tests 2/);
    assert.match(result.stdout, fails ? /# fail 1/ : /# pass 2/);
  });
}

test("coverage CLI fails when no coverage event arrives", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "test/probe.test.mjs"), "import test from 'node:test';\ntest('ok', () => {});\n");
  const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _coverage, ...env } = process.env;
  // Without --experimental-test-coverage Node emits no test:coverage event; the reporter must not report success.
  const result = spawnSync(process.execPath, [runner, `--test-reporter=${reporter}`], {
    cwd: root, env, encoding: "utf8", timeout: 30_000
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /coverage: missing test:coverage event/);
});
