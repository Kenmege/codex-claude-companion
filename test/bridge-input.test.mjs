import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  bridgeInputPaths,
  commitBridgeInput,
  discardStagedBridgeInput,
  initializeBridgeInput,
  listPendingBridgeInput,
  readBridgeInputAck,
  recoverAuthorizedBridgeInput,
  stageBridgeInput,
  writeBridgeInputAck
} from "../scripts/lib/bridge-input.mjs";

const JOB_ID = "ccb_00000000000000000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-input-"));
  const jobDir = path.join(root, "jobs", JOB_ID);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  return { root, jobDir };
}

function authorization(message, contentSha256 = message.contentSha256) {
  return [{
    schemaVersion: 1,
    jobId: message.jobId,
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: "codex_message",
    sender: "codex",
    deduplicationKey: `codex-message:${message.messageId}`,
    payload: { messageId: message.messageId, text: message.content, contentSha256 }
  }];
}

function acknowledgement(overrides = {}) {
  return {
    claudeSessionId: SESSION_ID,
    observedEventType: "user",
    observedAt: "2026-07-19T12:00:00.000Z",
    ...overrides
  };
}

function queuedMessage(jobDir, content = "acknowledged continuation") {
  const message = stageBridgeInput(jobDir, JOB_ID, content);
  commitBridgeInput(jobDir, message);
  return message;
}

test("staged input is inert and no-clobber publication is idempotent", () => {
  const { jobDir } = fixture();
  const message = stageBridgeInput(jobDir, JOB_ID, "authorized continuation");

  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID), []);
  commitBridgeInput(jobDir, message);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID, { authorizedEvents: [] }), []);
  assert.deepEqual(
    listPendingBridgeInput(jobDir, JOB_ID, { authorizedEvents: authorization(message) })
      .map((entry) => entry.messageId),
    [message.messageId]
  );

  assert.doesNotThrow(() => commitBridgeInput(jobDir, message));
  assert.equal(discardStagedBridgeInput(jobDir, message), false);
  assert.equal(listPendingBridgeInput(jobDir, JOB_ID).length, 1);
});

test("aborting staged input never publishes or removes committed input", () => {
  const { jobDir } = fixture();
  const aborted = stageBridgeInput(jobDir, JOB_ID, "rejected continuation");
  assert.equal(discardStagedBridgeInput(jobDir, aborted), true);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID), []);

  const committed = stageBridgeInput(jobDir, JOB_ID, "committed continuation");
  commitBridgeInput(jobDir, committed);
  assert.equal(discardStagedBridgeInput(jobDir, committed), false);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID).map((entry) => entry.messageId), [committed.messageId]);
});

test("recovery promotes only an exact journal-authorized staged hash once", () => {
  const { jobDir } = fixture();
  const message = stageBridgeInput(jobDir, JOB_ID, "recoverable continuation");

  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, []), []);
  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, authorization(message, "0".repeat(64))), []);
  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, authorization(message)), [message.messageId]);
  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, authorization(message)), []);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID).map((entry) => entry.messageId), [message.messageId]);
});

test("commit refuses a pre-existing mismatched queue object without overwriting it", () => {
  const { jobDir } = fixture();
  const message = stageBridgeInput(jobDir, JOB_ID, "expected continuation");
  const paths = bridgeInputPaths(jobDir);
  const stagedName = fs.readdirSync(paths.stagingDir).at(0);
  const mismatched = { ...message, content: "different continuation" };
  mismatched.contentSha256 = "0".repeat(64);
  const queuedFile = path.join(paths.queueDir, stagedName);
  fs.writeFileSync(queuedFile, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });

  assert.throws(() => commitBridgeInput(jobDir, message), /invalid durable bridge input|identity mismatch/);
  assert.equal(JSON.parse(fs.readFileSync(queuedFile, "utf8")).content, "different continuation");
  assert.equal(fs.readdirSync(paths.stagingDir).length, 1);
});

test("queue directory fsync failure is an idempotent commit with a recovery anchor", () => {
  const { jobDir } = fixture();
  const message = stageBridgeInput(jobDir, JOB_ID, "durability-uncertain continuation");
  const paths = bridgeInputPaths(jobDir);
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      const error = new Error("injected queue directory fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsync(fd);
  };
  try {
    assert.doesNotThrow(() => commitBridgeInput(jobDir, message));
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(fs.readdirSync(paths.queueDir).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(fs.readdirSync(paths.stagingDir).filter((name) => name.endsWith(".json")).length, 1);
  assert.deepEqual(
    listPendingBridgeInput(jobDir, JOB_ID, { authorizedEvents: authorization(message) })
      .map((entry) => entry.messageId),
    [message.messageId]
  );
  assert.doesNotThrow(() => commitBridgeInput(jobDir, message));
  assert.equal(fs.readdirSync(paths.stagingDir).filter((name) => name.endsWith(".json")).length, 0);
});

test("crash leftovers from staging writes are never parsed as candidate messages", () => {
  const { jobDir } = fixture();
  const paths = initializeBridgeInput(jobDir);
  fs.writeFileSync(
    path.join(paths.stagingDir, ".partial.json.tmp-123-deadbeef"),
    '{"schemaVersion":1',
    { mode: 0o600 }
  );

  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, []), []);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID), []);
});

