import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  appendBridgeEvent,
  appendBridgeCodexMessage,
  cancelBridgeJob,
  collectBridgeJobs,
  createBridgeJob as createBridgeJobRaw,
  getBridgeBrokerAuthority,
  getBridgeJob,
  readBridgeEvents,
  readBridgeRequest,
  readBridgeResult,
  recordDispatch,
  requestBridgeCancellation,
  recoverBridgeJob,
  redactBridgeValue,
  resolveBridgeJobDir,
  resolveBridgeStateRoot,
  transitionBridgeJob,
  verifyBridgeCapability,
  writeBridgeResult
} from "../scripts/lib/bridge-state.mjs";

const moduleUrl = pathToFileURL(path.resolve("scripts/lib/bridge-state.mjs")).href;
const jobCapabilities = new Map();

function credentialKey(jobId, options = {}) {
  return `${path.resolve(options.stateRoot)}\0${jobId}`;
}

function createBridgeJob(requestValue, options = {}) {
  const created = createBridgeJobRaw(requestValue, options);
  jobCapabilities.set(credentialKey(requestValue.jobId, options), created.capabilityToken);
  return created;
}

function workerOptions(jobId, options = {}, extra = {}) {
  return { ...options, ...extra, capabilityToken: jobCapabilities.get(credentialKey(jobId, options)) };
}

function brokerOptions(jobId, options = {}, extra = {}) {
  return { ...options, ...extra, brokerAuthority: getBridgeBrokerAuthority(jobId, options) };
}

function jid(number) {
  return `ccb_${String(number).padStart(26, "0")}`;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-ledger-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  return { base, workspace, options: { stateRoot: path.join(base, "state") } };
}

function request(jobId, workspace, extra = {}) {
  return {
    schemaVersion: 1,
    jobId,
    origin: {
      codexThreadId: "thread-ledger", codexTurnId: null, cwd: workspace, repoRoot: workspace,
      branch: null, head: null
    },
    worker: {
      provider: "anthropic", model: "user-selected-model", agent: "implementer",
      inlineAgents: null, customAgentsFile: null, pluginDirs: [], mcpConfigPaths: [], addDirs: [],
      settingSources: [], effort: "high", resolvedRuntimeVersion: "2.1.207"
    },
    execution: {
      profile: "standard", executor: "tmux", tmuxSession: `ccb-${jobId.slice(-8)}`,
      workspaceMode: "current", requestedWorkspacePath: workspace, canonicalWorkspacePath: workspace,
      permittedRoot: workspace, claudeSessionId: "00000000-0000-4000-8000-000000000001",
      sandboxAttestation: null, timeoutSeconds: 900,
      effectiveClaudePermissionArgs: ["--setting-sources=", "--permission-mode", "default"]
    },
    task: { promptFile: "prompt.md", acceptance: ["tests pass"] },
    ...extra
  };
}

function completeResult(jobId, extra = {}) {
  return {
    schemaVersion: 1,
    jobId,
    status: "completed",
    summary: "done",
    filesChanged: [],
    commandsRun: [],
    testsRun: [],
    findings: [],
    blockers: [],
    claudeSessionId: null,
    exitStatus: { code: 0, signal: null },
    artifactPaths: [],
    ...extra
  };
}

function autonomousRequest(jobId, workspace) {
  const value = request(jobId, workspace);
  value.execution.profile = "sandbox-autonomous";
  value.execution.sandboxAttestation = {
    jobId,
    executor: "tmux",
    canonicalWorkspacePath: workspace,
    issuedAt: new Date().toISOString(),
    authority: "bridge-tmux-executor"
  };
  value.execution.effectiveClaudePermissionArgs = ["--setting-sources=", "--permission-mode", "bypassPermissions"];
  return value;
}

function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("bridge ledger creates private durable artifacts and never persists the raw capability token", {
  skip: process.platform === "win32"
}, () => {
  const { workspace, options } = fixture();
  const jobId = jid(1);
  const created = createBridgeJob(request(jobId, workspace), options);
  const root = resolveBridgeStateRoot(options);
  const jobDir = resolveBridgeJobDir(jobId, options);

  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700);
  for (const file of ["request.json", "state.json", "events.jsonl"]) {
    assert.equal(fs.statSync(path.join(jobDir, file)).mode & 0o777, 0o600);
  }
  assert.equal(verifyBridgeCapability(jobId, created.capabilityToken, options), true);
  assert.equal(verifyBridgeCapability(jobId, "wrong-token", options), false);
  const persisted = fs.readFileSync(path.join(jobDir, "state.json"), "utf8");
  assert.equal(persisted.includes(created.capabilityToken), false);
  assert.match(created.job.capabilityTokenHash, /^[a-f0-9]{64}$/);
});

test("broker authority is restart-stable, private, and absent from job-visible state", {
  skip: process.platform === "win32"
}, () => {
  const { workspace, options } = fixture();
  const jobId = jid(50);
  const created = createBridgeJob(request(jobId, workspace), options);
  const recoveredAuthority = getBridgeBrokerAuthority(jobId, options);
  const keyFile = path.join(resolveBridgeStateRoot(options), "broker-authority.key");

  assert.deepEqual(recoveredAuthority, created.brokerAuthority);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  for (const file of ["request.json", "state.json", "events.jsonl"]) {
    const contents = fs.readFileSync(path.join(resolveBridgeJobDir(jobId, options), file), "utf8");
    assert.equal(contents.includes(recoveredAuthority.token), false);
  }
});

