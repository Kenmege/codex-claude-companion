import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_MCP_CONFIG_BYTES = 1024 * 1024;

function coerceMultiValue(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function hasParentTraversalSegment(value) {
  return String(value)
    .split(/[\\/]+/)
    .some((segment) => segment === "..");
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function parseMcpConfigJson(source, label) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid --mcp-config ${label}: JSON parse failed (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid --mcp-config ${label}: expected a JSON object`);
  }
  const serverContainer = parsed.mcpServers ?? parsed.servers;
  if (serverContainer != null && (typeof serverContainer !== "object" || Array.isArray(serverContainer))) {
    throw new Error(`Invalid --mcp-config ${label}: mcpServers/servers must be an object`);
  }
  if (serverContainer == null && !Object.values(parsed).some((value) => value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error(`Invalid --mcp-config ${label}: no server definitions found`);
  }
  return parsed;
}

export function readMcpConfigBytes(fd, raw, fileSystem = fs) {
  const buffer = Buffer.alloc(MAX_MCP_CONFIG_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fileSystem.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
    if (count === 0) break;
    bytesRead += count;
  }
  if (bytesRead > MAX_MCP_CONFIG_BYTES) {
    throw new Error(`Invalid --mcp-config path: ${raw} exceeds ${MAX_MCP_CONFIG_BYTES} bytes`);
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
}

export function readValidatedMcpConfig(cwd, value, { fileSystem = fs } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("--mcp-config requires a non-empty file path or JSON object");
  }
  if (raw.startsWith("{")) {
    if (Buffer.byteLength(raw, "utf8") > MAX_MCP_CONFIG_BYTES) {
      throw new Error(`Invalid --mcp-config inline JSON exceeds ${MAX_MCP_CONFIG_BYTES} bytes`);
    }
    parseMcpConfigJson(raw, "inline JSON");
    return raw;
  }
  if (raw.includes("\0") || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || hasParentTraversalSegment(raw)) {
    throw new Error(`Invalid --mcp-config path: ${raw}`);
  }

  const workspaceRoot = path.resolve(cwd);
  const resolved = path.resolve(workspaceRoot, raw);
  if (!isWithin(workspaceRoot, resolved)) {
    throw new Error(`Invalid --mcp-config path: ${raw}`);
  }

  let fd;
  let source;
  try {
    fd = fileSystem.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fileSystem.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Invalid --mcp-config path: ${raw} is not a file`);
    }
    const pathStat = fileSystem.lstatSync(resolved);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFileIdentity(stat, pathStat)) {
      throw new Error(`Invalid --mcp-config path: ${raw} must be a real workspace file`);
    }
    const canonicalRoot = fileSystem.realpathSync(workspaceRoot);
    const canonicalPath = fileSystem.realpathSync(resolved);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw new Error(`Invalid --mcp-config path: ${raw} escapes the workspace`);
    }
    if (stat.size > MAX_MCP_CONFIG_BYTES) {
      throw new Error(`Invalid --mcp-config path: ${raw} exceeds ${MAX_MCP_CONFIG_BYTES} bytes`);
    }
    source = readMcpConfigBytes(fd, raw, fileSystem);
  } catch (error) {
    if (error?.message?.startsWith("Invalid --mcp-config")) throw error;
    throw new Error(`Invalid --mcp-config path: ${raw} (${error.message})`, { cause: error });
  } finally {
    if (fd !== undefined) fileSystem.closeSync(fd);
  }
  parseMcpConfigJson(source, raw);
  return source;
}

export function stageMcpConfigs(cwd, values, { fileSystem = fs, tempDirectory = os.tmpdir() } = {}) {
  const sources = coerceMultiValue(values).map((value) => readValidatedMcpConfig(cwd, value, { fileSystem }));
  if (sources.length === 0) return { configs: [], tempRoots: [] };

  const tempRoot = fileSystem.mkdtempSync(path.join(tempDirectory, "codex-claude-mcp-"));
  try {
    fileSystem.chmodSync(tempRoot, 0o700);
    const configs = sources.map((source, index) => {
      const stagedPath = path.join(tempRoot, `config-${index}.json`);
      fileSystem.writeFileSync(stagedPath, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return stagedPath;
    });
    return { configs, tempRoots: [tempRoot] };
  } catch (error) {
    fileSystem.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
