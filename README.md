# Claude Review Plugin For Codex

[![CI](https://github.com/Kenmege/codex-plugin-cc/actions/workflows/pull-request-ci.yml/badge.svg)](https://github.com/Kenmege/codex-plugin-cc/actions/workflows/pull-request-ci.yml)
[![CodeQL](https://github.com/Kenmege/codex-plugin-cc/actions/workflows/codeql.yml/badge.svg)](https://github.com/Kenmege/codex-plugin-cc/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](#requirements)

> Claude reviews your Codex diffs. Read-only, evidence-cited, and agentic.

The primary product surface is Codex -> Claude review: from inside a Codex CLI
session, you can unleash Claude Code's current Opus alias, including the Opus
1M long-context alias, for a high-scrutiny adversarial review of any diff. The
reviewer gets read-only workspace access through `Read`, `Glob`, `Grep`, Task
sub-agents, a domain-fenced `WebFetch`, and a narrow git wrapper. It does not
get `Edit`, `Write`, raw shell, or arbitrary git by default. Every elite-tier
finding must cite tool-call evidence, and the cited tool is cross-checked
against the live tool-use stream so a fabricated citation surfaces in the
rendered output. Malformed structured output fails closed.

## 60-Second Quickstart

Public npm is the frictionless install lane:

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

For local development on the plugin itself, install from source:

```bash
git clone https://github.com/Kenmege/codex-plugin-cc.git
cd codex-plugin-cc
npm install -g .
codex-claude-review enable
codex-claude-review doctor
```

`enable` registers the plugin with Codex. On current Codex CLI versions it
uses `codex plugin marketplace add` + `codex plugin add` through a local wrapper
marketplace; on older runtimes or custom `--config` paths it falls back to the
legacy TOML stanza writer. Run it once after install; it is idempotent. Restart
Codex CLI after running it. `doctor` checks Node, Git, Claude Code CLI/version
(minimum `2.1.183` for the default `opus` / `xhigh` review profile), Claude
auth, Codex registration, job storage, non-Git folder support, and optional live
Claude runtime access with `--probe-runtime`.

Then run a review from any git workspace:

```bash
codex-claude-review review
codex-claude-review review --preset ship --base main
codex-claude-review review --preset security --add-dir ../shared-libs
```

Codex slash commands are available once the plugin marketplace is loaded:
`/claude-review:review`, `/claude-review:elite-review`,
`/claude-review:deep-review`, `/claude-review:security-review`, and
`/claude-review:doctor`.

## Requirements

- Node.js 18.18 or newer.
- Git on `PATH`.
- Claude Code CLI authenticated locally for direct helper usage.
- Codex CLI with local plugin marketplace support for slash-command usage.

## Five Review Lanes

| Lane | Purpose |
|---|---|
| `review` | Quick agentic Claude review for everyday diffs. |
| `adversarial-review` | Skeptical challenge pass for risky changes. |
| `elite-review` | Exhaustive ship/no-ship review with systemic risks and blind spots. |
| `deep-review` | Opus max effort with parallel Task sub-agent investigation. |
| `security-review` | OWASP/CWE-focused review with exploitability classification. |

## Presets

Use presets when you want one command that chooses the right lane:

| Preset | Command | Use when |
|---|---|---|
| `quick` | `codex-claude-review review --preset quick` | Everyday review with high-signal findings. |
| `ship` | `codex-claude-review review --preset ship --base main` | Pre-merge ship/no-ship gate. Routes to the elite lane. |
| `security` | `codex-claude-review review --preset security` | Security review without remembering the dedicated command. |
| `research` | `codex-claude-review folder ./paper --preset research --long-context` | Evidence-heavy code, papers, notes, or research folders. |
| `deep` | `codex-claude-review review --preset deep --background` | Large or ambiguous tasks that need sub-agent investigation. |

## Why Trust The Boundary?

- Read-only by default: `Edit`, `Write`, `NotebookEdit`, raw shell, and raw git
  are outside the safe-mode tool catalog.
- Prompt-injection resistant framing: diff, focus text, and workspace guidance
  are wrapped as untrusted data before Claude sees them.
- Fenced external access: `WebFetch` starts with a domain allowlist and expands
  only through explicit `--web-domain` flags.
- Strict release controls: pinned GitHub Actions, Node 18/20/22 CI, package
  content checks, tag/package version matching, and npmjs publishing with
  provenance attestation once the human publish gate is enabled.
- Runtime validation: structured review output is validated before rendering,
  including persisted background-job results.

This repository started from OpenAI's Apache-2.0 Codex plugin reference
preserved under `plugins/codex/`, and keeps that history. The runtime here is
deliberately reversed:

- upstream plugin: Claude Code -> Codex review/runtime
- this plugin: Codex -> Claude review/runtime

## Reviewer Composition

This repository dogfoods its own thesis: every pull request is designed for
review by four agents with distinct strengths.

| Reviewer | Trigger | Strength |
|---|---|---|
| **GitHub Copilot** | GitHub App / repository setting | breadth, fast, high-recall on style and obvious bugs |
| **Codex (OpenAI)** | installed GitHub App or `@codex` PR comment where configured | senior-engineer reasoning, forensic depth on architecture and release safety |
| **Devin (Cognition)** | installed GitHub App or `@devin` PR comment where configured | autonomous engineering; can implement fixes, not just review |
| **Claude (Anthropic Opus alias)** | `@claude` PR comment, plus automatic on PR open | adversarial code review, evidence-cited findings, schema-enforced output through this plugin |

This repository ships Claude automation in `.github/workflows/claude.yml`.
Copilot, Codex, and Devin reviewer behavior depends on the GitHub Apps and
repository settings installed on the target repository; forks must configure
those separately. Contributors should expect overlapping but complementary
feedback on the maintained repository.
Claude auto-review is skipped on untrusted fork PRs when GitHub withholds
repository Actions secrets; maintainers can still trigger a safe follow-up once
the PR is ready for deeper review.
Disagreements between reviewers are productive. The v0.2.x to v0.2.1
hardening of this plugin came from a Claude Opus plus OpenAI Codex
adversarial review pair where both returned independent NO_SHIP verdicts on
convergent control-plane issues.

## Detailed Capabilities

Five review lanes, all agentic by default:

- `/claude-review:review` — quick agentic Claude review (Opus alias, xhigh effort).
- `/claude-review:adversarial-review` — agentic skeptical challenge pass.
- `/claude-review:elite-review` — exhaustive single-agent ship/no-ship review
  with evidence-cited findings, systemic risks, blind spots, and exploration
  log.
- `/claude-review:deep-review` — Opus alias at `max` effort with parallel
  sub-agent dispatch (up to four `Task` sub-investigations per turn).
- `/claude-review:security-review` — security-focused agentic pass with
  OWASP/CWE mapping and exploitability classification.
- `/claude-review:doctor` — first-run diagnostics for installation and runtime
  readiness.

Plus the operational surface:

- `/claude-review:setup` — verify local Claude CLI readiness and report
  whether subscription auth is detected (which suppresses budget caps).
  Use `--json` for machine-parseable hook output.
- `codex-claude-review doctor` — first-run diagnostic for Node, Git, Claude,
  Codex registration, writable job storage, and optional live runtime probing.
- `/claude-review:status`, `/claude-review:result`, `/claude-review:cancel` —
  manage background review jobs.
- `codex-claude-review` — direct CLI fallback outside slash commands.
- Bundled Codex skill metadata (`skills/claude-review/SKILL.md`) lets current
  Codex plugin runtimes discover when to route natural-language review requests
  to the helper, not just explicit slash-command invocations.

## Agent Capabilities (safe-mode default)

Each review lane spawns a Claude session with a fenced tool catalog. The
agent gets *more* investigative capability than v0.2.0 (native tools beat
shell duplicates) while losing the file-exfil channels that v0.2.0 had.

| Tool                          | Notes                                                                  |
|-------------------------------|------------------------------------------------------------------------|
| `Read`                        | Workspace-scoped file read with line ranges. Replaces `cat/head/tail`. |
| `Glob`                        | Workspace-scoped file pattern search. Replaces `find/ls`.              |
| `Grep`                        | Ripgrep-backed regex with structured matches. Replaces `grep/rg`.      |
| `Task`                        | Dispatch parallel sub-agents (deep-review may fan out 4-way).          |
| `WebSearch`                   | Web search (broad).                                                    |
| `WebFetch`                    | Default domain allowlist (vendor docs, NIST/CWE/OWASP, package         |
|                               | registries, NICE/BNF/BMJ/Lancet/NHS); extend with `--web-domain`.      |
| `Bash(node scripts/bin/git-safe.mjs:*)` | Single git wrapper. Subcommand allowlist:                       |
|                               | `diff`, `log`, `show`, `blame`, `status`, `branch`, `rev-parse`,       |
|                               | `diff-tree`, `ls-files`, `ls-tree`, `shortlog`, `describe`,            |
|                               | `config --get/--list`, `remote` (read-only), `tag` (listing only).     |
|                               | Rejects `--no-index`, absolute paths outside cwd, `..` traversal,      |
|                               | shell metacharacters, `-c`/`-C`, `--exec-path`, `--git-dir`,           |
|                               | `--upload-pack`, `--receive-pack`.                                     |
| `Bash(node --check:*)` / `Bash(node --test:*)` | Read-only syntax/test runners.                        |
| `Bash(npm test:*)` / `Bash(npm run lint/check/typecheck:*)` | Project-defined verification.            |

`Edit`, `Write`, and `NotebookEdit` are explicitly disallowed. Raw `cat`,
`head`, `tail`, `find`, `ls`, `grep`, `rg`, `wc`, and arbitrary `git` are
**not** in the allowlist — the native tools (Read/Glob/Grep) are strictly
more capable, structured, and workspace-fenced.

`--permission-mode` is whitelisted to `default` and `plan` only. Passing
anything else (`bypassPermissions`, `acceptEdits`, etc.) causes the helper
to refuse to launch the review.

The reviewer system prompt establishes a hard trust boundary: review
material is wrapped in `<untrusted_diff>` / `<untrusted_focus>` /
`<workspace_guidance>` tags and the agent is instructed to treat their
contents as data, never as instructions — defeating prompt-injection from
hostile diff content.

### Escape hatch

For workflows where the diff is fully trusted (your own branch on a private
repo) and you want raw shell access:

```bash
codex-claude-review review --unrestricted
```

`--unrestricted` switches the agent to the full default tool catalog
(including raw Bash) and emits a loud `WARNING: --unrestricted set. Trust
boundary disabled.` note in the rendered output and run log. **Never use
`--unrestricted` against an untrusted diff.**

## Default Profile

Quality-first reviews default to:

- model: `opus`
- effort: `xhigh`
- mode: agentic-safe (read-only fenced tools enabled)

Large review snapshots automatically switch to a long-context profile:

- model: `opus[1m]`
- effort: `xhigh`
- Claude Code accepts model aliases such as `opus` and `sonnet`, and the
  `[1m]` suffix selects the long-context variant where the user's Claude plan
  and model access support it.

Deep-review lane defaults:

- model: `opus`
- effort: `max`
- budget cap: `--max-budget-usd 25` *(only honored on api-key auth; on
  subscription auth the helper suppresses `--max-budget-usd` and surfaces a
  NOTE. Use `--timeout-ms` for a wall-clock cap.)*

`/claude-review:setup` now reports whether subscription auth is detected so
you know up-front whether the budget cap will apply.

## Install

### npmjs public install

Install from npmjs:

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor --probe-runtime
```

If you previously installed the historical scoped package or a source checkout
and npm reports `EEXIST` for `codex-claude-review`, remove the old global
package first:

```bash
npm uninstall -g @kenmege/codex-plugin-cc codex-plugin-cc
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

### Source install

Install the helper binary:

```bash
npm install -g .
```

Or link it during development:

```bash
npm link
```

Then load the plugin in Codex from this repository root. The plugin manifest
is:

- `.codex-plugin/plugin.json`

The private Codex lane (this repo's local marketplace) should stay local-only:

```bash
codex plugin marketplace add <repo-root>
```

This loads `.agents/plugins/marketplace.json` as the
`claude-review-private` marketplace. Do not install the private lane from a
GitHub URL unless intentionally testing the public marketplace path.

### GitHub Packages historical install

v1.0.4 was also published under the historical GitHub Packages name
`@kenmege/codex-plugin-cc`. This is no longer the recommended public install
path because GitHub Packages npm installs require developer-machine auth.

```bash
echo "@kenmege:registry=https://npm.pkg.github.com" > ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_CLASSIC_PAT" >> ~/.npmrc
npm install -g @kenmege/codex-plugin-cc
```

Do not commit a token-bearing `.npmrc`.

## Direct CLI Usage

```bash
codex-claude-review doctor
codex-claude-review doctor --probe-runtime
codex-claude-review setup
codex-claude-review setup --json
codex-claude-review review
codex-claude-review review --preset ship --base main
codex-claude-review review --preset security
codex-claude-review folder ./paper --preset research --long-context
codex-claude-review review --preset deep --background
codex-claude-review review --base main
codex-claude-review adversarial-review --background look for migration risk
codex-claude-review elite-review focus on architecture and rollback
codex-claude-review deep-review --background --timeout-ms 1800000
codex-claude-review security-review --add-dir ../shared-libs --web-domain 'https://snyk.io/*'
codex-claude-review review --inherit-mcp --mcp-config /tmp/linear.mcp.json
codex-claude-review review --unrestricted   # trust boundary off, raw shell
codex-claude-review status
codex-claude-review result <job-id>
codex-claude-review cancel <job-id>
```

`setup --json` redacts local auth identity by default. It may still report
auth method, API provider, and subscription type so automation can distinguish
subscription auth from API-key auth without exposing the account address.

## Slash Commands

Once loaded as a Codex plugin, the slash command surface is:

- `/claude-review:review`
- `/claude-review:adversarial-review`
- `/claude-review:elite-review`
- `/claude-review:deep-review`
- `/claude-review:security-review`
- `/claude-review:doctor`
- `/claude-review:setup`
- `/claude-review:status`
- `/claude-review:result`
- `/claude-review:cancel`

The command docs are thin wrappers that tell Codex to invoke the local helper
and return its stdout directly.

## Codex Companion Commands

The core `codex-plugin-cc` experience is still `/claude-review:*`: Codex
delegates review work to an elite Claude reviewer and gets evidence-cited
ship/no-ship feedback. The bundled `/codex:*` companion commands below are
secondary plumbing for setup, status, and Codex task delegation. They keep
rescue flows available without making rescue the center of the plugin.

### `/codex:setup`

Checks whether Codex is installed and authenticated. If Codex is missing, setup
can offer to install Codex for you; if Codex is installed but unauthenticated,
it still points users to run `!codex login`.

```text
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

### `/codex:review`

Starts a Codex-backed review using the current repository state.

### `/codex:adversarial-review`

Uses the same review target selection as `/codex:review`, then asks Codex to
challenge the implementation. Example:

```text
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
```

### `/codex:rescue`

Routes follow-up implementation or investigation work through the
`codex:codex-rescue` subagent. Use `--resume` to continue a previous Codex task
or `--fresh` to force a new thread. If you do not pass `--model` or `--effort`, Codex chooses its own defaults.

```text
/codex:rescue --model gpt-5.5 --effort medium fix the failing parser test
```

If you pass `spark`, the plugin maps that to `gpt-5.3-codex-spark` before
calling Codex.

### `/codex:status`

Shows tracked Codex jobs for the current repository.

### `/codex:result`

Shows the stored final output for a finished Codex job.

### `/codex:cancel`

Cancels or marks a tracked Codex job as stopped.

## Flags

All review-like commands accept:

| Flag                          | Purpose                                                          |
|-------------------------------|------------------------------------------------------------------|
| `--background`                | Detach the review as a background job                            |
| `--base <ref>`                | Base ref for branch diff (default: auto-detect origin/main)      |
| `--scope auto\|working-tree\|branch\|directory` | Override scope detection                       |
| `--preset quick\|ship\|security\|research\|deep` | Choose a role workflow                          |
| `--model <name>`              | Override the model (e.g., `opus[1m]` or a full Claude model name) |
| `--effort low\|medium\|high\|xhigh\|max` | Override effort                                       |
| `--profile quality\|long-context` | Force a profile                                              |
| `--long-context`              | Opt into Claude Code's Opus 1M long-context alias                |
| `--legacy`                    | Disable agentic mode (structured output only, no tool access)    |
| `--agentic`                   | Force agentic mode on (default for all lanes)                    |
| `--unrestricted`              | Disable the safe-mode tool fence (raw shell, loud banner).       |
| `--mcp-config <file-or-json>` | Attach an MCP server (repeatable)                                |
| `--inherit-mcp`               | Also inherit project/local MCPs (default off → strict-mcp on)   |
| `--max-budget-usd <n>`        | Cap review spend (api-key auth only; suppressed under subscription) |
| `--add-dir <path>`            | Grant tool access to extra directories (repeatable)              |
| `--web-domain <pattern>`      | Add a WebFetch allowlist entry (repeatable)                      |
| `--system-prompt-extra <s>`   | Append workspace-specific reviewer guidance                      |
| `--quiet`                     | Suppress non-essential rendered detail                           |
| `--debug`                     | Add diagnostic job-log lines                                     |
| `--permission-mode <mode>`    | One of: `default`, `plan` (others rejected)                      |
| `--timeout-ms <n>`            | Override review timeout (lane default: 30 minutes)               |

Setup accepts `--json` for machine-parseable readiness checks. Doctor accepts
`--json`, `--config <path>`, `--job-dir <path>`, and `--probe-runtime`.

## Runtime Hardening

- `--setting-sources project,local` keeps user-level Claude plugins/hooks
  from hijacking or stalling the review flow.
- `--strict-mcp-config` is **on by default** so the agent's MCP tool surface
  is exactly the set the user passed via `--mcp-config`. Opt out with
  `--inherit-mcp`.
- `--no-session-persistence` keeps review sessions off-disk.
- `--exclude-dynamic-system-prompt-sections` improves cross-user prompt-cache
  reuse.
- `--include-partial-messages` so the streaming activity log captures
  tool-call telemetry, token counts, cost, and duration.
- Subscription auth detection (`isSubscriptionAuth`) automatically suppresses
  `--max-budget-usd` (which Claude only enforces on api-key auth) and surfaces
  a NOTE in rendered output, job logs, and invocation metadata explaining why
  the cap is not honored.
- The stream parser tracks malformed JSON line count, exposes it under
  `activity.parseErrors`, and fails closed when no structured output can be
  recovered.
- Structured output is validated again after parsing. Missing arrays,
  malformed rich findings, or empty agentic evidence fail the job before
  rendering.
- `--add-dir` resolves symlinks with `realpath`, rejects filesystem root,
  unreadable paths, non-directories, and paths outside the allowed boundary
  before Claude starts.
  The default boundary is the parent of the workspace root; set
  `CODEX_CLAUDE_ADD_DIR_BOUNDARY=/absolute/path` to tighten or intentionally
  extend that boundary for a trusted monorepo layout.
- `--mcp-config` values are parsed as JSON and checked for MCP server
  structure before they are passed to Claude.
- Foreground Claude calls are launched with timeout/interruption handling; a
  timeout kills the spawned process tree and marks the job failed.
- `setup` performs a live non-interactive structured-output probe instead of
  trusting `claude auth status` alone.

`elite-review`, `deep-review`, and `security-review` use a richer agentic
schema (`schemas/agentic-review-output.schema.json`) that **schema-enforces**
`evidence` as `minItems: 1` per finding, `minLength: 1` on every string
field. The agent cannot emit empty evidence and pass validation.

After schema validation, every finding's `evidence[].tool` is cross-checked
against the actual tool-use stream observed in this run via
`crossCheckEvidenceAgainstStream`. Citations whose tool name does not match
any observed call are flagged with a `⚠ Evidence cross-check` annotation in
the rendered output and counted in the aggregate. The check is lenient —
findings are not deleted or downgraded, since tools invoked inside `Task`
sub-agent calls do not appear in the parent stream and a citation may
legitimately reference one of those. The annotation is a "treat as a
fabrication-or-subagent signal" prompt for the operator, not a hard failure.

## Workspace State

Per-workspace review state is stored under:

- `.claude-review/jobs/*.job.json`
- `.claude-review/jobs/*.input.json`
- `.claude-review/jobs/*.log`

Background jobs survive across Codex turns without polluting global state.
The `.claude-review/` directory is excluded from review snapshots so review
artefacts do not feed back into themselves.

Job records are versioned with `schemaVersion: 1`, created with exclusive file
creation, and updated with atomic writes. `status` marks long-running jobs as
`stalled` when their timeout window has elapsed.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Clean command or review with no ship-blocking findings |
| `1` | Operational/runtime error |
| `2` | Invalid usage or validation error |
| `3` | Review completed and found ship-blocking findings |

The same gating contract applies when a review is run in the background:
`codex-claude-review result <job-id>` re-validates the persisted result and
exits `3` when the completed job contains ship-blocking findings.

## Supported Platforms

Supported and tested development platforms are macOS and Linux with Node.js
18.18 or newer. Windows is not a supported v1 platform because process-tree
termination and shell/tool semantics have not been verified there. Run
`codex-claude-review doctor --probe-runtime` on a new machine before trusting a
release gate there, because Claude Code runtime behavior and local auth state
still depend on the host environment.

## Development

```bash
npm run lint
npm test
npm run check
npm run pack:check
```

The npm package intentionally omits `package.json.private` so npmjs publishing
can run when explicitly enabled. The release workflow validates tags and only
publishes when repository variable `NPMJS_PUBLISH_ENABLED=true` and secret
`NPM_TOKEN` are configured. Release tags must match the package version exactly:
`package.json` version `X.Y.Z` is published only from tag `vX.Y.Z`; a
prerelease smoke must first commit matching `X.Y.Z-rc.1` metadata before
pushing tag `vX.Y.Z-rc.1`.

## Repository Layout

```text
.codex-plugin/plugin.json
commands/
  review.md
  adversarial-review.md
  elite-review.md
  deep-review.md
  security-review.md
  setup.md
  status.md
  result.md
  cancel.md
docs/plans/
schemas/
  review-output.schema.json
  elite-review-output.schema.json
  agentic-review-output.schema.json
scripts/
  claude-review-companion.mjs
  bin/
    git-safe.mjs
  lib/
    args.mjs
    claude.mjs
    git.mjs
    process.mjs
    render.mjs
    state.mjs
    workspace.mjs
test/
```

The original Claude Code plugin subtree remains under `plugins/codex/` as an
upstream reference while this Codex-native runtime is developed at the repo
root. Its Codex prompt guidance tracks the current OpenAI model family:
`gpt-5.5` for complex coding/research work, `gpt-5.4-mini` for lighter
subtasks, and the `spark` shortcut for `gpt-5.3-codex-spark` preview runs when
that model is available to the user.