test("dispatch identity is an immutable broker-only accepted-to-running mutation", () => {
  const { workspace, options } = fixture();
  const jobId = jid(51);
  const created = createBridgeJob(request(jobId, workspace), options);
  const identity = {
    executor: "tmux",
    tmuxSession: `ccb-${jobId.slice(-8)}`,
    paneId: "%42",
    panePid: 4319,
    workerPid: 4321,
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    requestedPermissionMode: "default",
    effectivePermissionMode: "default",
    permissionVerification: "verified",
    origin: request(jobId, workspace).origin,
    recordedAt: new Date().toISOString()
  };

  assert.throws(() => recordDispatch(jobId, identity, options), /broker authority/i);
  const recorded = recordDispatch(jobId, identity, { ...options, brokerAuthority: created.brokerAuthority });
  assert.equal(recorded.status, "running");
  assert.deepEqual(recorded.dispatch, identity);
  assert.equal(fs.statSync(path.join(resolveBridgeJobDir(jobId, options), "dispatch.json")).mode & 0o777, 0o600);
  assert.deepEqual(
    recordDispatch(jobId, identity, { ...options, brokerAuthority: getBridgeBrokerAuthority(jobId, options) }).dispatch,
    identity
  );
  assert.throws(() => recordDispatch(jobId, { ...identity, workerPid: 9999 }, {
    ...options,
    brokerAuthority: created.brokerAuthority
  }), /dispatch identity is immutable/i);
  assert.throws(() => recordDispatch(jobId, {
    ...identity,
    permissionVerification: "mismatch"
  }, {
    ...options,
    brokerAuthority: created.brokerAuthority
  }), /permission attestation is not verified/i);
  assert.deepEqual(readBridgeEvents(jobId, options).map(({ type, sender }) => ({ type, sender })), [
    { type: "accepted", sender: "bridge" },
    { type: "started", sender: "bridge" }
  ]);

  const jobDir = resolveBridgeJobDir(jobId, options);
  const accepted = readBridgeEvents(jobId, options)[0];
  fs.writeFileSync(path.join(jobDir, "events.jsonl"), `${JSON.stringify(accepted)}\n`, { mode: 0o600 });
  const staleState = getBridgeJob(jobId, options);
  Object.assign(staleState, {
    status: "accepted",
    dispatch: null,
    lastEventSequence: 1,
    eventDeduplication: { [accepted.deduplicationKey]: 1 },
    updatedAt: accepted.timestamp
  });
  fs.writeFileSync(path.join(jobDir, "state.json"), `${JSON.stringify(staleState, null, 2)}\n`, { mode: 0o600 });
  const recovered = recoverBridgeJob(jobId, { ...options, brokerAuthority: getBridgeBrokerAuthority(jobId, options) });
  assert.equal(recovered.status, "running");
  assert.deepEqual(recovered.dispatch, identity);
});

test("worker event mutations require the exact job capability", () => {
  const { workspace, options } = fixture();
  const jobId = jid(43);
  const created = createBridgeJob(request(jobId, workspace), options);
  const event = {
    type: "progress",
    sender: "claude",
    deduplicationKey: "worker:authorized:1",
    payload: { message: "authorized progress" }
  };

  assert.throws(() => appendBridgeEvent(jobId, event, options), /worker capability/i);
  assert.throws(
    () => appendBridgeEvent(jobId, event, { ...options, capabilityToken: "forged" }),
    /worker capability/i
  );
  assert.equal(appendBridgeEvent(jobId, event, {
    ...options,
    capabilityToken: created.capabilityToken
  }).sender, "claude");
});

test("Codex replies are broker-authorized, durable, and correlated to a Claude question", () => {
  const { workspace, options } = fixture();
  const jobId = jid(49);
  const created = createBridgeJob(request(jobId, workspace), options);
  appendBridgeEvent(jobId, {
    type: "question",
    deduplicationKey: "claude-question:toolu_1",
    payload: { questionId: "toolu_1", text: "Proceed?" }
  }, { ...options, capabilityToken: created.capabilityToken });

  assert.throws(() => appendBridgeCodexMessage(jobId, {
    messageId: "message-1", text: "Yes", replyTo: "toolu_1"
  }, options), /broker authority/i);
  const event = appendBridgeCodexMessage(jobId, {
    messageId: "message-1", text: "Yes", replyTo: "toolu_1"
  }, { ...options, brokerAuthority: created.brokerAuthority });

  assert.equal(event.sender, "codex");
  assert.deepEqual(event.payload, { messageId: "message-1", text: "Yes", replyTo: "toolu_1" });
  assert.equal(readBridgeEvents(jobId, options).at(-1).type, "codex_message");
});

test("authoritative lifecycle mutations require job-bound broker authority", () => {
  const { workspace, options } = fixture();
  const jobId = jid(44);
  const created = createBridgeJob(request(jobId, workspace), options);

  assert.throws(() => transitionBridgeJob(jobId, "running", {}, options), /broker authority/i);
  assert.throws(
    () => transitionBridgeJob(jobId, "running", {}, {
      ...options,
      brokerAuthority: { kind: "bridge-broker", jobId, token: created.capabilityToken }
    }),
    /broker authority/i
  );
  assert.equal(transitionBridgeJob(jobId, "running", {}, {
    ...options,
    brokerAuthority: created.brokerAuthority
  }).status, "running");
});

