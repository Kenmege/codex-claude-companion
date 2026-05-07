# Codex Elite Ship Prompt — `codex-plugin-cc` v0.2.1 → v1.0.0

> **How to use**: paste this entire file as the first prompt in a fresh
> `codex` session from the repository root. Run with
> `codex -c model_reasoning_effort=high` (GPT-5.5 senior-gate config). Codex
> has full file write + bash + apply-patch authority; act as PM, not just
> reviewer.

---

## Your role

You are Codex (GPT-5.5, high reasoning effort). You are the senior gate
reviewer **and** lead implementer on this run. Your job is to take this
repo from "tests pass" to **"v1.0.0 truly shippable, production-grade,
genuinely elite."** No green-rubber-stamp. No green-light cosmetic polish.
Find anything still wrong. Fix it. Then ship it.

You have full authority to:

- Edit any file in this repo.
- Run `npm run check`, `npm test`, `npm run lint` as many times as needed.
- Add new files (CHANGELOG.md, SECURITY.md, CONTRIBUTING.md, etc.).
- Bump the version (`package.json` and `.codex-plugin/plugin.json` to
  `1.0.0` once acceptance criteria are met; `0.3.0` if you decide a
  pre-1.0 release is warranted instead — justify in the CHANGELOG).
- Refactor for clarity. Do **not** weaken tests to pass. Do **not** add
  `--no-verify`, do **not** disable hooks.

You do **not** have authority to:

- Touch user OAuth/auth files outside the repo.
- Push to git or open PRs unless explicitly directed at the end.
- Run network mutations beyond `npm install --no-save` for type stubs (no
  publish, no remote git ops).
- Trust me. Default to skepticism. The implementer (Claude Opus) is
  competent but not infallible.

---

## Repo context

- **Path**: repository root
- **Purpose**: Codex CLI plugin that lets a Codex session invoke Claude
  (Opus 4.7 / Sonnet 4.6) for adversarial code review of Codex/GPT-generated
  changes. Reverse-direction port of `openai/codex-plugin-cc`.
- **Runtime**: Node.js ≥ 18.18, ESM (`type: "module"`), zero runtime deps.
- **Auth model**: this Mac Mini runs on Anthropic Max subscription;
  `ANTHROPIC_API_KEY` is hook-blocked. The plugin must work cleanly under
  subscription auth and degrade gracefully where Anthropic features are
  api-key-only (`--max-budget-usd`, `--betas`, `--fallback-model`).

### Story so far (uncommitted on `main`)

- **v0.1.0** (committed): structured-output-only reviewer running Claude
  with `--tools ""` (no agent capability). Three lanes: review,
  adversarial-review, elite-review.
- **v0.2.0** (uncommitted, then superseded): agentic refactor. Default
  `--tools` opened up to `Read,Glob,Grep,Bash,Task,WebFetch,WebSearch`.
  Bash allowlist was a fenced prefix matcher: `Bash(git diff:*) Bash(cat:*)
  Bash(rg:*)…`. New lanes: `deep-review`, `security-review`. New schema
  `agentic-review-output.schema.json` requiring `evidence[]`. Default model
  bumped `claude-opus-4-6` → `claude-opus-4-7`. 27/27 tests passed but the
  build was **NO_SHIP** per dual adversarial review (Opus + Codex GPT-5.5).
