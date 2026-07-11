# Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-capability split-terminal Claude coding workspace that leaves the active Codex session in control, with background-worker supervision, post-work review, and privacy-safe observability while preserving all existing read-only review lanes.

**Architecture:** Extend the existing CLI with a dedicated workspace control-plane module. It dispatches Claude as a native background worker, opens Claude's agent view in a separate terminal, returns the worker session identifier immediately, and exposes status/log/stop controls for the still-active Codex session. No nested Codex process is launched; the current Codex task and its selected model remain the orchestrator. Review commands retain their current policy fences.

**Tech Stack:** Node.js ESM, built-in `child_process`, Node test runner, Codex plugin Markdown commands, JSON plugin manifests.

---

### Task 1: Specify workspace behavior with failing unit tests

**Files:**
- Modify: `test/commands.test.mjs`
- Create: `test/workspace.test.mjs`

**Steps:**
1. Add tests for background-worker arguments, explicit model, plan mode, initial prompt, path resolution, session IDs, panel-only/no-panel validation, and missing executables.
2. Add tests for agent-panel arguments and macOS, tmux, and Linux terminal backend selection.
3. Add tests for privacy-safe human and JSONL dispatch/panel receipts.
4. Add CLI help/dispatch tests for `workspace`, `workspace-status`, `workspace-logs`, `workspace-stop`, and the `codex-claude` binary alias.
5. Run the focused tests and confirm they fail for missing behavior.

### Task 2: Implement the split-terminal workspace runtime

**Files:**
- Modify: `scripts/lib/workspace.mjs`
- Modify: `scripts/lib/process.mjs`
- Modify: `scripts/claude-review-companion.mjs`

**Steps:**
1. Add strict workspace option parsing with panel-only/no-panel validation.
2. Build Claude background-worker arguments using the rolling `opus` default, a generated UUID, and native `default` or `plan` permission modes.
3. Build the filtered Claude agent-view command for the separate control terminal.
4. Add permission-restricted launcher generation plus macOS Terminal, existing-tmux, and Linux terminal adapters.
5. Emit bounded dispatch/panel events without prompt, tool argument, credential, or transcript data.
6. Add status, logs, and stop passthrough commands for active Codex supervision.
7. Return the worker session identifier immediately; never launch a nested Codex process.
7. Run focused tests until green.

### Task 3: Add the Codex supervisor command and write capability metadata

**Files:**
- Create: `commands/workspace.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `package.json`
- Modify: `scripts/validate-repo.mjs`
- Modify: `test/release-docs.test.mjs`

**Steps:**
1. Define `/claude-review:workspace` as an active-session Codex orchestration workflow: baseline, dispatch, status polling, diff inspection, verification, review, and authorized repair loop.
2. Document that the active Codex model is inherited and remains responsive; do not launch any nested Codex process.
3. Add `codex-claude` as a non-breaking binary alias.
4. Change plugin metadata from review-only to coding plus review and advertise `Write` capability.
5. Require the new command in repository validation and update trust-metadata tests.

### Task 4: Update user and architecture documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `CHANGELOG.md`
- Modify: `RELEASE_NOTES_v1.0.14.md`

**Steps:**
1. Add quick-start examples for full coding, plan mode, separate control panel, explicit Claude model selection, status/log/stop controls, and panel-free repair dispatch.
2. Explain active Codex model inheritance and why the workspace never starts a nested GPT-side reviewer.
3. Document native approval prompts and the absence of a bypass shortcut.
4. Document observability fields, exclusions, and JSONL usage.
5. Preserve clear separation between writable workspace and existing read-only review lanes.

### Task 5: Verify the complete plugin

**Files:**
- Verify: all changed files

**Steps:**
1. Run `node --test test/workspace.test.mjs test/commands.test.mjs test/release-docs.test.mjs`.
2. Run `npm run check`.
3. Run `npm pack --dry-run` and inspect the package file list for the new command and runtime module.
4. Run `npm audit --omit=dev --audit-level=moderate`.
5. Run the plugin validator from the installed plugin-creator skill.
6. Inspect `git diff --check` and the final diff for accidental prompt or credential logging.
7. Commit the implementation without publishing, pushing, or creating a public release.