test("cancellation, result publication, and recovery are broker-only mutations", () => {
  const { workspace, options } = fixture();
  const jobId = jid(45);
  const created = createBridgeJob(request(jobId, workspace), options);
  const brokerOptions = { ...options, brokerAuthority: created.brokerAuthority };

  transitionBridgeJob(jobId, "running", {}, brokerOptions);
  assert.throws(() => requestBridgeCancellation(jobId, "forged", options), /broker authority/i);
  requestBridgeCancellation(jobId, "operator", brokerOptions);
  transitionBridgeJob(jobId, "cancelled", {}, brokerOptions);
  const cancelled = { ...completeResult(jobId), status: "cancelled", exitStatus: { code: null, signal: "SIGTERM" } };
  assert.throws(() => writeBridgeResult(jobId, cancelled, options), /broker authority/i);
  assert.equal(writeBridgeResult(jobId, cancelled, brokerOptions).status, "cancelled");
  assert.throws(() => recoverBridgeJob(jobId, options), /broker authority/i);
  assert.equal(recoverBridgeJob(jobId, brokerOptions).status, "cancelled");
});

test("worker capability cannot impersonate broker, Codex, or verifier event senders", () => {
  const { workspace, options } = fixture();
  const jobId = jid(46);
  const created = createBridgeJob(request(jobId, workspace), options);
  const workerOptions = { ...options, capabilityToken: created.capabilityToken };
  for (const sender of ["bridge", "codex", "verifier"]) {
    assert.throws(() => appendBridgeEvent(jobId, {
      type: "progress",
      sender,
      deduplicationKey: `worker:impersonate:${sender}`,
      payload: { message: "forged identity" }
    }, workerOptions), /worker events must use sender claude/i);
  }
  assert.equal(appendBridgeEvent(jobId, {
    type: "progress",
    deduplicationKey: "worker:derived-sender",
    payload: { message: "derived identity" }
  }, workerOptions).sender, "claude");
});

test("worker events exceeding the durable event quota fail without mutating the journal", () => {
  const { workspace, options } = fixture();
  const jobId = jid(47);
  const created = createBridgeJob(request(jobId, workspace), options);
  assert.throws(() => appendBridgeEvent(jobId, {
    type: "progress",
    deduplicationKey: "worker:oversized",
    payload: { message: "x".repeat(64 * 1024) }
  }, { ...options, capabilityToken: created.capabilityToken }), /event exceeds.*quota/i);
  assert.equal(readBridgeEvents(jobId, options).length, 1);
  assert.equal(getBridgeJob(jobId, options).lastEventSequence, 1);
});

test("broker result publication enforces strict field and artifact quotas", () => {
  const { workspace, options } = fixture();
  const jobId = jid(48);
  const created = createBridgeJob(request(jobId, workspace), options);
  const brokerOptions = { ...options, brokerAuthority: created.brokerAuthority };
  transitionBridgeJob(jobId, "running", {}, brokerOptions);
  transitionBridgeJob(jobId, "completed", {}, brokerOptions);

  assert.throws(() => writeBridgeResult(jobId, completeResult(jobId, {
    summary: "x".repeat((64 * 1024) + 1)
  }), brokerOptions), /result string exceeds.*quota/i);
  assert.equal(readBridgeResult(jobId, options), null);
  assert.equal(getBridgeJob(jobId, options).resultStatus, null);
});

test("immutable delegation request cannot be replaced and a job id is exclusive", () => {
  const { workspace, options } = fixture();
  const jobId = jid(2);
  const original = request(jobId, workspace);
  createBridgeJob(original, options);
  original.task.promptFile = "mutated.md";
  assert.equal(readBridgeRequest(jobId, options).task.promptFile, "prompt.md");
  assert.throws(() => createBridgeJob(request(jobId, workspace), options), /EEXIST/);
  assert.throws(
    () => createBridgeJob(request("review-not-a-bridge-ulid", workspace), options),
    /jobId must match pattern/
  );
});

test("two concurrent dispatchers cannot claim the same canonical workspace", async () => {
  const { workspace, options } = fixture();
  const script = `
    import { createBridgeJob } from ${JSON.stringify(moduleUrl)};
    const [jobId, workspace, stateRoot] = process.argv.slice(1);
    try {
      const request = ${request.toString()}(jobId, workspace);
      createBridgeJob(request, { stateRoot });
      process.stdout.write("claimed");
    } catch (error) {
      process.stdout.write("rejected:" + error.message);
    }
  `;
  const results = await Promise.all([
    runChild(script, [jid(3), workspace, options.stateRoot]),
    runChild(script, [jid(4), workspace, options.stateRoot])
  ]);
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  assert.equal(results.filter((result) => result.stdout === "claimed").length, 1);
  assert.equal(results.filter((result) => result.stdout.startsWith("rejected:Workspace already leased")).length, 1);
});

