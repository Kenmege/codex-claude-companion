#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TARGET_PACKAGE = "codex-claude-companion";
const require = createRequire(import.meta.url);
const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));

function fail(message, error) {
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  process.stderr.write(`codex-plugin-cc migration shim: ${message}${detail}\n`);
  process.exitCode = 1;
}

let packagePath;
try {
  packagePath = require.resolve(`${TARGET_PACKAGE}/package.json`);
} catch (error) {
  fail(`cannot find ${TARGET_PACKAGE}; run npm install -g ${TARGET_PACKAGE}`, error);
}

if (packagePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const relativeBin = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin?.["codex-claude"];
    if (!relativeBin) {
      throw new Error(`${TARGET_PACKAGE} does not expose the codex-claude executable`);
    }

    const targetFile = fs.realpathSync(path.resolve(path.dirname(packagePath), relativeBin));
    if (targetFile === thisFile) {
      throw new Error("refusing recursive self-invocation");
    }

    process.stderr.write(
      `NOTICE: codex-plugin-cc has moved to ${TARGET_PACKAGE}. ` +
      `Install it with: npm install -g ${TARGET_PACKAGE}\n`
    );

    const child = spawn(process.execPath, [targetFile, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    });
    const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };
    for (const signal of forwardedSignals) {
      const handler = () => {
        if (!child.killed) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once("error", (error) => {
      cleanup();
      fail(`failed to launch ${TARGET_PACKAGE}`, error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    fail(`cannot launch ${TARGET_PACKAGE}`, error);
  }
}
