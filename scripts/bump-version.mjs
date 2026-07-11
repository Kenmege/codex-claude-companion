#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TRANSACTION_DIRECTORY = ".codex-version-bump.transaction";
const TRANSACTION_OWNER = "owner.json";
const TRANSACTION_JOURNAL = "journal.json";
const TRANSACTION_VERSION = 2;

const TARGETS = [
  {
    file: "package.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: "package-lock.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      },
      {
        label: "packages[\"\"].version",
        get: (json) => json.packages?.[""]?.version,
        set: (json, version) => {
          requireObject(json.packages?.[""], "package-lock.json packages[\"\"]");
          json.packages[""].version = version;
        }
      }
    ]
  },
  {
    file: ".codex-plugin/plugin.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help       Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: process.cwd(),
    version: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a valid Semantic Version such as 1.0.3, got: ${version}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function readJson(root, file) {
  const filePath = path.join(root, file);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readPackageVersion(root) {
  const packageJson = readJson(root, "package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  validateVersion(packageJson.version);
  return packageJson.version;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readStableFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd);
    const contents = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filePath);
    if (
      !before.isFile() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, current)
    ) {
      throw new Error(`Manifest changed while it was being read: ${filePath}`);
    }
    return { contents, stat: after };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lookupProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!/^\d+$/.test(startTicks ?? "")) return null;
      let bootId = "unknown-boot";
      try {
        bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      } catch {}
      return `linux:${bootId}:${startTicks}`;
    }

    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop;[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`;
      const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true
      });
      const ticks = String(result.stdout ?? "").trim();
      return result.status === 0 && /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
    }

    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    });
    const startedAt = String(result.stdout ?? "").trim().replace(/\s+/g, " ");
    return result.status === 0 && startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeDurableExclusive(filePath, contents, mode = 0o600) {
  let fd;
  try {
    fd = fs.openSync(filePath, "wx", mode);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.chmodSync(filePath, mode & 0o777);
}

function parseStableJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readStableFile(filePath).contents.toString("utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  requireObject(parsed, label);
  return parsed;
}

function transactionPaths(root) {
  const directory = path.join(root, TRANSACTION_DIRECTORY);
  return {
    directory,
    owner: path.join(directory, TRANSACTION_OWNER),
    journal: path.join(directory, TRANSACTION_JOURNAL)
  };
}

function validateOwner(owner) {
  if (
    owner.version !== TRANSACTION_VERSION ||
    typeof owner.ownerId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(owner.ownerId) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.createdAt !== "string" ||
    !(owner.processIdentity === null || (typeof owner.processIdentity === "string" && owner.processIdentity.length > 0))
  ) {
    throw new Error(`Invalid ${TRANSACTION_OWNER} in ${TRANSACTION_DIRECTORY}.`);
  }
}

function validateJournal(journal, owner) {
  if (
    journal.version !== TRANSACTION_VERSION ||
    journal.ownerId !== owner.ownerId ||
    !Array.isArray(journal.entries) ||
    journal.entries.length > TARGETS.length
  ) {
    throw new Error(`Invalid ${TRANSACTION_JOURNAL} in ${TRANSACTION_DIRECTORY}.`);
  }

  const allowedFiles = new Set(TARGETS.map((target) => target.file));
  const seenFiles = new Set();
  for (const [index, entry] of journal.entries.entries()) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !allowedFiles.has(entry.file) ||
      seenFiles.has(entry.file) ||
      entry.index !== index ||
      !/^[0-9a-f]{64}$/.test(entry.originalSha256) ||
      !/^[0-9a-f]{64}$/.test(entry.nextSha256) ||
      !Number.isSafeInteger(entry.mode)
    ) {
      throw new Error(`Invalid transaction entry ${index} in ${TRANSACTION_JOURNAL}.`);
    }
    seenFiles.add(entry.file);
  }
}

function removeEmptyUnownedTransaction(root, paths, stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${TRANSACTION_DIRECTORY} must be a real directory.`);
  }
  const entries = fs.readdirSync(paths.directory);
  if (entries.length !== 0) {
    throw new Error(`${TRANSACTION_DIRECTORY} has no valid owner; refusing to modify it.`);
  }
  fs.rmdirSync(paths.directory);
  fsyncDirectory(root);
}