test("a dead creation owner cannot leave an artifact-free workspace lease permanently wedged", () => {
  const { workspace, options } = fixture();
  const orphanedId = jid(43);
  createBridgeJob(request(orphanedId, workspace), options);

  const leasesDir = path.join(options.stateRoot, "leases");
  const [leaseName] = fs.readdirSync(leasesDir);
  const leaseFile = path.join(leasesDir, leaseName);
  const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  fs.rmSync(resolveBridgeJobDir(orphanedId, options), { recursive: true });
  fs.writeFileSync(leaseFile, `${JSON.stringify({
    ...lease,
    ownerPid: 2147483647
  }, null, 2)}\n`, { mode: 0o600 });

  const replacementId = jid(44);
  assert.doesNotThrow(() => createBridgeJob(request(replacementId, workspace), options));
  assert.equal(getBridgeJob(replacementId, options).workspace, fs.realpathSync(workspace));
});

test("an artifact-free workspace lease remains authoritative while its creation owner is alive", () => {
  const { workspace, options } = fixture();
  const activeId = jid(45);
  createBridgeJob(request(activeId, workspace), options);

  fs.rmSync(resolveBridgeJobDir(activeId, options), { recursive: true });
  const replacementId = jid(46);
  assert.throws(
    () => createBridgeJob(request(replacementId, workspace), options),
    new RegExp(`Workspace already leased by ${activeId}`)
  );
});

test("events are ordered, redacted, and idempotently deduplicated across replay", () => {
  const { workspace, options } = fixture();
  const jobId = jid(5);
  createBridgeJob(request(jobId, workspace), options);
  const first = appendBridgeEvent(jobId, {
    type: "progress",
    sender: "claude",
    deduplicationKey: "worker:progress:1",
    payload: { message: "using Bearer abcdefghijklmnopqrstuvwxyz" }
  }, workerOptions(jobId, options));
  const replay = appendBridgeEvent(jobId, {
    type: "progress",
    sender: "claude",
    deduplicationKey: "worker:progress:1",
    payload: { message: "duplicate must not apply" }
  }, workerOptions(jobId, options));
  assert.equal(replay.sequence, first.sequence);
  assert.deepEqual(readBridgeEvents(jobId, options).map((event) => event.sequence), [1, 2]);
  assert.equal(readBridgeEvents(jobId, options)[1].payload.message.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(getBridgeJob(jobId, options).lastEventSequence, 2);
});

test("state machine validates transitions and separates cancellation request from confirmation", () => {
  const { workspace, options } = fixture();
  const jobId = jid(6);
  createBridgeJob(request(jobId, workspace), options);
  const authorityOptions = brokerOptions(jobId, options);
  const running = transitionBridgeJob(jobId, "running", {}, authorityOptions);
  assert.equal(transitionBridgeJob(jobId, "running", {}, authorityOptions).updatedAt, running.updatedAt);
  assert.throws(() => transitionBridgeJob(jobId, "accepted", {}, authorityOptions), /Invalid bridge job transition/);
  const requested = requestBridgeCancellation(jobId, "operator request", authorityOptions);
  assert.equal(requested.status, "running");
  assert.ok(requested.cancelRequestedAt);
  assert.equal(cancelBridgeJob(jobId, "replay", authorityOptions).status, "running");
  const cancelled = transitionBridgeJob(jobId, "cancelled", { reason: "worker stopped" }, authorityOptions);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelBridgeJob(jobId, "replay", authorityOptions).status, "cancelled");
  assert.throws(() => transitionBridgeJob(jobId, "completed", {}, authorityOptions), /Invalid bridge job transition/);
  assert.deepEqual(readBridgeEvents(jobId, options).map((event) => event.type), ["accepted", "started", "cancel_requested", "cancelled"]);
  assert.doesNotThrow(() => createBridgeJob(request(jid(7), workspace), options));
});

test("cancellation confirmation requires prior durable intent", () => {
  const { workspace, options } = fixture();
  const jobId = jid(31);
  createBridgeJob(request(jobId, workspace), options);
  assert.throws(
    () => transitionBridgeJob(jobId, "cancelled", { reason: "forged confirmation" }, brokerOptions(jobId, options)),
    /prior durable cancel_requested/
  );
  assert.equal(getBridgeJob(jobId, options).status, "accepted");
});

test("sandbox-autonomous jobs fail before persistence without trusted authority verification", () => {
  const { workspace, options } = fixture();
  const jobId = jid(32);
  assert.throws(() => createBridgeJob(autonomousRequest(jobId, workspace), options), (error) => {
    assert.equal(error.name, "BridgeContractValidationError");
    assert.equal(error.phase, "semantics");
    return /trusted executor-owned authority and freshness verifier/.test(error.message);
  });
  assert.equal(fs.existsSync(path.join(options.stateRoot, "jobs", jobId)), false);
});

test("terminal result is status-bound, redacted, and immutable", () => {
  const { workspace, options } = fixture();
  const jobId = jid(8);
  createBridgeJob(request(jobId, workspace), options);
  const authorityOptions = brokerOptions(jobId, options);
  assert.throws(() => writeBridgeResult(jobId, completeResult(jobId), authorityOptions), /before a terminal/);
  transitionBridgeJob(jobId, "running", {}, authorityOptions);
  transitionBridgeJob(jobId, "completed", {}, authorityOptions);
  const result = completeResult(jobId, { summary: "token sk-abcdefghijklmnop" });
  assert.equal(writeBridgeResult(jobId, result, authorityOptions).summary, "token [REDACTED]");
  assert.deepEqual(writeBridgeResult(jobId, result, authorityOptions), readBridgeResult(jobId, options));
  assert.throws(
    () => writeBridgeResult(jobId, completeResult(jobId, { summary: "different" }), authorityOptions),
    /immutable/
  );
});