test("a staging directory sync fault leaves no visible unowned candidate", () => {
  const { jobDir } = fixture();
  const paths = initializeBridgeInput(jobDir);
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      const error = new Error("injected staging directory fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsync(fd);
  };
  try {
    assert.throws(() => stageBridgeInput(jobDir, JOB_ID, "never published"), /fsync failure/);
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.deepEqual(fs.readdirSync(paths.stagingDir).filter((name) => name.endsWith(".json")), []);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID), []);
});

test("an authorized staging anchor recovers after post-link directory sync failure and final-name loss", () => {
  const { jobDir } = fixture();
  const paths = initializeBridgeInput(jobDir);
  const originalFsync = fs.fsyncSync;
  let stagingDirectorySyncs = 0;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      stagingDirectorySyncs += 1;
      if (stagingDirectorySyncs === 2) {
        const error = new Error("injected post-link staging directory fsync failure");
        error.code = "EIO";
        throw error;
      }
    }
    return originalFsync(fd);
  };
  let message;
  try {
    message = stageBridgeInput(jobDir, JOB_ID, "recover from the durable hidden inode");
  } finally {
    fs.fsyncSync = originalFsync;
  }

  const visible = fs.readdirSync(paths.stagingDir).find((name) => name.endsWith(".json"));
  const anchor = fs.readdirSync(paths.stagingDir).find((name) => name.startsWith(`.${visible}.tmp-`));
  assert.ok(anchor, "post-link failure did not retain its durable recovery anchor");
  fs.unlinkSync(path.join(paths.stagingDir, visible));

  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, authorization(message)), [message.messageId]);
  assert.deepEqual(
    listPendingBridgeInput(jobDir, JOB_ID, { authorizedEvents: authorization(message) })
      .map((entry) => entry.messageId),
    [message.messageId]
  );
  assert.equal(fs.existsSync(path.join(paths.stagingDir, anchor)), false);
});

test("corrupt and wrong-identity staging anchors never become visible or queued", () => {
  const { jobDir } = fixture();
  const paths = initializeBridgeInput(jobDir);
  const message = {
    schemaVersion: 1,
    jobId: JOB_ID,
    messageId: "00000000-0000-4000-8000-000000000099",
    createdAt: "2026-07-19T12:00:00.000Z",
    content: "authorized content",
    contentSha256: ""
  };
  message.contentSha256 = crypto.createHash("sha256").update(message.content).digest("hex");
  const finalName = `${String(Date.parse(message.createdAt)).padStart(16, "0")}-${message.messageId}.json`;
  fs.writeFileSync(
    path.join(paths.stagingDir, `.${finalName}.tmp-123-00000000-0000-4000-8000-000000000001`),
    "{",
    { mode: 0o600 }
  );
  const wrongName = `0000000000000000-${message.messageId}.json`;
  fs.writeFileSync(
    path.join(paths.stagingDir, `.${wrongName}.tmp-124-00000000-0000-4000-8000-000000000002`),
    `${JSON.stringify(message)}\n`,
    { mode: 0o600 }
  );

  assert.deepEqual(recoverAuthorizedBridgeInput(jobDir, JOB_ID, authorization(message)), []);
  assert.deepEqual(fs.readdirSync(paths.stagingDir).filter((name) => name.endsWith(".json")), []);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID), []);
});

test("a fully durable exact acknowledgement suppresses replay and retries by stable identity", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const first = writeBridgeInputAck(jobDir, message, acknowledgement());
  const retry = writeBridgeInputAck(jobDir, message, acknowledgement({
    observedAt: "2026-07-19T12:05:00.000Z"
  }));

  assert.deepEqual(retry, first);
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID, { claudeSessionId: SESSION_ID }), []);
  assert.deepEqual(readBridgeInputAck(jobDir, message.messageId, {
    expectedMessage: message,
    claudeSessionId: SESSION_ID
  }), first);
});

