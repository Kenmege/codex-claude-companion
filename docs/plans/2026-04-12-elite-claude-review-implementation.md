# Elite Claude Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new `elite-review` review lane with a richer structured output contract and stronger adversarial prompting while preserving the existing review commands.

**Architecture:** Extend the current command router with a third review kind, branch schema/rendering by review kind, and keep the same state/job system. Fix working-tree collection to exclude `.claude-review/` artifacts so the tool does not review its own persisted jobs.

**Tech Stack:** Node.js ESM, local Claude CLI, git diff context collection, Node test runner.

---

### Task 1: Add elite command and schema plumbing

**Files:**
- Modify: `scripts/claude-review-companion.mjs`
- Create: `schemas/elite-review-output.schema.json`

**Step 1: Add failing expectations in tests for elite command usage and dispatch**

Update command-facing tests to expect `elite-review` in the CLI surface.

**Step 2: Add elite schema file**

Create a dedicated schema covering executive summary, systemic risks, rich findings, blind spots, and next steps.

**Step 3: Wire command parsing**

Add `elite-review` to usage text, command dispatch, job naming, and schema selection.

**Step 4: Run targeted tests**

Run: `node --test test/commands.test.mjs test/claude.test.mjs -v`

**Step 5: Verify**

Expected: elite command is recognized and schema path resolves cleanly.

### Task 2: Add elite prompting and rendering

**Files:**
- Modify: `scripts/lib/claude.mjs`
- Modify: `scripts/lib/render.mjs`

**Step 1: Add elite prompt contract**

Implement a dedicated elite prompt that forces high-level architecture scrutiny plus low-level failure-mode review.

**Step 2: Add elite rendering path**

Render executive summary, ship recommendation, systemic risks, blind spots, and richer finding fields.

**Step 3: Keep standard rendering unchanged**

Ensure `review` and `adversarial-review` keep their current output shape.

**Step 4: Run targeted tests**

Run: `node --test test/claude.test.mjs -v`

**Step 5: Verify**

Expected: existing review rendering still works and elite results render distinctly.

### Task 3: Exclude `.claude-review` artifacts from working-tree context

**Files:**
- Modify: `scripts/lib/git.mjs`
- Modify: `test/git.test.mjs`

**Step 1: Add failing regression test**

Create a repo fixture with both source changes and `.claude-review/jobs/*` artifacts.

**Step 2: Filter internal tool artifacts**

Exclude `.claude-review/` entries from staged, unstaged, and untracked review context.

**Step 3: Run targeted tests**

Run: `node --test test/git.test.mjs -v`

**Step 4: Verify**

Expected: collected review context includes only user/source changes.

### Task 4: Document and verify full behavior

**Files:**
- Modify: `README.md`
- Modify: `commands/review.md`
- Modify: `commands/adversarial-review.md`
- Create: `commands/elite-review.md`
- Modify: `scripts/validate-repo.mjs`

**Step 1: Document elite mode**

Describe the new lane in README and add the slash command doc.

**Step 2: Update repository validation**

Require the new command doc and schema file.

**Step 3: Run full verification**

Run:
- `npm run lint`
- `npm test`
- `npm run check`

**Step 4: Live verification**

Run:
- `codex-claude-review setup`
- `codex-claude-review elite-review --cwd <temp-repo>`
- `codex-claude-review elite-review --background --cwd <temp-repo>`
- `codex-claude-review status --cwd <temp-repo> <job-id>`
- `codex-claude-review result --cwd <temp-repo> <job-id>`

**Step 5: Verify**

Expected: elite mode works foreground and background, and status/result handle elite jobs cleanly.