test("bridge job locking recovers a stale queued contender", () => {
  const { workspace, options } = fixture();
  const jobId = jid(9);
  createBridgeJob(request(jobId, workspace), options);
  const lockQueue = path.join(options.stateRoot, "locks", `job-${jobId}.queue`);
  const contender = path.join(lockQueue, "ticket-0000000000000001-dead");
  fs.mkdirSync(contender, { recursive: true });
  fs.writeFileSync(path.join(contender, "owner"), "2147483647:dead\n", { mode: 0o600 });

  appendBridgeEvent(jobId, {
    type: "progress",
    deduplicationKey: "after-stale",
    payload: { message: "after stale contender" }
  }, workerOptions(jobId, options));
  assert.equal(fs.existsSync(contender), false);
  assert.equal(getBridgeJob(jobId, options).lastEventSequence, 2);
});

test("recovery ignores an incomplete journal tail and preserves parseable authoritative state", () => {
  const { workspace, options } = fixture();
  const jobId = jid(10);
  createBridgeJob(request(jobId, workspace), options);
  const eventsFile = path.join(resolveBridgeJobDir(jobId, options), "events.jsonl");
  fs.appendFileSync(eventsFile, "{\"partial\":", "utf8");
  assert.equal(recoverBridgeJob(jobId, brokerOptions(jobId, options)).status, "accepted");
  appendBridgeEvent(jobId, { type: "progress", deduplicationKey: "after-partial", payload: { message: "after tail" } }, workerOptions(jobId, options));
  assert.deepEqual(readBridgeEvents(jobId, options).map((event) => event.sequence), [1, 2]);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(resolveBridgeJobDir(jobId, options), "state.json"), "utf8")));
});

