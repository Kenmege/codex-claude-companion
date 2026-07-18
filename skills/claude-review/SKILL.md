---
name: claude-review
description: Use when the user asks Codex to orchestrate Claude for a coding job in another terminal, or to review code, run adversarial or ship/no-ship review, audit security risks, or inspect a large diff/folder.
---

# Claude Review

Use the local helper to route the requested Claude lane. New coding work uses a
durable tmux-owned bridge worker with recorded collaboration, recovery, delivery,
and independent verification. The older workspace lane remains available for
compatibility. Review lanes snapshot the target, use read-only agentic mode,
validate structured output, and render the result.

## Default command

```bash
codex-claude review -- "$ARGUMENTS"
```

## Route by intent

- Coding or implementation: `codex-claude delegate --verify-command '<JSON argv>'
  -- "$ARGUMENTS"`; keep the active Codex task responsive and supervise the
  returned `ccb_...` job with `wait`, `status`, `logs`, `send`, and `recover`.
- Legacy interactive workspace: `codex-claude workspace -- "$ARGUMENTS"`; use
  `workspace-status`, `workspace-logs`, and `workspace-stop`.
- Everyday diff review: `codex-claude review -- "$ARGUMENTS"`
- Release gate / ship-no-ship: `codex-claude review --preset ship -- "$ARGUMENTS"`
- Security review: `codex-claude review --preset security -- "$ARGUMENTS"`
- Research or evidence-heavy folder: `codex-claude folder <path> --preset research --long-context -- "$ARGUMENTS"`
- Deep multi-agent review: `codex-claude review --preset deep --background -- "$ARGUMENTS"`

## Operating rules

- Keep review workflows read-only. Use a writable bridge or workspace lane only
  when the user asks for coding or implementation.
- Require an origin-supplied repository-native verification command for every
  delegation. Do not accept a worker-chosen command as independent verification.
- Treat `trusted-autonomous` as explicit cooperative same-UID host trust, not a
  sandbox. Never claim `sandbox-autonomous` is available.
- The bridge may launch ephemeral Codex for independent verification. Do not
  hardcode a GPT model or claim the worker verified itself independently.
- Return the helper output verbatim.
- If the helper exits non-zero, report the exact failure and stop.
- For first-run problems, ask the user to run `codex-claude enable` and `codex-claude doctor`.
