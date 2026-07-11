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
    fstatSync: () => ({ isFile: () => true, size: 64 }),
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

  const staged = stageMcpConfigs(cwd, [sourcePath]);
  try {
    assert.equal(staged.configs.length, 1);
    assert.equal(fs.readFileSync(staged.configs[0], "utf8"), source);
    assert.equal(fs.statSync(staged.tempRoots[0]).mode & 0o777, 0o700);
    assert.equal(fs.statSync(staged.configs[0]).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    for (const tempRoot of staged.tempRoots) fs.rmSync(tempRoot, { recursive: true, force: true });
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
