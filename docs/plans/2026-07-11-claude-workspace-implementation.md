# Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-capability Claude terminal coding workspace with inherited Codex-model supervision, post-work review, and privacy-safe observability while preserving all existing read-only review lanes.

**Architecture:** Extend the existing CLI with a dedicated interactive workspace module. The module builds shell-free Claude and Codex argument arrays, launches Claude with inherited terminal I/O, and optionally runs a non-interactive Codex review after Claude exits. A Codex command file keeps the active Codex session as the preferred orchestrator, which inherently preserves its selected model. Review commands retain their current policy fences.

**Tech Stack:** Node.js ESM, built-in `child_process`, Node test runner, Codex plugin Markdown commands, JSON plugin manifests.

---

### Task 1: Specify workspace behavior with failing unit tests

**Files:**
- Modify: `test/commands.test.mjs`
- Create: `test/workspace.test.mjs`

**Steps:**
1. Add tests for default Claude arguments, explicit model, plan mode, initial prompt, path resolution, continue/resume conflicts, TTY enforcement, and missing executables.
2. Add tests proving Codex review arguments omit model configuration by default and include it only for `--codex-model`.
3. Add tests for privacy-safe human and JSONL lifecycle receipts.
4. Add CLI help/dispatch tests for `workspace` and the `codex-claude` binary alias.
5. Run the focused tests and confirm they fail for missing behavior.

### Task 2: Implement the interactive workspace runtime

**Files:**
- Modify: `scripts/lib/workspace.mjs`
- Modify: `scripts/lib/process.mjs`
- Modify: `scripts/claude-review-companion.mjs`

**Steps:**
1. Add strict workspace option parsing with mutually exclusive continue/resume validation.
2. Build Claude arguments using the rolling `opus` default and native `default` or `plan` permission modes.
3. Add an inherited-stdio process runner with signal forwarding and injectable dependencies.
4. Emit bounded start/exit events without prompt, tool argument, credential, or transcript data.
5. Add optional `codex review --uncommitted`; omit model configuration by default and add `-c model=<selector>` only after an explicit override.
6. Propagate Claude or Codex failure status and actionable missing-binary errors.
7. Run focused tests until green.

### Task 3: Add the Codex supervisor command and write capability metadata

**Files:**
- Create: `commands/workspace.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `package.json`
- Modify: `scripts/validate-repo.mjs`
- Modify: `test/release-docs.test.mjs`

**Steps:**
1. Define `/claude-review:workspace` as an active-session Codex orchestration workflow: baseline, launch, diff inspection, verification, review, and authorized repair loop.
2. Document that the active Codex model is inherited; do not launch a nested interactive Codex TUI.
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
1. Add quick-start examples for full coding, plan mode, session continuation, explicit Claude model selection, and optional standalone Codex review.
2. Explain active/configured Codex model inheritance and the explicit override precedence.
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