- **v0.2.1** (uncommitted, current working tree): hardening pass. All
  convergent reviewer findings fixed:
  1. Removed shell-duplicate Bash entries (`cat/head/tail/find/ls/grep/rg/wc`,
     plus raw `git`). Added single `scripts/bin/git-safe.mjs` wrapper with
     subcommand allowlist + arg validation (rejects `--no-index`, abs paths
     outside cwd, `..`, shell metachars, `-c`/`-C`/`--exec-path`/`--git-dir`/
     `--upload-pack`/`--receive-pack`; scrubs `GIT_DIR`/`GIT_WORK_TREE` env).
  2. `assertAllowedPermissionMode` whitelist `[default, plan]`. Rejects
     `bypassPermissions`, `acceptEdits`, `dontAsk`, `auto`, etc.
  3. Schema `minItems: 1` on `findings[].evidence`; `minLength: 1` on every
     string field across `agentic-review-output.schema.json`.
  4. `<untrusted_diff>` / `<untrusted_focus>` / `<workspace_guidance>`
     delimiters in prompt. Reviewer system prompt explicitly declares the
     trust boundary and treats injection attempts as security findings.
  5. WebFetch domain allowlist (29 entries: vendor docs, NIST/CWE/OWASP,
     GitHub, MDN, package registries, NICE/BNF/BMJ/Lancet/NEJM/JAMA/Cochrane/
     WHO/UKHSA/NHS). Repeatable `--web-domain` flag to extend.
  6. `--strict-mcp-config` default ON. Opt-out via `--inherit-mcp`.
  7. `isSubscriptionAuth` detection. `--max-budget-usd` and `--betas`
     suppressed under subscription auth with a clear NOTE in the rendered
     output and run log.
  8. Stream parser tracks `parseErrors` count + `parseErrorPreviews`;
     `parseClaudeStructuredOutput` fails closed with a clear "stream
     contained N malformed lines" error when no result event recoverable.
  9. `--unrestricted` escape hatch for trusted-diff workflows (loud banner,
     full default tool catalog, raw shell). Documented prominently.
  10. README rewritten to match implementation exactly. Setup report
      surfaces subscription detection.
- **61/61 tests pass; lint clean** as of paste-time.

### What v0.2.1 ships in the working tree

```
M  .codex-plugin/plugin.json          (manifest 0.2.1)
M  README.md                           (full rewrite)
M  commands/{review,adversarial-review,elite-review}.md
M  package.json                        (0.2.1)
M  scripts/claude-review-companion.mjs (CLI; new flags + subscription notes)
M  scripts/lib/claude.mjs              (agentic engine; ~540 LOC)
M  scripts/lib/render.mjs              (agentic rendering)
M  scripts/validate-repo.mjs           (lint guards)
M  test/{claude,commands,render}.test.mjs
?? commands/{deep-review,security-review}.md
?? schemas/agentic-review-output.schema.json
?? scripts/bin/git-safe.mjs
?? test/git-safe.test.mjs
```

(See `git diff HEAD --stat` for line counts.)

The legacy upstream plugin sub-tree is preserved at `plugins/codex/` for
reference. **Do not edit `plugins/codex/`** — keep that subtree intact as
the upstream-port artifact. All v0.2+ work happens at the repo root.

---

## Mission

Carry the working tree from "v0.2.1 hardening, 61 tests green" to
**v1.0.0 production-shippable**. The bar is staff-engineer-approves-this-PR.

This is **not** a cosmetic polish pass. You will:

1. Run the full adversarial battery again from scratch as if you had
   never seen this code. Default to skepticism.
2. Fix everything you find, in code, not in CHANGELOG hand-waving.
3. Add the missing production-grade infrastructure listed below.
4. Verify the green at the end with the same `npm run check` command Kennedy
   will run after pulling.

---

## Definition of "truly elite, production-ready, shippable"

A v1.0.0 that an Anthropic engineer or an OpenAI codex maintainer would
ship without flinching. That means:

### A. Security

- [ ] No path-escape, command-injection, env-injection, or symlink-escape
      reachable from the agent surface, even with a hostile diff.
- [ ] No mode/flag passthrough that disables the read-only contract
      without an explicit user-declared `--unrestricted` opt-in.
- [ ] Schema cannot be satisfied with empty/null evidence on agentic
      lanes. The agent cannot lie its way past validation.
- [ ] `<untrusted_diff>` / `<untrusted_focus>` / `<workspace_guidance>`
      framing is consistent across **every** lane and message that
      embeds external content.
- [ ] WebFetch and Bash allowlists are tested adversarially (negative
      tests for every documented vector).
- [ ] No silent feature drops (subscription-vs-api-key) without a
      surfaced NOTE in the rendered output, the log, and the
      `invocationMeta` block.
- [ ] No secrets, paths, or auth tokens in error messages, logs, or
      rendered output.
- [ ] No accidental network egress from `setup` (auth probe must not
      leak workspace contents).
- [ ] `--add-dir` paths are validated (existence, readability,
      not-a-symlink-to-/, no `..` traversal, sane size cap).

### B. Correctness

