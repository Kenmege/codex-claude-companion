const REDACTION = /\b(?:sk-(?:ant|proj)-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/gi;
const SENSITIVE_KEY = "api[_-]?key|token|secret|password";
// Bare `key: value` / `key=value` form.
const SENSITIVE_ASSIGNMENT = new RegExp(`\\b(${SENSITIVE_KEY})\\s*[:=]\\s*[^\\s,;]+`, "gi");
// Quoted-key JSON/YAML form — `"token": "abc"` / `'secret': 'abc'`. The closing
// quote after the key name defeats SENSITIVE_ASSIGNMENT (which expects the
// separator immediately after the key), so match and redact the quoted value.
// The value body is delimiter-aware: it consumes backslash escapes (`\\.`) and
// any char that is neither a backslash, a line terminator, nor the value's own
// opening quote (`\4`). It then closes on the matching unescaped quote, the end
// of the line, or the end of input — so a value whose closing quote was amputated
// by boundedStream truncation still redacts (to end of line/input) instead of
// leaking. All four ECMAScript line terminators (LF, CR, U+2028 LS, U+2029 PS)
// are excluded from the body and recognized by the line-terminator-lookahead
// close, so an unterminated value on line 1 never consumes a legitimate line 2
// and a backslash before LS/PS can't stall the match (`\\.` cannot consume a
// line terminator without the `s` flag). The close also absorbs a single dangling
// backslash (`\\?`) right before the line or input end, so a value truncated
// mid-escape (`"token":"abc\`) still redacts rather than failing to match — a
// mid-line backslash always pairs with `\\.` so it never closes early. The
// disjoint alternation (backslash vs non-backslash) consumes each character once,
// so there is no backtracking blowup. Terminated values behave exactly as before
// (the `\4` branch consumes the closing quote first).
const SENSITIVE_QUOTED = new RegExp(
  `(["'])(${SENSITIVE_KEY})\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4)[^\\\\\\r\\n\\u2028\\u2029])*(?:\\4|\\\\?(?=[\\r\\n\\u2028\\u2029])|\\\\?$)`,
  "gi"
);

export function redact(value) {
  return String(value ?? "").replace(REDACTION, "[REDACTED]")
    .replace(SENSITIVE_QUOTED, "$1$2$1$3$4[REDACTED]$4")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]");
}
