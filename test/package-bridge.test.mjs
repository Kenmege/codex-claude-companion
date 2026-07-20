import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the packed public package contains an importable Codex delivery dependency closure", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-package-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", temporary], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120_000
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename, files }] = JSON.parse(packed.stdout);
  assert.equal(
    files.some(({ path: packedPath }) => packedPath.startsWith(".acceptance-")),
    false,
    "repository-local acceptance fixtures must never enter the public package"
  );
  const archive = path.join(temporary, filename);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", temporary], {
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(extracted.status, 0, extracted.stderr);

  const module = await import(pathToFileURL(path.join(
    temporary, "package", "plugins", "codex", "scripts", "lib", "codex.mjs"
  )).href);
  assert.equal(typeof module, "object");

  const brokerEntrypoint = path.join(
    temporary, "package", "plugins", "codex", "scripts", "app-server-broker.mjs"
  );
  assert.equal(
    fs.existsSync(brokerEntrypoint),
    true,
    "the default Codex delivery broker executable must be present in the packed package"
  );
  const syntaxCheck = spawnSync(process.execPath, ["--check", brokerEntrypoint], {
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || syntaxCheck.stdout);
});