test("SIGKILL during atomic state replacement leaves parseable state and recovery applies journal truth", {
  skip: process.platform === "win32"
}, async () => {
  const { workspace, options } = fixture();
  const jobId = jid(11);
  createBridgeJob(request(jobId, workspace), options);
  const script = `
    import fs from "node:fs";
    import { getBridgeBrokerAuthority, transitionBridgeJob } from ${JSON.stringify(moduleUrl)};
    const [jobId, stateRoot] = process.argv.slice(1);
    const original = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (String(destination).endsWith("/state.json")) {
        process.stdout.write("READY\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      }
      return original(source, destination);
    };
    transitionBridgeJob(jobId, "running", {}, {
      stateRoot,
      brokerAuthority: getBridgeBrokerAuthority(jobId, { stateRoot })
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, jobId, options.stateRoot], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("READY")) resolve();
    });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));

  assert.equal(getBridgeJob(jobId, options).status, "accepted");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(resolveBridgeJobDir(jobId, options), "state.json"), "utf8")));
  const recovered = recoverBridgeJob(jobId, brokerOptions(jobId, options));
  assert.equal(recovered.status, "running");
  assert.equal(recovered.lastEventSequence, 2);
});

test("redaction handles nested secret keys and common inline credentials without mutating input", () => {
  const input = {
    nested: { password: "hunter2", safe: "keep" },
    headers: ["Bearer abcdefghijklmnopqrstuvwxyz"],
    token: "ordinary word is not a secret-key name"
  };
  const redacted = redactBridgeValue(input);
  assert.equal(redacted.nested.password, "[REDACTED]");
  assert.equal(redacted.nested.safe, "keep");
  assert.equal(redacted.headers[0], "[REDACTED]");
  assert.equal(input.nested.password, "hunter2");
});

test("redaction rejects cyclic values deterministically", () => {
  const cyclic = { safe: "value" };
  cyclic.self = cyclic;
  assert.throws(() => redactBridgeValue(cyclic), (error) => {
    assert.equal(error.name, "BridgeContractValidationError");
    assert.equal(error.phase, "semantics");
    return /cycle/.test(error.message);
  });
});

test("production persistence entry points enforce request, event, and result schemas", () => {
  const { workspace, options } = fixture();
  const invalid = request(jid(15), workspace);
  invalid.unexpected = true;
  assert.throws(() => createBridgeJob(invalid, options), (error) => error.name === "BridgeContractValidationError" && error.phase === "schema");

  const jobId = jid(16);
  createBridgeJob(request(jobId, workspace), options);
  assert.throws(() => appendBridgeEvent(jobId, {
    type: "progress", sender: "claude", deduplicationKey: "bad-payload", payload: {}
  }, workerOptions(jobId, options)), (error) => error.name === "BridgeContractValidationError" && error.phase === "schema");
  const authorityOptions = brokerOptions(jobId, options);
  transitionBridgeJob(jobId, "running", {}, authorityOptions);
  transitionBridgeJob(jobId, "completed", {}, authorityOptions);
  assert.throws(() => writeBridgeResult(jobId, { jobId, status: "completed" }, authorityOptions), (error) => error.name === "BridgeContractValidationError" && error.phase === "schema");
});

test("public event append cannot forge lifecycle or control events", () => {
  const { workspace, options } = fixture();
  const jobId = jid(17);
  createBridgeJob(request(jobId, workspace), options);
  for (const event of [
    { type: "started", sender: "bridge", deduplicationKey: "attacker:start", payload: { executor: "tmux" } },
    { type: "progress", sender: "claude", deduplicationKey: "lifecycle:forged", payload: { message: "forged" } },
    { type: "cancel_requested", sender: "codex", deduplicationKey: "attacker:cancel", payload: { reason: "x", requestedAt: new Date().toISOString() } }
  ]) {
    assert.throws(() => appendBridgeEvent(jobId, event, options), /Reserved lifecycle\/control/);
  }
  assert.equal(getBridgeJob(jobId, options).status, "accepted");
  assert.equal(readBridgeEvents(jobId, options).length, 1);
});

test("job creation accepts a precommitted capability for crash-safe broker publication", () => {
  const { workspace, options } = fixture();
  const jobId = jid(61);
  const capabilityToken = "c".repeat(43);
  const created = createBridgeJobRaw(request(jobId, workspace), { ...options, capabilityToken });

  assert.equal(created.capabilityToken, capabilityToken);
  assert.equal(verifyBridgeCapability(jobId, capabilityToken, options), true);
  assert.equal(verifyBridgeCapability(jobId, "d".repeat(43), options), false);

  const invalid = fixture();
  assert.throws(
    () => createBridgeJobRaw(request(jid(62), invalid.workspace), { ...invalid.options, capabilityToken: "short" }),
    /precommitted worker capability/
  );
});

test("recovery rejects malformed complete lines and invalid event ordering metadata", () => {
  for (const [number, tamper, pattern] of [
    [18, (lines) => [...lines, "not-json"], /not valid JSON/],
    [19, (lines) => { const event = JSON.parse(lines[1]); event.sequence = 9; return [lines[0], JSON.stringify(event)]; }, /sequence gap/],
    [20, (lines) => { const event = JSON.parse(lines[1]); event.deduplicationKey = JSON.parse(lines[0]).deduplicationKey; return [lines[0], JSON.stringify(event)]; }, /Duplicate event deduplication/],
    [21, (lines) => { const event = JSON.parse(lines[1]); event.timestamp = "2000-01-01T00:00:00.000Z"; return [lines[0], JSON.stringify(event)]; }, /timestamp regression/]
  ]) {
    const { workspace, options } = fixture();
    const jobId = jid(number);
    createBridgeJob(request(jobId, workspace), options);
    transitionBridgeJob(jobId, "running", {}, brokerOptions(jobId, options));
    const file = path.join(resolveBridgeJobDir(jobId, options), "events.jsonl");
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    fs.writeFileSync(file, `${tamper(lines).join("\n")}\n`, { mode: 0o600 });
    assert.throws(() => recoverBridgeJob(jobId, brokerOptions(jobId, options)), pattern);
  }
});

test("recovery replays the transition graph and never invents terminalAt", () => {
  const { workspace, options } = fixture();
  const jobId = jid(22);
  createBridgeJob(request(jobId, workspace), options);
  const file = path.join(resolveBridgeJobDir(jobId, options), "events.jsonl");
  const accepted = readBridgeEvents(jobId, options)[0];
  const completed = {
    schemaVersion: 1, jobId, sequence: 2, timestamp: new Date(Date.parse(accepted.timestamp) + 1).toISOString(),
    type: "completed", sender: "bridge", deduplicationKey: "lifecycle:completed:2",
    payload: { resultPath: path.join(resolveBridgeJobDir(jobId, options), "result.json") }
  };
  fs.appendFileSync(file, `${JSON.stringify(completed)}\n`);
  assert.throws(() => recoverBridgeJob(jobId, brokerOptions(jobId, options)), /Invalid bridge journal transition accepted -> completed/);

  const clean = fixture();
  const cleanId = jid(23);
  createBridgeJob(request(cleanId, clean.workspace), clean.options);
  const recovered = recoverBridgeJob(cleanId, brokerOptions(cleanId, clean.options));
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.terminalAt, null);
});

test("recovery rejects schema-valid executor senders forged as state-operation lifecycle events", () => {
  for (const [number, terminal, payload] of [
    [33, "completed", { resultPath: "/forged/result.json" }],
    [34, "failed", { error: "forged failure" }],
    [35, "cancelled", { reason: "forged cancellation" }]
  ]) {
    const { workspace, options } = fixture();
    const jobId = jid(number);
    createBridgeJob(request(jobId, workspace), options);
    const authorityOptions = brokerOptions(jobId, options);
    transitionBridgeJob(jobId, "running", {}, authorityOptions);
    if (terminal === "cancelled") requestBridgeCancellation(jobId, "operator", authorityOptions);
    const file = path.join(resolveBridgeJobDir(jobId, options), "events.jsonl");
    const events = readBridgeEvents(jobId, options);
    const prior = events.at(-1);
    const forged = {
      schemaVersion: 1,
      jobId,
      sequence: prior.sequence + 1,
      timestamp: new Date(Date.parse(prior.timestamp) + 1).toISOString(),
      type: terminal,
      sender: "claude",
      deduplicationKey: `lifecycle:${terminal}:forged`,
      payload
    };
    fs.appendFileSync(file, `${JSON.stringify(forged)}\n`);
    assert.throws(() => recoverBridgeJob(jobId, authorityOptions), new RegExp(`Invalid lifecycle event sender claude for ${terminal}`));
  }
});

test("recovery rejects cancellation without durable intent", () => {
  const missing = fixture();
  const missingId = jid(40);
  createBridgeJob(request(missingId, missing.workspace), missing.options);
  const authorityOptions = brokerOptions(missingId, missing.options);
  transitionBridgeJob(missingId, "running", {}, authorityOptions);
  requestBridgeCancellation(missingId, "operator", authorityOptions);
  transitionBridgeJob(missingId, "cancelled", {}, authorityOptions);
  const file = path.join(resolveBridgeJobDir(missingId, missing.options), "events.jsonl");
  const events = fs.readFileSync(file, "utf8").trimEnd().split("\n").map(JSON.parse);
  const rewritten = events.filter((event) => event.type !== "cancel_requested").map((event, index) => ({ ...event, sequence: index + 1 }));
  fs.writeFileSync(file, `${rewritten.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  assert.throws(() => recoverBridgeJob(missingId, authorityOptions), /without prior cancel_requested/);
});

test("artifact symlinks and immutable request swaps fail closed", { skip: process.platform === "win32" }, () => {
  for (const [number, artifact, operation] of [
    [24, "request.json", (jobId, options) => readBridgeRequest(jobId, options)],
    [25, "state.json", (jobId, options) => getBridgeJob(jobId, options)],
    [26, "events.jsonl", (jobId, options) => readBridgeEvents(jobId, options)]
  ]) {
    const { workspace, options } = fixture();
    const jobId = jid(number);
    createBridgeJob(request(jobId, workspace), options);
    const target = path.join(resolveBridgeJobDir(jobId, options), artifact);
    const substitute = path.join(path.dirname(target), `substitute-${artifact}`);
    fs.writeFileSync(substitute, "{}\n", { mode: 0o600 });
    fs.unlinkSync(target);
    fs.symlinkSync(substitute, target);
    assert.throws(() => operation(jobId, options), /symbolic|regular|parseable/i);
  }

  const swapped = fixture();
  const swappedId = jid(27);
  createBridgeJob(request(swappedId, swapped.workspace), swapped.options);
  const requestFile = path.join(resolveBridgeJobDir(swappedId, swapped.options), "request.json");
  const changed = request(swappedId, swapped.workspace);
  changed.task.acceptance = ["attacker changed immutable request"];
  fs.writeFileSync(requestFile, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
  assert.throws(() => readBridgeRequest(swappedId, swapped.options), /identity mismatch/);
});

test("result creation rejects a prepositioned symlink", { skip: process.platform === "win32" }, () => {
  const { workspace, options } = fixture();
  const jobId = jid(28);
  createBridgeJob(request(jobId, workspace), options);
  const authorityOptions = brokerOptions(jobId, options);
  transitionBridgeJob(jobId, "running", {}, authorityOptions);
  transitionBridgeJob(jobId, "completed", {}, authorityOptions);
  const resultFile = path.join(resolveBridgeJobDir(jobId, options), "result.json");
  const target = path.join(path.dirname(resultFile), "attacker-result.json");
  fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  fs.symlinkSync(target, resultFile);
  assert.throws(() => writeBridgeResult(jobId, completeResult(jobId), authorityOptions), /regular file/);
});

test("SIGKILL before the in-directory marker move is reconciled on the first retry", {
  skip: process.platform === "win32"
}, async () => {
  const { workspace, options } = fixture();
  const killedId = jid(29);
  const childRequest = request(killedId, workspace);
  const script = `
    import fs from "node:fs";
    import { createBridgeJob } from ${JSON.stringify(moduleUrl)};
    const [requestJson, stateRoot] = process.argv.slice(1);
    const original = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (String(source).includes("/.creating-") && !String(destination).endsWith("state.json")) {
        process.stdout.write("PREMARKER\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      }
      return original(source, destination);
    };
    createBridgeJob(JSON.parse(requestJson), { stateRoot });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(childRequest), options.stateRoot], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => { if (chunk.toString().includes("PREMARKER")) resolve(); });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));

  const replacementId = jid(30);
  assert.doesNotThrow(() => createBridgeJob(request(replacementId, workspace), options));
  assert.equal(fs.existsSync(path.join(options.stateRoot, "jobs", `.creating-${killedId}`)), false);
  assert.equal(getBridgeJob(replacementId, options).workspace, fs.realpathSync(workspace));
});

test("SIGKILL after publication preserves the original exact lease and rejects a replacement job", {
  skip: process.platform === "win32"
}, async () => {
  const { workspace, options } = fixture();
  const killedId = jid(36);
  const script = `
    import fs from "node:fs";
    import { createBridgeJob } from ${JSON.stringify(moduleUrl)};
    const [requestJson, stateRoot] = process.argv.slice(1);
    const original = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (String(target).endsWith("/creation.json") && !String(target).includes("/.creating-")) {
        process.stdout.write("PUBLISHED\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      }
      return original(target);
    };
    createBridgeJob(JSON.parse(requestJson), { stateRoot });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request(killedId, workspace)), options.stateRoot], {
    cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => { if (chunk.toString().includes("PUBLISHED")) resolve(); });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));

  const publishedDir = resolveBridgeJobDir(killedId, options);
  assert.equal(fs.existsSync(path.join(publishedDir, "creation.json")), true);
  const replacementId = jid(37);
  assert.throws(
    () => createBridgeJob(request(replacementId, workspace), options),
    new RegExp(`Workspace already leased by ${killedId}`)
  );
  assert.equal(fs.existsSync(publishedDir), true);
  assert.equal(fs.existsSync(path.join(publishedDir, "creation.json")), false);
  assert.equal(getBridgeJob(killedId, options).workspace, fs.realpathSync(workspace));
  assert.equal(recoverBridgeJob(killedId, brokerOptions(killedId, options)).status, "accepted");
  assert.equal(fs.existsSync(resolveBridgeJobDir(replacementId, options)), false);
});

