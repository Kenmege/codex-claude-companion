---
name: claude-review
description: Use when the user asks Codex to orchestrate Claude for a coding job in another terminal, or to review code, run adversarial or ship/no-ship review, audit security risks, or inspect a large diff/folder.
---

# Claude Review

Use the local helper to route the requested Claude lane. Coding work uses a
writable background worker with Claude's native `agents` panel in a separate
terminal; review lanes snapshot the target, use read-only agentic mode, validate
structured output, and render the result.

## Default command

```bash
codex-claude review -- "$ARGUMENTS"
```

## Route by intent

- Coding or implementation: `codex-claude workspace -- "$ARGUMENTS"`; keep the
  active Codex task in control and supervise with `workspace-status`,
  `workspace-logs`, and `workspace-stop`.
- Everyday diff review: `codex-claude review -- "$ARGUMENTS"`
- Release gate / ship-no-ship: `codex-claude review --preset ship -- "$ARGUMENTS"`
- Security review: `codex-claude review --preset security -- "$ARGUMENTS"`
- Research or evidence-heavy folder: `codex-claude folder <path> --preset research --long-context -- "$ARGUMENTS"`
- Deep multi-agent review: `codex-claude review --preset deep --background -- "$ARGUMENTS"`

## Operating rules

- Keep review workflows read-only. Use the writable `workspace` lane only when
  the user asks for coding or implementation.
- Never launch nested Codex. The active Codex task and its selected model are
  the orchestrator and reviewer.
- Return the helper output verbatim.
- If the helper exits non-zero, report the exact failure and stop.
- For first-run problems, ask the user to run `codex-claude enable` and `codex-claude doctor`.
