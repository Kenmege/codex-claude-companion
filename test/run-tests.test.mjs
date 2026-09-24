import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

// A probe suite that leaves a temporary directory behind on purpose and reports the temp root it saw.
function probeSuite(t, extraAssertion = "") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "probe.test.mjs"), `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("probe", () => {
  fs.mkdtempSync(path.join(os.tmpdir(), "left-behind-"));
  fs.writeFileSync(process.env.RUN_TESTS_REPORT, os.tmpdir());
  ${extraAssertion}
});
`);
  return { directory, report: path.join(directory, "report.txt") };
}

function run(args, { cwd, report }) {
  // Drop the parent runner's NODE_TEST_CONTEXT: with it, the nested `node --test` treats itself as a
  // recursive call and skips every file, which is not what `npm test` sees.
  const { NODE_TEST_CONTEXT: _parentContext, ...env } = process.env;
  return spawnSync(process.execPath, [runner, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, RUN_TESTS_REPORT: report }
  });
}

test("run-tests lets node --test discover the suite and removes the private temporary root", (t) => {
  const { directory, report } = probeSuite(t);
  const result = run([], { cwd: directory, report });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const temporaryRoot = fs.readFileSync(report, "utf8");
  assert.equal(path.dirname(temporaryRoot), os.tmpdir());
  assert.match(path.basename(temporaryRoot), /^cct-/);
  assert.equal(fs.existsSync(temporaryRoot), false, "the per-run temporary root must be removed");
});

test("run-tests propagates a failing suite and still removes the private temporary root", (t) => {
  const { directory, report } = probeSuite(t, 'throw new Error("expected probe failure");');
  const result = run([path.join(directory, "probe.test.mjs")], { cwd: directory, report });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /expected probe failure/);
  const temporaryRoot = fs.readFileSync(report, "utf8");
  assert.equal(fs.existsSync(temporaryRoot), false, "the per-run temporary root must be removed");
});