- [ ] All 61 tests still pass; new code has tests; coverage doesn't drop.
- [ ] Edge cases tested: empty diff, deleted files, binary files,
      submodules, detached HEAD, no remote, dirty working tree on a
      branch with no diff vs. base, line-number ranges that cross hunks,
      diffs > 250KB (long-context auto-switch), diffs > 800KB (forced
      summarized mode), diffs with embedded null bytes.
- [ ] `chooseContextMode` boundary conditions (`AUTO_LONG_CONTEXT_BYTES`,
      `DEFAULT_LONG_CONTEXT_BYTES`) covered with assertions, not just
      happy-path.
- [ ] State files (`.claude-review/jobs/*.job.json`) round-trip cleanly
      across version upgrades. Define a `schemaVersion` field on the
      job record and migrate forward when read.
- [ ] Background-job `status`/`result`/`cancel` flows survive the
      parent process exiting mid-run.
- [ ] Concurrent runs in the same workspace do not corrupt state
      (atomic file writes, `O_EXCL` on job creation, lockfile if
      necessary).
- [ ] `parseClaudeStructuredOutput` is idempotent and never throws on
      well-formed input; failure modes return clear diagnostics.

### C. Operability

- [ ] `setup` reports a clean, machine-parseable status (consider
      `--json` output) so Codex hooks can decide whether to run.
- [ ] Every long-running command is interruptible (SIGINT/SIGTERM
      cleanly cancels the spawned `claude` process and writes
      `cancelled` to the job record).
- [ ] Logs use a consistent format with timestamp, job id, level. Add
      a `--quiet` and `--debug` flag pair on review-like commands.
- [ ] `--timeout-ms` is enforced in-process (kill the child) not just
      passed to spawnSync.
- [ ] Stale `running` jobs older than the timeout are detected by
      `status` and reported as `stalled` (not eternal "running").
- [ ] An exit-code contract: `0` clean, `1` operational error,
      `2` invalid usage / validation error, `3` review found
      ship-blockers (so callers can gate CI on `exit != 3`).

### D. Performance

- [ ] Stream-json parsing does not allocate the full stdout twice
      (current code splits once, fine; profile under a 50MB stream and
      add a guard if memory grows linearly).
- [ ] Diff collection on a 10k-file repo completes in under 5s for the
      summarized path (use `git diff --shortstat` paths, avoid
      `git diff --binary` over the whole tree when only a stat is
      needed).
- [ ] No unnecessary `child_process.spawnSync` re-invocations of `git`
      where one call suffices.
- [ ] Default 30-min timeout and 256MB maxBuffer are configurable per
      lane, not just per invocation. Document why those defaults exist.

### E. Cross-platform

- [ ] All path operations use `path.join` / `path.sep`. Verify on
      darwin and linux. Document any windows-incompatibility under a
      "Supported platforms" section.
- [ ] `git-safe.mjs` rejects backslash-traversal (`..\\`) in addition
      to `..`.
- [ ] Shell scripts (none should exist; surface any) work under both
      bash and zsh; default-shell-of-the-test-environment-agnostic.

### F. Distribution / packaging

- [ ] `package.json` `bin` entry resolves correctly when the package
      is installed via `npm install -g`.
- [ ] `files` field exists and includes only what should ship (drop
      `tests/` if it's the upstream legacy dir; keep `test/` only if it
      adds value to consumers).
- [ ] `engines.node` matches what the code actually requires
      (verify against `node --version` features used: `lines.entries()`
      since Node 12, `??`/`?.` since Node 14, `Array.flatMap` since 11,
      etc.).
- [ ] LICENSE and NOTICE present and accurate (Apache-2.0).
- [ ] `.codex-plugin/plugin.json` `defaultPrompt` entries match the
      actual lane behavior; `description`, `displayName`,
      `shortDescription`, `longDescription`, `category`, `keywords`,
      `brandColor` all coherent.
- [ ] Plugin manifest is valid against whatever schema the Codex
      plugin loader expects (read `~/.codex/` config or
      `openai/codex` repo if you can; otherwise document assumptions).
- [ ] No accidental shipping of `.claude-review/` artefacts in the
      tarball.

### G. Documentation

- [ ] `README.md` accurate top-to-bottom — every flag described matches
      the code, every example runs.