export function recoverInterruptedTransaction(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const paths = transactionPaths(resolvedRoot);
  let transactionStat;
  try {
    transactionStat = fs.lstatSync(paths.directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) {
    throw new Error(`${TRANSACTION_DIRECTORY} must be a real directory.`);
  }

  if (!fs.existsSync(paths.owner)) {
    removeEmptyUnownedTransaction(resolvedRoot, paths, transactionStat);
    return [];
  }

  const owner = parseStableJson(paths.owner, TRANSACTION_OWNER);
  validateOwner(owner);
  const ownsTransaction = options.ownerId === owner.ownerId && owner.pid === process.pid;
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const processIdentityLookup = options.processIdentityLookup ?? lookupProcessIdentity;
  if (!ownsTransaction && processAlive(owner.pid)) {
    const liveIdentity = processIdentityLookup(owner.pid);
    if (owner.processIdentity === null || liveIdentity === null || liveIdentity === owner.processIdentity) {
      throw new Error(`Version bump transaction is active in process ${owner.pid}.`);
    }
  }

  if (!fs.existsSync(paths.journal)) {
    fs.rmSync(paths.directory, { recursive: true });
    fsyncDirectory(resolvedRoot);
    return [];
  }

  const journal = parseStableJson(paths.journal, TRANSACTION_JOURNAL);
  validateJournal(journal, owner);
  const conflicts = [];

  for (const entry of journal.entries) {
    const filePath = path.join(resolvedRoot, entry.file);
    const originalPath = path.join(paths.directory, `${entry.index}.original`);
    const displacedPath = path.join(paths.directory, `${entry.index}.displaced`);
    const original = readStableFile(originalPath).contents;
    if (sha256(original) !== entry.originalSha256) {
      throw new Error(`Transaction backup checksum failed for ${entry.file}.`);
    }

    const restorationPath = fs.existsSync(displacedPath) ? displacedPath : originalPath;
    let current;
    try {
      current = readStableFile(filePath).contents;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        linkManifestExclusive(restorationPath, filePath, entry.mode);
      } catch (linkError) {
        if (linkError?.code !== "EEXIST") throw linkError;
        conflicts.push(entry.file);
      }
      continue;
    }

    const currentHash = sha256(current);
    if (currentHash === entry.nextSha256) {
      const rollbackPath = path.join(paths.directory, `${entry.index}.rollback-next`);
      fs.renameSync(filePath, rollbackPath);
      fsyncDirectory(path.dirname(filePath));
      const movedHash = sha256(readStableFile(rollbackPath).contents);
      if (movedHash !== entry.nextSha256) {
        try {
          linkManifestExclusive(rollbackPath, filePath, entry.mode);
        } catch (linkError) {
          if (linkError?.code !== "EEXIST") throw linkError;
        }
        throw new Error(`Manifest changed during version recovery: ${entry.file}`);
      }
      try {
        linkManifestExclusive(restorationPath, filePath, entry.mode);
      } catch (linkError) {
        if (linkError?.code !== "EEXIST") throw linkError;
        conflicts.push(entry.file);
      }
      fs.rmSync(rollbackPath, { force: true });
    } else if (currentHash !== entry.originalSha256) {
      conflicts.push(entry.file);
    }
  }

  fs.rmSync(paths.directory, { recursive: true });
  fsyncDirectory(resolvedRoot);
  return conflicts;
}

function assertManifestUnchanged(item, filePath = item.filePath) {
  const current = readStableFile(filePath);
  if (!sameFileIdentity(current.stat, item.originalStat) || !current.contents.equals(item.original)) {
    throw new Error(`Manifest changed during version preparation: ${item.file}`);
  }
}

function assertCapturedManifestUnchanged(item, capturedPath) {
  const captured = readStableFile(capturedPath);
  if (!sameFileIdentity(captured.stat, item.originalStat) || !captured.contents.equals(item.original)) {
    throw new Error(`Manifest changed at version replacement boundary: ${item.file}`);
  }
}

function linkManifestExclusive(sourcePath, destinationPath, mode) {
  fs.linkSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, mode & 0o777);
  fsyncDirectory(path.dirname(destinationPath));
}

function checkVersions(root, expectedVersion) {
  const mismatches = [];

  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expectedVersion) {
        mismatches.push(`${target.file} ${value.label}: expected ${expectedVersion}, found ${actual ?? "<missing>"}`);
      }
    }
  }

  return mismatches;
}