test("interleaved exact acknowledgement writers both succeed after cleanup races", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const originalLink = fs.linkSync;
  let nested = false;
  let nestedValue;
  fs.linkSync = (source, destination) => {
    if (!nested && path.basename(source).startsWith(`.ack-${message.messageId}.tmp-`)) {
      nested = true;
      nestedValue = writeBridgeInputAck(jobDir, message, acknowledgement({
        observedAt: "2026-07-19T12:01:00.000Z"
      }));
    }
    return originalLink(source, destination);
  };
  let outerValue;
  try {
    assert.doesNotThrow(() => {
      outerValue = writeBridgeInputAck(jobDir, message, acknowledgement());
    });
  } finally {
    fs.linkSync = originalLink;
  }

  assert.deepEqual(outerValue, nestedValue);
  assert.equal(outerValue.observedAt, "2026-07-19T12:01:00.000Z");
  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID, { claudeSessionId: SESSION_ID }), []);
});

test("a torn final acknowledgement fails closed instead of suppressing replay", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const paths = bridgeInputPaths(jobDir);
  fs.writeFileSync(path.join(paths.ackDir, `${message.messageId}.json`), "{", { mode: 0o600 });

  assert.throws(
    () => listPendingBridgeInput(jobDir, JOB_ID, { claudeSessionId: SESSION_ID }),
    /invalid durable bridge input acknowledgement/
  );
  assert.throws(
    () => readBridgeInputAck(jobDir, message.messageId),
    /invalid durable bridge input acknowledgement/
  );
});

test("a wrong-identity final acknowledgement conflicts and never suppresses replay", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const paths = bridgeInputPaths(jobDir);
  const wrong = {
    schemaVersion: 1,
    jobId: message.jobId,
    messageId: message.messageId,
    state: "observed",
    claudeSessionId: SESSION_ID,
    observedEventType: "user",
    observedAt: "2026-07-19T12:00:00.000Z",
    contentSha256: "0".repeat(64)
  };
  fs.writeFileSync(
    path.join(paths.ackDir, `${message.messageId}.json`),
    `${JSON.stringify(wrong)}\n`,
    { mode: 0o600 }
  );

  assert.throws(
    () => listPendingBridgeInput(jobDir, JOB_ID, { claudeSessionId: SESSION_ID }),
    /acknowledgement identity conflict/
  );
  assert.throws(
    () => writeBridgeInputAck(jobDir, message, acknowledgement()),
    /acknowledgement identity conflict/
  );
});

test("a post-link acknowledgement sync fault returns success and retains a recovery anchor", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const paths = bridgeInputPaths(jobDir);
  const originalFsync = fs.fsyncSync;
  let directorySyncs = 0;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && ++directorySyncs === 2) {
      const error = new Error("injected post-link acknowledgement fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsync(fd);
  };
  let value;
  try {
    assert.doesNotThrow(() => {
      value = writeBridgeInputAck(jobDir, message, acknowledgement());
    });
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(value.messageId, message.messageId);
  assert.equal(fs.existsSync(path.join(paths.ackDir, `${message.messageId}.json`)), true);
  assert.equal(fs.readdirSync(paths.ackDir).some((name) => name.startsWith(`.ack-${message.messageId}.tmp-`)), true);
  assert.doesNotThrow(() => writeBridgeInputAck(jobDir, message, acknowledgement()));
  assert.equal(fs.readdirSync(paths.ackDir).some((name) => name.startsWith(`.ack-${message.messageId}.tmp-`)), false);
});

test("partial hidden acknowledgement writes are ignored and the message remains pending", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const paths = bridgeInputPaths(jobDir);
  fs.writeFileSync(
    path.join(paths.ackDir, `.ack-${message.messageId}.tmp-crash`),
    "{",
    { mode: 0o600 }
  );

  assert.deepEqual(
    listPendingBridgeInput(jobDir, JOB_ID, { claudeSessionId: SESSION_ID }).map((entry) => entry.messageId),
    [message.messageId]
  );
});

test("a durable hidden acknowledgement anchor republishes a missing final name", () => {
  const { jobDir } = fixture();
  const message = queuedMessage(jobDir);
  const paths = bridgeInputPaths(jobDir);
  const originalFsync = fs.fsyncSync;
  let directorySyncs = 0;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && ++directorySyncs === 2) {
      const error = new Error("injected post-link acknowledgement fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsync(fd);
  };
  try {
    writeBridgeInputAck(jobDir, message, acknowledgement());
  } finally {
    fs.fsyncSync = originalFsync;
  }
  fs.unlinkSync(path.join(paths.ackDir, `${message.messageId}.json`));

  assert.deepEqual(listPendingBridgeInput(jobDir, JOB_ID, { claudeSessionId: SESSION_ID }), []);
  assert.equal(fs.existsSync(path.join(paths.ackDir, `${message.messageId}.json`)), true);
  assert.equal(fs.readdirSync(paths.ackDir).some((name) => name.startsWith(`.ack-${message.messageId}.tmp-`)), false);
});