- [ ] New `CHANGELOG.md` (Keep-A-Changelog format) covering 0.1.0 →
      v1.0.0 with explicit security advisory entries for the v0.2.1
      hardening (Bash exfil, prompt injection, etc.).
- [ ] New `SECURITY.md` declaring the threat model, supported
      versions, reporting channel.
- [ ] New `CONTRIBUTING.md` covering: how to run tests, code style
      (`integrity-first` rules — no untyped lets without 20-char
      JUSTIFIED comments), how to add a new review lane, how to
      regenerate the schema.
- [ ] A short `docs/architecture.md` describing the data flow:
      `prepareSnapshot → buildReviewInvocation → claude -p → stream-json
      → parse → render`. Include the trust boundary diagram.
- [ ] Every command doc under `commands/` updated to match the v0.2.1
      flag surface.

### H. CI

- [ ] `.github/workflows/pull-request-ci.yml` already exists; verify it
      runs `npm run check` on Node 18, 20, 22 (matrix); verify it
      doesn't try to run `claude` (which won't be authenticated in
      CI). Add a smoke test that exercises the helper with the
      `withFakeClaude` shim.
- [ ] Add a `release.yml` workflow that publishes to npm on a tag
      push (gated on `npm run check` green). Mark as `private: true`
      for now if Kennedy doesn't want to publish to public npm yet —
      document the choice.

### I. Subagent + MCP correctness

- [ ] Verify the deep-review system prompt's "up to four parallel Task
      subagents" is actually achievable: the parent agent has `Task` in
      its tool catalog, the spawned sub-agents inherit the same
      read-only fence (sub-agents created by Task share parent
      permissions per Anthropic docs — verify and cite).
- [ ] Test that `--mcp-config` files are validated (file exists, JSON
      parses, structure matches the documented MCP schema) before
      being passed to claude.
- [ ] Test the `--inherit-mcp` opt-out path; verify project MCPs
      (e.g., `brv`) are inherited only when explicitly opted-in.

### J. Telemetry

- [ ] `summarizeClaudeStreamActivity` should also count the number of
      Task subagent dispatches (currently lumped into general tool
      calls).
- [ ] Per-tool token cost, when available from the stream events, is
      surfaced in the rendered output.
- [ ] `invocationMeta` is persisted in the job record on completion;
      `result` command surfaces it on demand.

---

## Investigation method

You will run the full investigation in two passes:

### Pass 1 — adversarial review (be ruthless)

Default to skepticism. Tool-verify every claim. Use `git diff HEAD`,
`git status --short`, `node --check`, `node --test`, `npm run lint`,
`npm test`, plus any rg/Read/Glob you need.

For each item in §A–§J above, answer:

