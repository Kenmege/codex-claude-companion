import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
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

// Drop the parent runner's NODE_TEST_CONTEXT: with it, the nested `node --test` treats itself as a
// recursive call and skips every file, which is not what `npm test` sees.
function runnerEnv(report, overrides = {}) {
  const { NODE_TEST_CONTEXT: _parentContext, ...env } = process.env;
  return { ...env, RUN_TESTS_REPORT: report, ...overrides };
}

function run(args, { cwd, report, env = {} }) {
  return spawnSync(process.execPath, [runner, ...args], { cwd, encoding: "utf8", env: runnerEnv(report, env) });
}

async function waitFor(condition, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

test("run-tests exports an absolute temporary root when TMPDIR is relative", (t) => {
  const { directory, report } = probeSuite(t);
  fs.mkdirSync(path.join(directory, "relative-tmp"));
  const result = run([path.join(directory, "probe.test.mjs")], {
    cwd: directory,
    report,
    env: { TMPDIR: "relative-tmp", TMP: "relative-tmp", TEMP: "relative-tmp" }
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const temporaryRoot = fs.readFileSync(report, "utf8");
  assert.ok(path.isAbsolute(temporaryRoot), `temporary root must be absolute: ${temporaryRoot}`);
  assert.equal(path.dirname(temporaryRoot), path.join(fs.realpathSync(directory), "relative-tmp"));
  assert.equal(fs.existsSync(temporaryRoot), false, "the per-run temporary root must be removed");
});

test("run-tests fails a passing run when it cannot remove the private temporary root", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions and a non-root user" : false
}, (t) => {
  const { directory, report } = probeSuite(t, `
  const locked = path.join(os.tmpdir(), "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "file"), "x");
  fs.chmodSync(locked, 0o500);`);
  const result = run([path.join(directory, "probe.test.mjs")], { cwd: directory, report });
  const temporaryRoot = fs.readFileSync(report, "utf8");
  t.after(() => {
    fs.chmodSync(path.join(temporaryRoot, "locked"), 0o700);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  assert.match(result.stdout, /# pass 1/);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /could not remove temporary root/);
});

test("run-tests forwards SIGTERM, ends the suite, removes the root, and does not report success", {
  skip: process.platform === "win32" ? "POSIX signals" : false
}, async (t) => {
  const { directory, report } = probeSuite(t, `
  fs.writeFileSync(process.env.RUN_TESTS_REPORT + ".pid", String(process.pid));
  setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [runner, path.join(directory, "probe.test.mjs")], {
    cwd: directory,
    env: runnerEnv(report),
    stdio: "ignore"
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });

  await waitFor(() => fs.existsSync(`${report}.pid`), "the probe to start");
  const temporaryRoot = fs.readFileSync(report, "utf8");
  const probePid = Number(fs.readFileSync(`${report}.pid`, "utf8"));
  child.kill("SIGTERM");
  const { code, signal } = await exited;

  assert.ok(signal === "SIGTERM" || (code !== null && code !== 0), `interrupted run reported code ${code}, signal ${signal}`);
  assert.equal(fs.existsSync(temporaryRoot), false, "the per-run temporary root must be removed");
  await waitFor(() => !isAlive(probePid), "the interrupted suite's test process to exit");
});