export function bumpVersion(root, version, options = {}) {
  const resolvedRoot = path.resolve(root);
  const recoveredConflicts = recoverInterruptedTransaction(resolvedRoot);
  if (recoveredConflicts.length > 0) {
    throw new Error(
      `Recovered an interrupted version bump but preserved concurrent edits in: ${recoveredConflicts.join(", ")}. Review them before retrying.`
    );
  }

  const prepared = [];
  for (const target of TARGETS) {
    const filePath = path.join(resolvedRoot, target.file);
    const { contents: original, stat: originalStat } = readStableFile(filePath);
    const json = JSON.parse(original.toString("utf8"));
    const before = JSON.stringify(json);

    for (const value of target.values) {
      value.set(json, version);
    }

    if (JSON.stringify(json) !== before) {
      prepared.push({
        file: target.file,
        filePath,
        original,
        originalStat,
        mode: originalStat.mode,
        next: Buffer.from(`${JSON.stringify(json, null, 2)}\n`)
      });
    }
  }

  if (prepared.length === 0) return [];

  const paths = transactionPaths(resolvedRoot);
  const owner = {
    version: TRANSACTION_VERSION,
    ownerId: randomUUID(),
    pid: process.pid,
    processIdentity: (options.processIdentityLookup ?? lookupProcessIdentity)(process.pid),
    createdAt: new Date().toISOString()
  };

  fs.mkdirSync(paths.directory, { mode: 0o700 });
  fs.chmodSync(paths.directory, 0o700);
  try {
    writeDurableExclusive(paths.owner, `${JSON.stringify(owner, null, 2)}\n`);

    const entries = prepared.map((item, index) => {
      const originalPath = path.join(paths.directory, `${index}.original`);
      const nextPath = path.join(paths.directory, `${index}.next`);
      writeDurableExclusive(originalPath, item.original);
      writeDurableExclusive(nextPath, item.next, item.mode);
      return {
        index,
        file: item.file,
        originalSha256: sha256(item.original),
        nextSha256: sha256(item.next),
        mode: item.mode & 0o777
      };
    });

    const journal = {
      version: TRANSACTION_VERSION,
      ownerId: owner.ownerId,
      entries
    };
    writeDurableExclusive(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncDirectory(paths.directory);
    fsyncDirectory(resolvedRoot);

    const staged = prepared.map((item, index) => ({
      file: item.file,
      filePath: item.filePath,
      tempPath: path.join(paths.directory, `${index}.next`)
    }));
    options.beforeCommit?.(staged);

    for (const [index, item] of prepared.entries()) {
      assertManifestUnchanged(item);
      options.beforeReplace?.({ file: item.file, filePath: item.filePath, index });
      const displacedPath = path.join(paths.directory, `${index}.displaced`);
      const nextPath = path.join(paths.directory, `${index}.next`);
      fs.renameSync(item.filePath, displacedPath);
      fsyncDirectory(path.dirname(item.filePath));
      fsyncDirectory(paths.directory);
      assertCapturedManifestUnchanged(item, displacedPath);
      linkManifestExclusive(nextPath, item.filePath, item.mode);
      options.afterReplace?.({ file: item.file, filePath: item.filePath, index });
    }
  } catch (error) {
    try {
      recoverInterruptedTransaction(resolvedRoot, { ownerId: owner.ownerId });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Version bump failed and automatic recovery did not complete. The durable transaction was preserved."
      );
    }
    throw error;
  }

  fs.rmSync(paths.directory, { recursive: true });
  fsyncDirectory(resolvedRoot);

  return prepared.map((item) => item.file);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.check) {
    const recoveredConflicts = recoverInterruptedTransaction(options.root);
    if (recoveredConflicts.length > 0) {
      throw new Error(
        `Recovered an interrupted version bump but preserved concurrent edits in: ${recoveredConflicts.join(", ")}.`
      );
    }
  }

  const version = options.version ?? (options.check ? readPackageVersion(options.root) : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  if (options.check) {
    const mismatches = checkVersions(options.root, version);
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    console.log(`All version metadata matches ${version}.`);
    return;
  }

  const changedFiles = bumpVersion(options.root, version);
  const touched = changedFiles.length > 0 ? changedFiles.join(", ") : "no files changed";
  console.log(`Set version metadata to ${version}: ${touched}.`);
}

const isDirectInvocation = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectInvocation) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
