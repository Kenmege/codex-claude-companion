import test from "node:test";
import assert from "node:assert/strict";

import { redact } from "../scripts/lib/redact.mjs";

test("redact scrubs quoted-key JSON secret fields (double and single quoted)", () => {
  const doubleQuoted = redact('{"token": "abc123def", "keep": "visible"}');
  assert.doesNotMatch(doubleQuoted, /abc123def/);
  assert.match(doubleQuoted, /"token": "\[REDACTED\]"/);
  assert.match(doubleQuoted, /"keep": "visible"/);

  const singleQuoted = redact("{'secret': 'shh-9021'}");
  assert.doesNotMatch(singleQuoted, /shh-9021/);
  assert.match(singleQuoted, /'secret': '\[REDACTED\]'/);

  const apiKey = redact('{"api_key":"k-7788","api-key":"k-9900"}');
  assert.doesNotMatch(apiKey, /k-7788/);
  assert.doesNotMatch(apiKey, /k-9900/);
  assert.match(apiKey, /"api_key":"\[REDACTED\]"/);
  assert.match(apiKey, /"api-key":"\[REDACTED\]"/);
});

test("redact still scrubs bare assignment and token-prefixed secrets", () => {
  assert.match(redact("token=abc123"), /token=\[REDACTED\]/);
  assert.match(redact("password: hunter2"), /password=\[REDACTED\]/);
  assert.match(redact("Authorization: Bearer sk-ant-xyz123"), /\[REDACTED\]/);
  assert.doesNotMatch(redact("Authorization: Bearer sk-ant-xyz123"), /sk-ant-xyz123/);
});

