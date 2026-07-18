import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { clearBrokerSession, saveBrokerSession, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  assertBrokerCleanupComplete,
  cleanupLeakedBrokers,
  makeTempDir,
  run,
  waitForTerminatedProcessTrees
} from "./helpers.mjs";

test("test teardown rejects any live broker whose identity could not be verified", () => {
  assert.throws(
    () => assertBrokerCleanupComplete({ skippedIdentityMismatch: 1 }),
    /could not verify 1 live broker process identity/
  );
});

function withPluginDataDir(pluginDataDir, callback) {
  const previousValue = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    return callback();
  } finally {
    if (previousValue === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousValue;
  }
}

function brokerFixture(sessionDir, pid) {
  return {
    endpoint: `unix:${path.join(sessionDir, "broker.sock")}`,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid
  };
}

test("test broker cleanup reaps only an exact process identity from an observed run", () => {
  const cwd = makeTempDir();
  const pluginDataDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-helper-cleanup-");
  const session = brokerFixture(sessionDir, 424242);
  fs.writeFileSync(session.pidFile, `${session.pid}\n`);
  fs.writeFileSync(session.logFile, "fixture\n");
  fs.writeFileSync(path.join(sessionDir, "broker.sock"), "fixture\n");
  run(process.execPath, ["-e", "process.exit(0)"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir }
  });
  withPluginDataDir(pluginDataDir, () => saveBrokerSession(cwd, session));

  const killed = [];
  const receipt = cleanupLeakedBrokers({
    inspectProcess: () => ({ alive: true, exact: true }),
    killProcess: (pid) => { killed.push(pid); }
  });

  assert.deepEqual(killed, [session.pid]);
  assert.deepEqual(receipt.terminatedPids, [session.pid]);
  assert.equal(receipt.cleaned, 1);
  assert.equal(receipt.skippedIdentityMismatch, 0);
  assert.equal(fs.existsSync(sessionDir), false);
  assert.equal(withPluginDataDir(pluginDataDir, () => loadBrokerSession(cwd)), null);
});

test("test broker cleanup leaves unrelated live identities and unobserved state untouched", () => {
  const observedCwd = makeTempDir();
  const observedPluginData = makeTempDir();
  const observedSessionDir = makeTempDir("cxc-helper-mismatch-");
  const observedSession = brokerFixture(observedSessionDir, 434343);
  run(process.execPath, ["-e", "process.exit(0)"], {
    cwd: observedCwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: observedPluginData }
  });
  withPluginDataDir(observedPluginData, () => saveBrokerSession(observedCwd, observedSession));

  const unobservedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "unobserved-cwd-"));
  const unobservedPluginData = fs.mkdtempSync(path.join(os.tmpdir(), "unobserved-plugin-data-"));
  const unobservedSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-unobserved-"));
  const unobservedSession = brokerFixture(unobservedSessionDir, 444444);
  run(process.execPath, ["-e", "process.exit(0)"], {
    cwd: unobservedCwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: unobservedPluginData }
  });
  withPluginDataDir(unobservedPluginData, () => saveBrokerSession(unobservedCwd, unobservedSession));

  const killed = [];
  const receipt = cleanupLeakedBrokers({
    inspectProcess: () => ({ alive: true, exact: false }),
    killProcess: (pid) => { killed.push(pid); }
  });

  assert.deepEqual(killed, []);
  assert.deepEqual(receipt.terminatedPids, []);
  assert.equal(receipt.skippedIdentityMismatch, 1);
  assert.deepEqual(withPluginDataDir(observedPluginData, () => loadBrokerSession(observedCwd)), observedSession);
  assert.deepEqual(withPluginDataDir(unobservedPluginData, () => loadBrokerSession(unobservedCwd)), unobservedSession);
  withPluginDataDir(observedPluginData, () => clearBrokerSession(observedCwd));
  withPluginDataDir(unobservedPluginData, () => clearBrokerSession(unobservedCwd));
  fs.rmSync(unobservedCwd, { recursive: true, force: true });
  fs.rmSync(unobservedPluginData, { recursive: true, force: true });
  fs.rmSync(unobservedSessionDir, { recursive: true, force: true });
});

test("test broker cleanup fails closed on process inspection failure and substring impostors", () => {
  const cwd = makeTempDir();
  const pluginDataDir = makeTempDir();
  const sessionDir = makeTempDir("cxc-helper-fail-closed-");
  const session = brokerFixture(sessionDir, 454545);
  run(process.execPath, ["-e", "process.exit(0)"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir }
  });
  withPluginDataDir(pluginDataDir, () => saveBrokerSession(cwd, session));

  const killed = [];
  const inspectionFailure = cleanupLeakedBrokers({
    processAlive: () => true,
    listProcess: () => ({ status: 1, stdout: "", stderr: "ps unavailable" }),
    killProcess: (pid) => { killed.push(pid); }
  });
  assert.deepEqual(killed, []);
  assert.equal(inspectionFailure.skippedIdentityMismatch, 1);
  assert.deepEqual(withPluginDataDir(pluginDataDir, () => loadBrokerSession(cwd)), session);

  const brokerScript = path.resolve("plugins/codex/scripts/app-server-broker.mjs");
  const expected = `${process.execPath} ${brokerScript} serve --endpoint ${session.endpoint} --cwd ${fs.realpathSync.native(cwd)} --pid-file ${session.pidFile}`;
  const substringImpostor = cleanupLeakedBrokers({
    processAlive: () => true,
    listProcess: () => ({ status: 0, stdout: `${expected} --extra\n`, stderr: "" }),
    killProcess: (pid) => { killed.push(pid); }
  });
  assert.deepEqual(killed, []);
  assert.equal(substringImpostor.skippedIdentityMismatch, 1);
  assert.deepEqual(withPluginDataDir(pluginDataDir, () => loadBrokerSession(cwd)), session);
});

test("test broker cleanup wait does not return while a terminated process group is still alive", async () => {
  const observations = [true, true, false];
  let sleeps = 0;

  const receipt = await waitForTerminatedProcessTrees([515151], {
    timeoutMs: 1000,
    intervalMs: 1,
    processTreeAlive: () => observations.shift() ?? false,
    sleep: async () => { sleeps += 1; }
  });

  assert.deepEqual(receipt, { reaped: 1 });
  assert.equal(sleeps, 2);
});
