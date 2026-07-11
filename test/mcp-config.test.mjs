import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_MCP_CONFIG_BYTES,
  readValidatedMcpConfig,
  stageMcpConfigs
} from "../scripts/lib/mcp-config.mjs";

test("MCP validation bounds descriptor bytes even when file metadata is stale", () => {
  const content = Buffer.alloc(MAX_MCP_CONFIG_BYTES + 1, 0x78);
  let cursor = 0;
  let closed = false;
  const fileSystem = {
    openSync: () => 42,
    fstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 64, dev: 1, ino: 1 }),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 1 }),
    realpathSync: (target) => target,
    readSync: (_fd, target, offset, length) => {
      const count = Math.min(length, content.length - cursor);
      if (count <= 0) return 0;
      content.copy(target, offset, cursor, cursor + count);
      cursor += count;
      return count;
    },
    closeSync: () => { closed = true; }
  };

  assert.throws(
    () => readValidatedMcpConfig("/workspace", "mcp.json", { fileSystem }),
    /exceeds 1048576 bytes/
  );
  assert.equal(closed, true, "opened descriptor must close after bounded-read rejection");
});

test("MCP staging preserves validated bytes in private immutable-by-path files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-mcp-source-"));
  const sourcePath = path.join(cwd, "mcp.json");
  const source = JSON.stringify({ mcpServers: { safe: { command: "safe-server" } } });
  fs.writeFileSync(sourcePath, source, { encoding: "utf8", mode: 0o600 });

  const staged = stageMcpConfigs(cwd, ["mcp.json"]);
  try {
    assert.equal(staged.configs.length, 1);
    assert.equal(fs.readFileSync(staged.configs[0], "utf8"), source);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(staged.tempRoots[0]).mode & 0o777, 0o700);
      assert.equal(fs.statSync(staged.configs[0]).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    for (const tempRoot of staged.tempRoots) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("MCP validation rejects absolute paths outside the workspace", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-mcp-workspace-"));
  const outside = path.join(os.tmpdir(), `codex-claude-mcp-outside-${process.pid}.json`);
  fs.writeFileSync(outside, '{"mcpServers":{"unsafe":{"command":"outside"}}}', "utf8");
  try {
    assert.throws(
      () => readValidatedMcpConfig(cwd, outside),
      /Invalid --mcp-config path/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("MCP validation never follows a workspace symlink", { skip: process.platform === "win32" }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-mcp-workspace-"));
  const outside = path.join(os.tmpdir(), `codex-claude-mcp-outside-${process.pid}.json`);
  fs.writeFileSync(outside, '{"mcpServers":{"unsafe":{"command":"outside"}}}', "utf8");
  fs.symlinkSync(outside, path.join(cwd, "mcp.json"));
  try {
    assert.throws(
      () => readValidatedMcpConfig(cwd, "mcp.json"),
      /Invalid --mcp-config path/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("MCP staging removes its temp root when permission hardening fails", () => {
  let removedPath = null;
  const fileSystem = {
    mkdtempSync: () => "/tmp/codex-claude-mcp-failed",
    chmodSync: () => {
      throw new Error("chmod denied");
    },
    rmSync: (target, options) => {
      removedPath = target;
      assert.deepEqual(options, { recursive: true, force: true });
    }
  };

  assert.throws(
    () => stageMcpConfigs("/workspace", ['{"mcpServers":{"safe":{"command":"safe"}}}'], { fileSystem }),
    /chmod denied/
  );
  assert.equal(removedPath, "/tmp/codex-claude-mcp-failed");
});
