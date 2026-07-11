import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../scripts/lib/args.mjs";

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

test("parseArgs accepts only exact inline boolean literals", () => {
  const enabled = parseArgs(["--unrestricted=true"], { booleanOptions: ["unrestricted"] });
  const disabled = parseArgs(["--unrestricted=false"], { booleanOptions: ["unrestricted"] });

  assert.equal(enabled.options.unrestricted, true);
  assert.equal(disabled.options.unrestricted, false);
  assert.throws(
    () => parseArgs(["--unrestricted=flase"], { booleanOptions: ["unrestricted"] }),
    /Invalid --unrestricted boolean value/i
  );
  assert.throws(
    () => parseArgs(["--unrestricted="], { booleanOptions: ["unrestricted"] }),
    /Invalid --unrestricted boolean value/i
  );
});

test("parseArgs rejects missing or option-like separate values", () => {
  const cases = [
    ["--base"],
    ["--base", "--"],
    ["--base", "--quiet"],
    ["--base", "-unexpected"],
    ["-b"],
    ["--exclude", "--quiet"]
  ];

  for (const argv of cases) {
    assert.throws(
      () => parseArgs(argv, {
        booleanOptions: ["quiet"],
        valueOptions: ["base", "exclude"],
        repeatableValueOptions: ["exclude"],
        aliasMap: { b: "base" }
      }),
      /requires a value/i,
      argv.join(" ")
    );
  }

  assert.equal(
    parseArgs(["--base=-topic"], { valueOptions: ["base"] }).options.base,
    "-topic"
  );
});

test("parseArgs records where the option terminator moved input into positional data", () => {
  const parsed = parseArgs(["before", "--", "--fix", "support", "--json"], {
    booleanOptions: ["json"]
  });

  assert.deepEqual(parsed.positionals, ["before", "--fix", "support", "--json"]);
  assert.equal(parsed.optionTerminatorIndex, 1);
  assert.equal(parsed.options.json, undefined);
});

test("parseArgs preserves every equals sign in inline values", () => {
  const parsed = parseArgs([
    "--system-prompt-extra=a=b=c",
    "--mcp-config={\"url\":\"https://example.test/?a=b=c\"}"
  ], {
    valueOptions: ["system-prompt-extra", "mcp-config"],
    repeatableValueOptions: ["mcp-config"]
  });

  assert.equal(parsed.options["system-prompt-extra"], "a=b=c");
  assert.equal(parsed.options["mcp-config"], "{\"url\":\"https://example.test/?a=b=c\"}");
});
