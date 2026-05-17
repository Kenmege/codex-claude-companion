import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../scripts/lib/args.mjs";

test("parseArgs handles booleans, values, and positionals", () => {
  const parsed = parseArgs(["--background", "--base", "main", "focus", "text"], {
    booleanOptions: ["background"],
    valueOptions: ["base"]
  });
  assert.equal(parsed.options.background, true);
  assert.equal(parsed.options.base, "main");
  assert.deepEqual(parsed.positionals, ["focus", "text"]);
});

test("parseArgs accumulates repeated value options", () => {
  const parsed = parseArgs(["--exclude", "dist", "--exclude=private", "--mcp-config", "a.json", "--mcp-config", "b.json"], {
    valueOptions: ["exclude", "mcp-config"],
    repeatableValueOptions: ["exclude", "mcp-config"]
  });

  assert.deepEqual(parsed.options.exclude, ["dist", "private"]);
  assert.deepEqual(parsed.options["mcp-config"], ["a.json", "b.json"]);
});

test("parseArgs rejects duplicated single-value options", () => {
  assert.throws(() => {
    parseArgs(["--cwd", "one", "--cwd", "two"], {
      valueOptions: ["cwd"]
    });
  }, /Duplicate --cwd/);
});

test("splitRawArgumentString keeps quoted groups together", () => {
  assert.deepEqual(splitRawArgumentString('--base main "look for race conditions"'), [
    "--base",
    "main",
    "look for race conditions"
  ]);
});