test("redact scrubs quoted values whose contents contain quotes or escapes", () => {
  // Double-quoted value containing an apostrophe.
  const apostrophe = redact('{"token":"abc\'def"}');
  assert.doesNotMatch(apostrophe, /abc'def/);
  assert.match(apostrophe, /"token":"\[REDACTED\]"/);

  // Value containing an escaped double quote — the suffix must not survive.
  const escapedQuote = redact('{"token":"abc\\"suffix"}');
  assert.doesNotMatch(escapedQuote, /abc/);
  assert.doesNotMatch(escapedQuote, /suffix/);
  assert.match(escapedQuote, /"token":"\[REDACTED\]"/);

  // Value containing backslashes (Windows path style) — fully redacted.
  const backslashes = redact('{"token":"C:\\\\Users\\\\x"}');
  assert.doesNotMatch(backslashes, /Users/);
  assert.match(backslashes, /"token":"\[REDACTED\]"/);

  // Single-quoted value containing a double quote.
  const singleWithDouble = redact("{'token':'a\"b'}");
  assert.doesNotMatch(singleWithDouble, /a"b/);
  assert.match(singleWithDouble, /'token':'\[REDACTED\]'/);
});

test("redact scrubs an unterminated quoted secret to end of line/input", () => {
  // Exact probe: boundedStream truncation amputated the closing quote.
  const unterminated = redact('"token": "prefix UNTERM_SUFFIX');
  assert.doesNotMatch(unterminated, /UNTERM_SUFFIX/);
  assert.doesNotMatch(unterminated, /prefix/);
  assert.match(unterminated, /"token": "\[REDACTED\]/);

  // Truncated JSON tail — the secret's closing quote was cut off.
  const truncated = redact('{"a":1,"secret":"cut-off-secret-tail');
  assert.doesNotMatch(truncated, /cut-off-secret-tail/);
  assert.match(truncated, /"secret":"\[REDACTED\]/);
});

test("redact bounds an unterminated secret to its own line, sparing line 2", () => {
  const input = '{"token":"LINE1_SECRET\nkeep_line_2":"visible"}';
  const out = redact(input);
  // No portion of the line-1 secret survives.
  assert.doesNotMatch(out, /LINE1_SECRET/);
  assert.match(out, /"token":"\[REDACTED\]"/);
  // Line 2 is untouched — the newline-lookahead close never consumes it.
  assert.match(out, /\nkeep_line_2":"visible"}/);
});

test("redact closes a raw-newline value at the newline (documented decision)", () => {
  // A value split by a RAW newline redacts line 1 and closes at the newline;
  // the line-2 remainder is treated as separate line content (see SENSITIVE_QUOTED).
  // Real JSON escapes newlines as \\n, which the escape branch redacts wholly.
  const out = redact('{"token":"abc\ndef"}');
  assert.doesNotMatch(out, /abc/);
  assert.match(out, /"token":"\[REDACTED\]"/);
  assert.equal(out, '{"token":"[REDACTED]"\ndef"}');
});

test("redact scrubs a value truncated mid-escape at a dangling backslash", () => {
  // Exact probe: truncation left a lone trailing backslash as the last byte.
  const danglingEoi = redact('"token":"abc\\');
  assert.doesNotMatch(danglingEoi, /abc/);
  assert.match(danglingEoi, /"token":"\[REDACTED\]"/);

  // Dangling backslash immediately before a CRLF, with a legit second line.
  const danglingCrlf = redact('"token":"abc\\\r\nlegit_line_2');
  assert.doesNotMatch(danglingCrlf, /abc/);
  assert.match(danglingCrlf, /"token":"\[REDACTED\]"/);
  assert.match(danglingCrlf, /\r\nlegit_line_2/);
});

test("redact closes an unterminated value at a lone CR line terminator", () => {
  // A standalone CR (no LF) is an ECMAScript line terminator; a downstream trim()
  // would strip it and keep any leaked secret, so the close must fire before it.
  const crEoi = redact('"token":"CR_SECRET\r');
  assert.doesNotMatch(crEoi, /CR_SECRET/);
  assert.doesNotMatch(crEoi.trim(), /CR_SECRET/);
  assert.match(crEoi, /"token":"\[REDACTED\]"/);

  // Text following a lone CR must survive byte-intact.
  const crThenText = redact('"token":"CR_SECRET\rnext line text');
  assert.doesNotMatch(crThenText, /CR_SECRET/);
  assert.match(crThenText, /"token":"\[REDACTED\]"/);
  assert.match(crThenText, /\rnext line text$/);
});

test("redact closes LF and CRLF terminators identically", () => {
  assert.equal(redact('"token":"LF_SECRET\nline2'), '"token":"[REDACTED]"\nline2');
  assert.equal(redact('"token":"CRLF_SECRET\r\nline2'), '"token":"[REDACTED]"\r\nline2');
});

test("redact closes at U+2028/U+2029 separators, including after a backslash", () => {
  const LS = " ";
  const PS = " ";

  // Backslash immediately before LS: `\\.` cannot consume a line terminator, so
  // the dangling-backslash close must fire; no part of the secret survives.
  const backslashLs = redact(`"token":"LS_ESCAPE_SECRET\\${LS}`);
  assert.doesNotMatch(backslashLs, /LS_ESCAPE_SECRET/);
  assert.equal(backslashLs, `"token":"[REDACTED]"${LS}`);

  // Plain LS mid-value (unterminated) closes at the separator; the following
  // segment survives byte-intact.
  const plainLs = redact(`"token":"SECRET_A${LS}following_segment`);
  assert.doesNotMatch(plainLs, /SECRET_A/);
  assert.equal(plainLs, `"token":"[REDACTED]"${LS}following_segment`);

  // Plain PS mid-value behaves the same.
  const plainPs = redact(`"token":"SECRET_B${PS}following_segment`);
  assert.doesNotMatch(plainPs, /SECRET_B/);
  assert.equal(plainPs, `"token":"[REDACTED]"${PS}following_segment`);

  // LF / CR / CRLF remain byte-identical alongside the added separators.
  assert.equal(redact('"token":"LF_S\nline2'), '"token":"[REDACTED]"\nline2');
  assert.equal(redact('"token":"CR_S\r'), '"token":"[REDACTED]"\r');
  assert.equal(redact('"token":"CRLF_S\r\nline2'), '"token":"[REDACTED]"\r\nline2');
});

test("redact behavior for terminated values is byte-identical", () => {
  // Interior-escape values must still close on their own quote exactly as before.
  assert.equal(redact('{"token":"abc\\"suffix"}'), '{"token":"[REDACTED]"}');
  // Terminated values must close on the matching quote exactly as before.
  assert.equal(redact('{"token": "abc123def"}'), '{"token": "[REDACTED]"}');
  assert.equal(redact("{'secret':'shh-9021'}"), "{'secret':'[REDACTED]'}");
  assert.equal(redact('{"token":"abc\'def"}'), '{"token":"[REDACTED]"}');
  assert.equal(redact('{"token":"C:\\\\Users\\\\x"}'), '{"token":"[REDACTED]"}');
});

test("redact does not backtrack catastrophically on long backslash runs", () => {
  const evil = `{"token":"${"\\".repeat(20000)}no-closing-quote`;
  const start = process.hrtime.bigint();
  redact(evil);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 250, `redact took ${elapsedMs}ms on a pathological input`);
});

test("redact leaves ordinary prose and non-secret keys untouched", () => {
  const prose = "the token bucket refilled and the secret handshake completed";
  assert.equal(redact(prose), prose);
  assert.equal(redact('{"tokens":[1,2,3]}'), '{"tokens":[1,2,3]}');
  assert.equal(redact('{"name":"tokenizer"}'), '{"name":"tokenizer"}');
});
