---
description: Dispatch the legacy Claude background workspace lane with its native agents panel.
---

# /claude-review:workspace

> Compatibility lane: use `/claude-review:delegate` for new durable tmux-owned
> jobs with recovery, collaboration, delivery acknowledgement, and independent
> verification.

## Purpose

Keep this Codex task active as the planner, orchestrator, verifier, and reviewer.
Dispatch Claude Code as a writable background worker, then open Claude's native
`agents` control panel in a separate terminal. Claude may edit files, run tools,
and execute tests under its native permission controls. Existing review commands
remain isolated and read-only.

## Preflight

1. Prefer `codex-claude` on PATH; fall back to `codex-claude-review`.
2. Record the branch, `git status --short`, and the repository's real verification
   commands. Preserve all pre-existing user changes.
3. Keep the exact user request as the worker prompt. Never add a permission-bypass
   flag or start another Codex process in this legacy lane.

## Dispatch

Use an explicit option terminator before the coding request so request text that
starts with a dash can never be reinterpreted as a plugin option:

`codex-claude workspace [workspace-flags] -- "<coding request>"`

The command returns the authoritative short Claude session ID immediately.
Claude continues under its background supervisor and its `agents` panel opens
in another terminal. This Codex task must remain responsive; do not attach
Claude to the Codex terminal or wait synchronously for the panel to close.

Claude defaults to the rolling `opus` selector. The user may pass `--model
<selector>` or change models through Claude's native controls. `--plan` is
analysis-only; normal mode is full coding with native approvals. The GPT-side
model is inherited automatically because this active Codex task performs the
orchestration—there is no nested GPT model selection.

## Supervise

1. Poll `codex-claude workspace-status --path <directory> --all --json` at a
   reasonable cadence while continuing to communicate progress.
2. Use `codex-claude workspace-logs <session-id>` only when detail is needed.
3. The user may interact directly in the separate Claude panel. Do not compete
   with user input or overwrite user-owned work.
4. If a focused repair is needed, dispatch it with `codex-claude workspace
   --path <directory> --no-panel -- "<repair request>"` to avoid duplicate
   panels.
5. Use `codex-claude workspace-stop <session-id>` only when the user asks, the
   task is obsolete, or continuing would be unsafe.

## Verify and review

When Claude reports completion:

1. Compare the worktree to the recorded baseline and separate new changes from
   pre-existing work.
2. Inspect the full diff for correctness, security, maintainability, and scope.
3. Run the repository's actual lint, test, typecheck, and build entry points in
   proportion to risk.
4. Review the implementation and evidence using this active Codex model.
5. If a defect is within scope, repair it directly or dispatch a focused Claude
   follow-up, then repeat verification.
6. Report changed files, session ID, verification receipts, remaining risks, and
   that model routing used the active Codex task. Do not claim a specific model
   identity unless the session exposes it.

## Panel recovery

If no supported terminal adapter is available, the worker remains alive. Run:

`claude agents --cwd <directory>`

Use `codex-claude workspace --panel-only --path <directory>` to reopen the panel
without dispatching another worker.
