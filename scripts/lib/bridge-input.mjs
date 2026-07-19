import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JOB_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MESSAGE_BYTES = 256 * 1024;

function assertPrivateDirectory(directory) {
  const resolved = fs.realpathSync(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error(`bridge input directory must be private: ${directory}`);
  }
  return resolved;
}

function readPrivateJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MESSAGE_BYTES + 8 * 1024 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error(`bridge input artifact must be a bounded private regular file: ${file}`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusivePrivate(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomicPrivate(directory, file, value) {
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  let published = false;
  writeExclusivePrivate(temporary, value);
  try {
    // Make the complete hidden recovery inode durable before publishing a
    // visible candidate. A pre-publication failure therefore cannot strand an
    // inert .json object that callers never received and cannot authorize.
    syncDirectory(directory);
    // The hard link publishes only the already-complete, fsynced inode and
    // preserves no-clobber behavior if an explicit message id is reused.
    fs.linkSync(temporary, file);
    published = true;
    try {
      syncDirectory(directory);
    } catch {
      // The final name is complete and the hidden inode is a durable recovery
      // anchor. Report success so the caller can authorize/retry it rather
      // than leaving an unowned visible candidate behind.
      return;
    }
  } catch (error) {
    // Once linked, the complete final artifact may already be durable. Leave
    // both names as recovery anchors; .tmp-* entries are never candidates.
    if (!published) {
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
  try {
    fs.unlinkSync(temporary);
    syncDirectory(directory);
  } catch (error) {
    // The final name was durably published before temporary-name cleanup.
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function validateMessage(value, expectedJobId) {
  if (!value || value.schemaVersion !== 1 || value.jobId !== expectedJobId ||
      !JOB_PATTERN.test(value.jobId ?? "") || !MESSAGE_PATTERN.test(value.messageId ?? "") ||
      typeof value.content !== "string" || value.content.trim().length === 0 ||
      Buffer.byteLength(value.content, "utf8") > MAX_MESSAGE_BYTES ||
      !SHA256_PATTERN.test(value.contentSha256 ?? "") ||
      crypto.createHash("sha256").update(value.content).digest("hex") !== value.contentSha256 ||
      !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("invalid durable bridge input message");
  }
  return value;
}

function sameMessage(left, right) {
  return left.schemaVersion === right.schemaVersion &&
    left.jobId === right.jobId &&
    left.messageId === right.messageId &&
    left.createdAt === right.createdAt &&
    left.content === right.content &&
    left.contentSha256 === right.contentSha256;
}

function invalidAcknowledgement(messageId, cause) {
  return new Error(`invalid durable bridge input acknowledgement: ${messageId}`, { cause });
}

function acknowledgementConflict(messageId) {
  return new Error(`bridge input acknowledgement identity conflict: ${messageId}`);
}

function validateAcknowledgement(value, options = {}) {
  const messageId = options.expectedMessage?.messageId ?? value?.messageId ?? "unknown";
  if (!value || value.schemaVersion !== 1 || !JOB_PATTERN.test(value.jobId ?? "") ||
      !MESSAGE_PATTERN.test(value.messageId ?? "") || value.state !== "observed" ||
      !UUID_PATTERN.test(value.claudeSessionId ?? "") || value.observedEventType !== "user" ||
      !Number.isFinite(Date.parse(value.observedAt)) ||
      !SHA256_PATTERN.test(value.contentSha256 ?? "")) {
    throw invalidAcknowledgement(messageId);
  }
  const expected = options.expectedMessage;
  if (expected && (value.jobId !== expected.jobId || value.messageId !== expected.messageId ||
      value.contentSha256 !== expected.contentSha256)) {
    throw acknowledgementConflict(expected.messageId);
  }
  if (options.claudeSessionId != null && value.claudeSessionId !== options.claudeSessionId) {
    throw acknowledgementConflict(messageId);
  }
  return value;
}

function sameAcknowledgementIdentity(left, right) {
  return left.schemaVersion === right.schemaVersion &&
    left.jobId === right.jobId &&
    left.messageId === right.messageId &&
    left.state === right.state &&
    left.claudeSessionId === right.claudeSessionId &&
    left.observedEventType === right.observedEventType &&
    left.contentSha256 === right.contentSha256;
}

function ackFile(paths, messageId) {
  return path.join(paths.ackDir, `${messageId}.json`);
}

function ackTemporaryPrefix(messageId) {
  return `.ack-${messageId}.tmp-`;
}

function readValidatedAcknowledgement(file, options = {}) {
  const messageId = options.expectedMessage?.messageId ?? path.basename(file, ".json");
  try {
    return validateAcknowledgement(readPrivateJson(file), options);
  } catch (error) {
    if (error?.code === "ENOENT" || /identity conflict/.test(error?.message ?? "")) throw error;
    throw invalidAcknowledgement(messageId, error);
  }
}

function cleanupAckAnchors(paths, messageId) {
  const prefix = ackTemporaryPrefix(messageId);
  let changed = false;
  for (const entry of fs.readdirSync(paths.ackDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(prefix)) continue;
    try {
      fs.unlinkSync(path.join(paths.ackDir, entry.name));
      changed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
  }
  if (changed) {
    try {
      syncDirectory(paths.ackDir);
    } catch {
      // The authoritative final acknowledgement was already directory-synced.
      // Cleanup is best effort and must never turn success into a rollback.
    }
  }
}

function discardAckTemporary(paths, temporary, error) {
  try {
    fs.unlinkSync(temporary);
    syncDirectory(paths.ackDir);
  } catch (cleanupError) {
    if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
  }
}

function recoverBridgeInputAck(paths, options) {
  const expected = options.expectedMessage;
  if (!expected || !options.claudeSessionId) return null;
  const finalFile = ackFile(paths, expected.messageId);
  const prefix = ackTemporaryPrefix(expected.messageId);
  const candidates = fs.readdirSync(paths.ackDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of candidates) {
    const temporary = path.join(paths.ackDir, entry.name);
    let recovered;
    try {
      recovered = readValidatedAcknowledgement(temporary, options);
    } catch {
      // Partial or wrong-identity hidden anchors are never authoritative.
      continue;
    }
    try {
      fs.linkSync(temporary, finalFile);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
      try {
        const existing = readValidatedAcknowledgement(finalFile, options);
        if (!sameAcknowledgementIdentity(existing, recovered)) {
          throw acknowledgementConflict(expected.messageId);
        }
        recovered = existing;
      } catch (finalError) {
        if (error?.code === "ENOENT" && finalError?.code === "ENOENT") continue;
        throw finalError;
      }
    }
    try {
      syncDirectory(paths.ackDir);
    } catch {
      // Keep the durable hidden anchor and return the complete visible ACK.
      return recovered;
    }
    cleanupAckAnchors(paths, expected.messageId);
    return recovered;
  }
  return null;
}

function isAuthorized(message, events) {
  return events.some((event) => event?.type === "codex_message" &&
    event.sender === "codex" &&
    event.jobId === message.jobId &&
    event.payload?.messageId === message.messageId &&
    event.payload?.contentSha256 === message.contentSha256);
}

function inputFile(directory, message) {
  const sequence = String(Date.parse(message.createdAt)).padStart(16, "0");
  return path.join(directory, `${sequence}-${message.messageId}.json`);
}

function stagingAnchorFinalName(name) {
  const match = /^\.(\d{16}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json)\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(name);
  return match?.[1] ?? null;
}

function recoverAuthorizedStagingAnchors(paths, jobId, events) {
  const recovered = new Map();
  const anchors = fs.readdirSync(paths.stagingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && stagingAnchorFinalName(entry.name) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of anchors) {
    const finalName = stagingAnchorFinalName(entry.name);
    const anchorFile = path.join(paths.stagingDir, entry.name);
    let message;
    try {
      message = validateMessage(readPrivateJson(anchorFile), jobId);
    } catch {
      // A partial or wrong-identity hidden artifact is not authoritative and
      // must never create a visible staging candidate.
      continue;
    }
    if (path.basename(inputFile(paths.stagingDir, message)) !== finalName ||
        !isAuthorized(message, events)) {
      continue;
    }
    const finalFile = path.join(paths.stagingDir, finalName);
    try {
      fs.linkSync(anchorFile, finalFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.code !== "EEXIST") throw error;
      const existing = validateMessage(readPrivateJson(finalFile), jobId);
      if (!sameMessage(existing, message)) {
        throw new Error(`bridge input identity mismatch while recovering ${message.messageId}`);
      }
    }
    try {
      syncDirectory(paths.stagingDir);
    } catch {
      // The pre-synced hidden name remains a recovery anchor. Promotion to the
      // queue can still make this same inode durable in the queue directory.
    }
    const names = recovered.get(finalName) ?? [];
    names.push(entry.name);
    recovered.set(finalName, names);
  }
  return recovered;
}

function cleanupStagingAnchors(paths, names) {
  let changed = false;
  for (const name of names ?? []) {
    try {
      fs.unlinkSync(path.join(paths.stagingDir, name));
      changed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
  }
  if (changed) {
    try {
      syncDirectory(paths.stagingDir);
    } catch {
      // Queue publication and its directory entry are already durable. Hidden
      // staging-name cleanup is best effort and safe to retry.
    }
  }
}

export function bridgeInputPaths(jobDir) {
  const runtimeDir = path.join(assertPrivateDirectory(jobDir), "runtime");
  const inputRoot = path.join(runtimeDir, "input");
  return Object.freeze({
    inputRoot,
    stagingDir: path.join(inputRoot, "staging"),
    queueDir: path.join(inputRoot, "queue"),
    ackDir: path.join(inputRoot, "acks")
  });
}

export function initializeBridgeInput(jobDir) {
  const paths = bridgeInputPaths(jobDir);
  for (const directory of [paths.inputRoot, paths.stagingDir, paths.queueDir, paths.ackDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory);
  }
  return paths;
}

export function stageBridgeInput(jobDir, jobId, content, options = {}) {
  if (!JOB_PATTERN.test(jobId ?? "")) throw new Error("invalid bridge job id for input");
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("bridge continuation message must be non-empty");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`bridge continuation message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  const paths = initializeBridgeInput(jobDir);
  const messageId = options.messageId ?? crypto.randomUUID();
  if (!MESSAGE_PATTERN.test(messageId)) throw new Error("invalid bridge continuation message id");
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const message = {
    schemaVersion: 1,
    jobId,
    messageId,
    createdAt,
    content,
    contentSha256: crypto.createHash("sha256").update(content).digest("hex")
  };
  writeAtomicPrivate(paths.stagingDir, inputFile(paths.stagingDir, message), message);
  return Object.freeze(structuredClone(message));
}

export function commitBridgeInput(jobDir, message) {
  const expected = validateMessage(message, message?.jobId);
  const paths = initializeBridgeInput(jobDir);
  const stagedFile = inputFile(paths.stagingDir, expected);
  const queuedFile = inputFile(paths.queueDir, expected);
  let linked = false;
  let publicationSynced = false;
  let publicationSyncFailed = false;
  try {
    fs.linkSync(stagedFile, queuedFile);
    linked = true;
    try {
      syncDirectory(paths.queueDir);
      publicationSynced = true;
    } catch {
      publicationSyncFailed = true;
    }
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
  }

  try {
    const queued = validateMessage(readPrivateJson(queuedFile), expected.jobId);
    if (!sameMessage(queued, expected)) {
      throw new Error(`bridge input identity mismatch while committing ${expected.messageId}`);
    }
  } catch (error) {
    if (linked) {
      try {
        fs.unlinkSync(queuedFile);
        syncDirectory(paths.queueDir);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
      }
    }
    throw error;
  }

  if (!publicationSynced && !publicationSyncFailed) {
    try {
      // EEXIST/ENOENT retries must prove the already-published directory entry
      // durable before removing the staging recovery anchor.
      syncDirectory(paths.queueDir);
      publicationSynced = true;
    } catch {
      publicationSyncFailed = true;
    }
  }

  if (publicationSynced) {
    try {
      fs.unlinkSync(stagedFile);
      syncDirectory(paths.stagingDir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Publication is already durable. The inert staging link is recoverable,
        // so cleanup failure must not report a false rollback.
      }
    }
  }
  return Object.freeze(structuredClone(message));
}

function discardInputFile(file, message) {
  const claimedFile = `${file}.discarding-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(file, claimedFile);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    const queued = validateMessage(readPrivateJson(claimedFile), message.jobId);
    if (queued.messageId !== message.messageId || queued.contentSha256 !== message.contentSha256) {
      throw new Error(`bridge input identity mismatch while discarding ${message.messageId}`);
    }
  } finally {
    fs.unlinkSync(claimedFile);
  }
  return true;
}

export function discardStagedBridgeInput(jobDir, message) {
  validateMessage(message, message?.jobId);
  const paths = initializeBridgeInput(jobDir);
  return discardInputFile(inputFile(paths.stagingDir, message), message);
}

export function recoverAuthorizedBridgeInput(jobDir, jobId, events) {
  if (!Array.isArray(events)) throw new Error("bridge input recovery requires authoritative events");
  const paths = initializeBridgeInput(jobDir);
  const recoveredAnchors = recoverAuthorizedStagingAnchors(paths, jobId, events);
  const promoted = [];
  for (const entry of fs.readdirSync(paths.stagingDir, { withFileTypes: true })
    .filter((candidate) => candidate.isFile() && !candidate.isSymbolicLink() && candidate.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    let message;
    try {
      message = validateMessage(readPrivateJson(path.join(paths.stagingDir, entry.name)), jobId);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!isAuthorized(message, events)) continue;
    commitBridgeInput(jobDir, message);
    const finalName = path.basename(inputFile(paths.stagingDir, message));
    if (!fs.existsSync(path.join(paths.stagingDir, finalName))) {
      cleanupStagingAnchors(paths, recoveredAnchors.get(finalName));
    }
    promoted.push(message.messageId);
  }
  return Object.freeze(promoted);
}

export function listPendingBridgeInput(jobDir, jobId, options = {}) {
  const paths = initializeBridgeInput(jobDir);
  return fs.readdirSync(paths.queueDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      try {
        return [validateMessage(readPrivateJson(path.join(paths.queueDir, entry.name)), jobId)];
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    })
    .filter((message) => options.authorizedEvents == null || isAuthorized(message, options.authorizedEvents))
    .filter((message) => readBridgeInputAck(jobDir, message.messageId, {
      expectedMessage: message,
      claudeSessionId: options.claudeSessionId
    }) === null);
}

export function writeBridgeInputAck(jobDir, message, acknowledgement) {
  const paths = initializeBridgeInput(jobDir);
  validateMessage(message, message.jobId);
  const value = {
    schemaVersion: 1,
    jobId: message.jobId,
    messageId: message.messageId,
    state: "observed",
    claudeSessionId: acknowledgement.claudeSessionId,
    observedEventType: acknowledgement.observedEventType,
    observedAt: acknowledgement.observedAt ?? new Date().toISOString(),
    contentSha256: message.contentSha256
  };
  validateAcknowledgement(value, {
    expectedMessage: message,
    claudeSessionId: acknowledgement.claudeSessionId
  });
  const file = ackFile(paths, message.messageId);
  const temporary = path.join(
    paths.ackDir,
    `${ackTemporaryPrefix(message.messageId)}${process.pid}-${crypto.randomUUID()}`
  );
  writeExclusivePrivate(temporary, value);
  try {
    // Persist the recovery name before publishing the authoritative final name.
    syncDirectory(paths.ackDir);
  } catch (error) {
    throw error;
  }
  let result = value;
  try {
    fs.linkSync(temporary, file);
  } catch (error) {
    try {
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
      const existing = readValidatedAcknowledgement(file, {
        expectedMessage: message,
        claudeSessionId: acknowledgement.claudeSessionId
      });
      if (!sameAcknowledgementIdentity(existing, value)) {
        throw acknowledgementConflict(message.messageId);
      }
      result = existing;
    } catch (finalError) {
      discardAckTemporary(paths, temporary, finalError);
      if (error?.code === "ENOENT" && finalError?.code === "ENOENT") throw error;
      throw finalError;
    }
  }
  try {
    syncDirectory(paths.ackDir);
  } catch {
    // The visible ACK is complete and the pre-synced hidden name is a recovery
    // anchor. Do not crash the worker or falsely claim that replay rolled back.
    return Object.freeze(structuredClone(result));
  }
  cleanupAckAnchors(paths, message.messageId);
  return Object.freeze(structuredClone(result));
}

export function readBridgeInputAck(jobDir, messageId, options = {}) {
  if (!MESSAGE_PATTERN.test(messageId ?? "")) throw new Error("invalid bridge continuation message id");
  const paths = initializeBridgeInput(jobDir);
  try {
    return readValidatedAcknowledgement(ackFile(paths, messageId), options);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const recovered = recoverBridgeInputAck(paths, options);
      return recovered === null ? null : Object.freeze(structuredClone(recovered));
    }
    throw error;
  }
}

export function bridgeStreamEnvelope(messageId, content) {
  if (!MESSAGE_PATTERN.test(messageId ?? "")) throw new Error("invalid bridge continuation message id");
  return {
    type: "user",
    message: {
      role: "user",
      content: `[Codex bridge message ${messageId}]\n${content}`
    }
  };
}
