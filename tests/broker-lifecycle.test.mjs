import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureBrokerSession,
  inspectBrokerProcessIdentity,
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

  assert.deepEqual(exact, { alive: true, exact: true });
  assert.deepEqual(reused, { alive: true, exact: false });
});

test("stale broker cleanup never kills a live PID whose identity does not match", async () => {
  const { cwd, existing } = fixture();
  saveBrokerSession(cwd, existing);
  const killed = [];

  const session = await ensureBrokerSession(cwd, {
    inspectProcess: () => ({ alive: true, exact: false }),
    killProcess: (pid) => killed.push(pid),
    createBrokerEndpoint: (sessionDir) => `unix:${path.join(sessionDir, "new.sock")}`,
    spawnBrokerProcess: () => ({ pid: 515151 }),
    waitForBrokerEndpoint: async () => true,
    identityToken: "c".repeat(64)
  });

  assert.deepEqual(killed, []);
  assert.equal(session.pid, 515151);
  assert.equal(session.identityToken, "c".repeat(64));
});

test("stale broker cleanup terminates an exact persisted broker identity", async () => {
  const { cwd, existing } = fixture();
  saveBrokerSession(cwd, existing);
  const killed = [];

  await ensureBrokerSession(cwd, {
    inspectProcess: () => ({ alive: true, exact: true }),
    killProcess: (pid) => killed.push(pid),
    createBrokerEndpoint: (sessionDir) => `unix:${path.join(sessionDir, "new.sock")}`,
    spawnBrokerProcess: () => ({ pid: 616161 }),
    waitForBrokerEndpoint: async () => true,
    identityToken: "d".repeat(64)
  });

  assert.deepEqual(killed, [existing.pid]);
});