test("published-marker recovery preserves a non-matching workspace lease", () => {
  const { workspace, options } = fixture();
  const originalId = jid(38);
  createBridgeJob(request(originalId, workspace), options);
  const marker = {
    schemaVersion: 1,
    jobId: originalId,
    workspace: fs.realpathSync(workspace),
    ownerPid: 2147483647,
    stagingName: `.creating-${originalId}`,
    createdAt: new Date().toISOString()
  };
  const markerFile = path.join(resolveBridgeJobDir(originalId, options), "creation.json");
  fs.writeFileSync(markerFile, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

  assert.throws(
    () => createBridgeJob(request(jid(39), workspace), options),
    new RegExp(`Workspace already leased by ${originalId}`)
  );
  assert.equal(fs.existsSync(markerFile), true);
});

test("published-marker recovery reconstructs a missing exact lease for the authoritative job", () => {
  const { workspace, options } = fixture();
  const originalId = jid(41);
  createBridgeJob(request(originalId, workspace), options);
  const marker = {
    schemaVersion: 1,
    jobId: originalId,
    workspace: fs.realpathSync(workspace),
    ownerPid: 2147483647,
    stagingName: `.creating-${originalId}`,
    createdAt: new Date().toISOString()
  };
  const markerFile = path.join(resolveBridgeJobDir(originalId, options), "creation.json");
  fs.writeFileSync(markerFile, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const leasesDir = path.join(options.stateRoot, "leases");
  const [leaseName] = fs.readdirSync(leasesDir);
  fs.unlinkSync(path.join(leasesDir, leaseName));

  assert.throws(
    () => createBridgeJob(request(jid(42), workspace), options),
    new RegExp(`Workspace already leased by ${originalId}`)
  );
  assert.equal(fs.existsSync(markerFile), false);
  assert.equal(recoverBridgeJob(originalId, brokerOptions(originalId, options)).status, "accepted");
});

test("garbage collection removes only old terminal jobs and preserves active or recent jobs", () => {
  const { workspace, options } = fixture();
  fs.mkdirSync(path.join(path.dirname(workspace), "workspace-2"));
  fs.mkdirSync(path.join(path.dirname(workspace), "workspace-3"));
  const active = jid(12);
  const old = jid(13);
  const recent = jid(14);
  createBridgeJob(request(active, workspace), options);
  createBridgeJob(request(old, path.join(path.dirname(workspace), "workspace-2")), {
    ...options,
    clock: () => new Date("2019-12-31T00:00:00Z")
  });
  createBridgeJob(request(recent, path.join(path.dirname(workspace), "workspace-3")), {
    ...options,
    clock: () => new Date("2023-12-31T00:00:00Z")
  });
  requestBridgeCancellation(old, "gc fixture", brokerOptions(old, options, { clock: () => new Date("2019-12-31T12:00:00Z") }));
  requestBridgeCancellation(recent, "gc fixture", brokerOptions(recent, options, { clock: () => new Date("2023-12-31T12:00:00Z") }));
  transitionBridgeJob(old, "cancelled", {}, brokerOptions(old, options, { clock: () => new Date("2020-01-01T00:00:00Z") }));
  transitionBridgeJob(recent, "cancelled", {}, brokerOptions(recent, options, { clock: () => new Date("2024-01-01T00:00:00Z") }));
  const removed = collectBridgeJobs({
    ...options,
    nowMs: Date.parse("2024-01-02T00:00:00Z"),
    olderThanMs: 2 * 24 * 60 * 60 * 1_000,
    brokerAuthorityForJob: (jobId) => getBridgeBrokerAuthority(jobId, options)
  });
  assert.deepEqual(removed, [old]);
  assert.equal(fs.existsSync(resolveBridgeJobDir(active, options)), true);
  assert.equal(fs.existsSync(resolveBridgeJobDir(recent, options)), true);
});

test("garbage collection requires broker authority for every job it removes", () => {
  const { workspace, options } = fixture();
  const jobId = jid(49);
  const created = createBridgeJob(request(jobId, workspace), options);
  const brokerOptions = { ...options, brokerAuthority: created.brokerAuthority };
  requestBridgeCancellation(jobId, "gc fixture", brokerOptions);
  transitionBridgeJob(jobId, "cancelled", {}, brokerOptions);

  assert.throws(() => collectBridgeJobs(options), /brokerAuthorityForJob/);
  assert.deepEqual(collectBridgeJobs({
    ...options,
    olderThanMs: 0,
    nowMs: Date.now() + 1_000,
    brokerAuthorityForJob: () => ({ ...created.brokerAuthority, token: "forged" })
  }), []);
  assert.equal(fs.existsSync(resolveBridgeJobDir(jobId, options)), true);
  assert.deepEqual(collectBridgeJobs({
    ...options,
    olderThanMs: 0,
    nowMs: Date.now() + 1_000,
    brokerAuthorityForJob: () => created.brokerAuthority
  }), [jobId]);
});
