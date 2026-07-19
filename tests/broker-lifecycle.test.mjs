import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureBrokerSession,
  inspectBrokerProcessIdentity,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "broker-lifecycle-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-session-"));
  return {
    cwd,
    existing: {
      endpoint: `unix:${path.join(sessionDir, "missing.sock")}`,
      pidFile: path.join(sessionDir, "broker.pid"),
      logFile: path.join(sessionDir, "broker.log"),
      sessionDir,
      pid: 424242,
      identityToken: "a".repeat(64)
    }
  };
}

test("Windows broker identity requires the exact persisted launch token", () => {
  const session = { pid: 1234, identityToken: "b".repeat(64) };
  const command = `node.exe app-server-broker.mjs serve --identity-token ${session.identityToken}`;
  const exact = inspectBrokerProcessIdentity(session, "C:\\workspace", {
    platform: "win32",
    processAlive: () => true,
    listProcess: () => ({ status: 0, stdout: `${command}\n` })
  });
  const reused = inspectBrokerProcessIdentity(session, "C:\\workspace", {
    platform: "win32",
    processAlive: () => true,
    listProcess: () => ({ status: 0, stdout: "node.exe unrelated-script.mjs\n" })
  });

  assert.deepEqual(exact, { alive: true, exact: true, conclusive: true });
  assert.deepEqual(reused, { alive: true, exact: false, conclusive: true });
});

test("broker process inspection always applies a bounded process-list timeout", () => {
  const session = { pid: 1234, identityToken: "e".repeat(64) };
  let observedOptions;
  const identity = inspectBrokerProcessIdentity(session, "/tmp/workspace", {
    platform: "linux",
    processAlive: () => true,
    processInspectionTimeoutMs: 321,
    listProcess: (_command, _argv, options) => {
      observedOptions = options;
      return { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
    }
  });

  assert.equal(observedOptions.timeout, 321);
  assert.deepEqual(identity, { alive: true, exact: false, conclusive: false });
});

test("empty successful process inspection is inconclusive", () => {
  const identityToken = "a".repeat(64);
  assert.deepEqual(inspectBrokerProcessIdentity({ pid: 123, identityToken }, process.cwd(), {
    processAlive: () => true,
    listProcess: () => ({ status: 0, stdout: "\n" })
  }), { alive: true, exact: false, conclusive: false });
});

test("broker identity token matching requires an exact command argument", () => {
  const identityToken = "a".repeat(64);
  assert.deepEqual(inspectBrokerProcessIdentity({ pid: 123, identityToken }, process.cwd(), {
    processAlive: () => true,
    listProcess: () => ({ status: 0, stdout: `node broker --identity-token ${identityToken}b` })
  }), { alive: true, exact: false, conclusive: true });
});

test("connectable broker endpoint is rejected without exact process identity verification", async () => {
  const { cwd, existing } = fixture();
  saveBrokerSession(cwd, existing);
  let spawns = 0;

  await assert.rejects(
    () => ensureBrokerSession(cwd, {
      inspectProcess: () => ({ alive: true, exact: false, conclusive: true }),
      waitForBrokerEndpoint: async () => true,
      createBrokerEndpoint: (sessionDir) => `unix:${path.join(sessionDir, "new.sock")}`,
      spawnBrokerProcess: () => { spawns += 1; return { pid: 717171 }; },
      identityToken: "f".repeat(64)
    }),
    /persisted process identity is not an exact match/
  );

  assert.equal(spawns, 0);
  assert.deepEqual(loadBrokerSession(cwd), existing);
});

test("stale broker cleanup preserves a live PID whose identity does not match", async () => {
  const { cwd, existing } = fixture();
  saveBrokerSession(cwd, existing);
  const killed = [];

  let spawns = 0;
  await assert.rejects(
    () => ensureBrokerSession(cwd, {
      inspectProcess: () => ({ alive: true, exact: false, conclusive: true }),
      killProcess: (pid) => killed.push(pid),
      createBrokerEndpoint: (sessionDir) => `unix:${path.join(sessionDir, "new.sock")}`,
      spawnBrokerProcess: () => { spawns += 1; return { pid: 515151 }; },
      waitForBrokerEndpoint: async () => true,
      identityToken: "c".repeat(64)
    }),
    /persisted process identity is not an exact match/
  );

  assert.deepEqual(killed, []);
  assert.equal(spawns, 0);
  assert.deepEqual(loadBrokerSession(cwd), existing);
});

test("stale broker cleanup terminates an exact persisted broker identity", async () => {
  const { cwd, existing } = fixture();
  saveBrokerSession(cwd, existing);
  const killed = [];

  await ensureBrokerSession(cwd, {
    inspectProcess: () => ({ alive: true, exact: true, conclusive: true }),
    killProcess: (pid) => killed.push(pid),
    createBrokerEndpoint: (sessionDir) => `unix:${path.join(sessionDir, "new.sock")}`,
    spawnBrokerProcess: () => ({ pid: 616161 }),
    waitForBrokerEndpoint: async (endpoint) => endpoint !== existing.endpoint,
    identityToken: "d".repeat(64)
  });

  assert.deepEqual(killed, [existing.pid]);
});

test("inconclusive inspection preserves a live persisted broker instead of orphaning it", async () => {
  const { cwd, existing } = fixture();
  fs.writeFileSync(existing.pidFile, `${existing.pid}\n`);
  fs.writeFileSync(existing.logFile, "broker log\n");
  saveBrokerSession(cwd, existing);
  const killed = [];
  let spawns = 0;

  await assert.rejects(
    () => ensureBrokerSession(cwd, {
      inspectProcess: () => ({ alive: true, exact: false, conclusive: false }),
      killProcess: (pid) => killed.push(pid),
      spawnBrokerProcess: () => { spawns += 1; return { pid: 818181 }; },
      waitForBrokerEndpoint: async () => true
    }),
    /Cannot safely replace live broker PID 424242/
  );

  assert.deepEqual(killed, []);
  assert.equal(spawns, 0);
  assert.deepEqual(loadBrokerSession(cwd), existing);
  assert.equal(fs.existsSync(existing.pidFile), true);
  assert.equal(fs.existsSync(existing.logFile), true);
  assert.equal(fs.existsSync(existing.sessionDir), true);
});