1. Is it correctly implemented?
2. What's the strongest reason it might fail in production?
3. Concrete file:line for the failure mode.
4. Concrete fix (you're going to apply it next).

If you find a NO_SHIP issue not on this list, surface it explicitly.
Treat the lists above as a floor, not a ceiling.

Specific traps to look for that prior reviewers may have missed:

- **`spawnSync` with `maxBuffer: 256 * 1024 * 1024`** — does this hold
  the entire stdout in memory? On a large diff with verbose stream
  output, this could OOM. Should we switch to `spawn` + streaming?
- **Stream-parser failure when `result.structured_output` is present
  but malformed**, e.g. `findings: null`. The current parser returns
  it; the renderer assumes arrays. Trace the code path.
- **`isSubscriptionAuth` heuristic fallback** — if the `claude auth
  status` JSON shape changes upstream, the heuristic returning `true`
  by default may be too conservative or too permissive. Is there a
  smaller, more deterministic detection?
- **`--add-dir` symlink escape** — if the workspace has a symlink
  pointing outside, does `Read` traverse it? What does Anthropic's
  Read tool do with symlinks? Document and test.
- **Long-context auto-switch + agentic** — when the diff is summarized,
  the agent is told it can `Read` the full file. But the file might
  have been deleted in the diff. The agent will get an error; does
  the system prompt instruct it to handle that gracefully?
- **`Task` subagent inheritance under `--strict-mcp-config`** — do
  spawned subagents inherit the strict MCP config or do they get the
  parent's environment? If the parent had inherited MCPs, do
  subagents get them too?
- **Background jobs and `O_EXCL`** — two concurrent
  `codex-claude-review review --background` calls in the same workspace
  could race on `generateJobId`. Is the job-id collision-resistant
  (timestamp + random) or are we depending on luck?
- **`--timeout-ms` enforcement** — `spawnSync` honors `timeout` but
  doesn't kill child processes on Windows reliably. Even on darwin/
  linux, the spawned `claude` may have child processes (sub-agents)
  that need a process-tree kill, not just a SIGTERM to the parent.
- **`renderReviewResult` when `result.parsed.findings` is missing** —
  the current code does `result.parsed.findings.length` without a
  null check. Trace and fix.
- **`buildJobRecord` schema versioning** — if v0.2.1 jobs are read by
  a future v0.3.0 with new fields, the upgrade should be lossless.
  Add `schemaVersion: 1` and a migrator.
- **Stream parser performance on a 50MB stream** — `String(stdout)`
  allocates a copy. `.split(/\r?\n/)` allocates another. `.map`
  allocates a third. For very large streams, switch to a line-by-line
  reader on a `Readable`.

### Pass 2 — implementation

Apply every fix from Pass 1. Add the missing production infrastructure
(CHANGELOG, SECURITY, CONTRIBUTING, architecture doc, CI matrix). Bump
version. Update README. Run `npm run check` until green. Run a manual
smoke test against the local working tree.

Don't gold-plate. Don't add features not on this list. Stop when the
acceptance criteria are met.

---

## Constraints

- **No mocks weakening tests.** If a test fails, fix the code, not the test.
- **No `--no-verify`, no skipping hooks.** If `code-integrity-guard.sh`
  blocks an `let` declaration, refactor to `const` or add a
  `// JUSTIFIED: <20+ char>` comment with a real reason.
- **No new runtime dependencies.** Stay zero-dep at runtime. Dev-deps are
  acceptable if absolutely needed for testing.
- **No breaking changes to v0.1 callers** without a CHANGELOG migration
  note. The old `--tools ""` legacy path must remain accessible via
  `--legacy`.
- **No edits to `plugins/codex/`** — that's the preserved upstream port.
- **Idempotent.** Running this prompt twice should converge, not diverge.
- **Don't claim something is fixed without a test.** Every security fix,
  every behavior fix gets a regression test that fails before the fix.
- **No magic constants.** If you introduce a new threshold, document why.
- **Stay under 30 minutes of wall-clock work.** If the scope balloons,
  stop and surface what's left as v1.1.0 issues with concrete
  acceptance criteria each.

---

## Deliverables

When you're done, surface a single final report covering:

1. **What you found** — bullet list of issues discovered in Pass 1
   (severity-ranked, with file:line citations).
2. **What you fixed** — bullet list mapping each finding to the
   commit-ready change you applied (file:line + one-sentence summary).
3. **What you added** — list of new files (CHANGELOG, SECURITY,
   CONTRIBUTING, architecture doc, CI matrix, etc.).
4. **What you deferred** — anything you explicitly chose not to fix
   for v1.0.0, with justification + recommended follow-up version.
5. **Test count delta** — `before: 61, after: NN`.
6. **Verification block** — paste of the final `npm run check` output
   showing all green.
7. **Suggested git commit message** — one Conventional Commits message
   covering the v0.2.1 → v1.0.0 promotion. (Don't commit. Surface only.)
8. **Suggested release notes** — a short tag-message describing the
   shippable release.

If you cannot reach v1.0.0 status (any acceptance criterion in §A–§J
remains red), state that explicitly and ship as **v0.3.0** with a clear
"what's left for v1.0.0" appendix. **Do not** lie about completeness.

---

## One last thing

Kennedy's CLAUDE.md mandates 100% coding integrity, GMC-compliance-grade
rigor, and zero shortcuts. The plugin is going to be used to review
medical-content code (TEG/Pathway Pro AI clinical features) where bugs
have real-world patient consequences. Treat every fix as if it might be
the one that catches a clinical-safety regression in production.

If at any point during the work you find an integrity violation, a
loophole in a guard, or a hook bypass — stop, log it to
`tasks/discovered-issues.md`, and surface it as the **first** item in
your final report. Do not proceed past it.

You're cleared. Make this plugin worthy of the empire it serves.
