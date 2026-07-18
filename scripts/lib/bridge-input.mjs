import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JOB_PATTERN = /^ccb_[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MESSAGE_BYTES + 8 * 1024 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error(`bridge input artifact must be a bounded private regular file: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

function validateMessage(value, expectedJobId) {
  if (!value || value.schemaVersion !== 1 || value.jobId !== expectedJobId ||
      !JOB_PATTERN.test(value.jobId ?? "") || !MESSAGE_PATTERN.test(value.messageId ?? "") ||
      typeof value.content !== "string" || value.content.trim().length === 0 ||
      Buffer.byteLength(value.content, "utf8") > MAX_MESSAGE_BYTES ||
      !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("invalid durable bridge input message");
  }
  return value;
}

export function bridgeInputPaths(jobDir) {
  const runtimeDir = path.join(assertPrivateDirectory(jobDir), "runtime");
  const inputRoot = path.join(runtimeDir, "input");
  return Object.freeze({
    inputRoot,
    queueDir: path.join(inputRoot, "queue"),
    ackDir: path.join(inputRoot, "acks")
  });
}

export function initializeBridgeInput(jobDir) {
  const paths = bridgeInputPaths(jobDir);
  for (const directory of [paths.inputRoot, paths.queueDir, paths.ackDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(directory);
  }
  return paths;
}

export function enqueueBridgeInput(jobDir, jobId, content, options = {}) {
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
  const sequence = String(Date.parse(createdAt)).padStart(16, "0");
  const message = {
    schemaVersion: 1,
    jobId,
    messageId,
    createdAt,
    content,
    contentSha256: crypto.createHash("sha256").update(content).digest("hex")
  };
  writeExclusivePrivate(path.join(paths.queueDir, `${sequence}-${messageId}.json`), message);
  return Object.freeze(structuredClone(message));
}

export function listPendingBridgeInput(jobDir, jobId) {
  const paths = initializeBridgeInput(jobDir);
  return fs.readdirSync(paths.queueDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => validateMessage(readPrivateJson(path.join(paths.queueDir, entry.name)), jobId))
    .filter((message) => !fs.existsSync(path.join(paths.ackDir, `${message.messageId}.json`)));
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
  const file = path.join(paths.ackDir, `${message.messageId}.json`);
  try {
    writeExclusivePrivate(file, value);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readPrivateJson(file);
    if (JSON.stringify(existing) !== JSON.stringify(value)) return existing;
  }
  return Object.freeze(structuredClone(value));
}

export function readBridgeInputAck(jobDir, messageId) {
  if (!MESSAGE_PATTERN.test(messageId ?? "")) throw new Error("invalid bridge continuation message id");
  const { ackDir } = initializeBridgeInput(jobDir);
  try {
    return readPrivateJson(path.join(ackDir, `${messageId}.json`));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
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
