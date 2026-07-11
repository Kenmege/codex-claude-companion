---
description: Run a security-focused agentic Claude review against the current git workspace.
---

# /claude-review:security-review

## Preflight

1. Prefer the helper binary `codex-claude` if it is available on PATH.
2. If it is not available, tell the user to install the helper with
   `npm install -g codex-plugin-cc` after npmjs publish, or from a cloned
   checkout with `npm install -g .`.

## Plan

Runs an agentic Claude pass focused entirely on security risks: authz/authn
bypass, injection (SQL/XSS/command/template/SSTI), SSRF, deserialization, path
traversal, secret leakage, weak crypto, TLS misuse, race conditions in security
checks, privilege escalation, and dependency CVEs.

Findings are mapped to OWASP/CWE in `risk_category` and classified by
`exploitability` (pre-auth-remote, post-auth-remote, local, requires-misconfig).
Dependency CVE claims are verified against the workspace lockfiles before
being reported.

Default model is Claude Code's `opus` alias at `xhigh` effort.

## Commands

Use the exact argument tail the user supplied after
`/claude-review:security-review`.

- Preferred:
  `codex-claude security-review <user-arguments>`

Useful flags:

- `--background` for large diffs.
- `--mcp-config <file-or-json>` to attach a CVE/security MCP.
- `--max-budget-usd <n>` to cap spend.
- `--add-dir <path>` to grant tool access to monorepo siblings or vendored
  source directories.

Keep this command read-only.

## Verification

If the helper exits non-zero, report that failure exactly and stop.

## Summary

Return the helper stdout verbatim.

## Next Steps

For a broader code-quality pass, suggest `/claude-review:elite-review` or
`/claude-review:deep-review`.
