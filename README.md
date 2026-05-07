# Claude Review Plugin For Codex

The best Claude review plugin for any Codex CLI session. Runs **fully agentic
Claude Opus 4.7** and **long-context Sonnet 4.6** reviewers with read-only
access to your workspace via Read, Glob, Grep, Task (sub-agents), WebSearch,
a domain-fenced WebFetch, and a narrow git wrapper that rejects path-escape
attempts. Every elite-tier finding must cite tool-call evidence — the schema
enforces it.

This repository started from `openai/codex-plugin-cc` and keeps that history,
but the runtime here is deliberately reversed:

- upstream plugin: Claude Code -> Codex review/runtime
- this plugin: Codex -> Claude review/runtime

## What You Get

Five review lanes, all agentic by default:

- `/claude-review:review` — quick agentic Claude review (Opus 4.7 high effort).
- `/claude-review:adversarial-review` — agentic skeptical challenge pass.
- `/claude-review:elite-review` — exhaustive single-agent ship/no-ship review
  with evidence-cited findings, systemic risks, blind spots, and exploration
  log.
- `/claude-review:deep-review` — Opus 4.7 at `max` effort with parallel
  sub-agent dispatch (up to four `Task` sub-investigations per turn).
- `/claude-review:security-review` — security-focused agentic pass with
  OWASP/CWE mapping and exploitability classification.

Plus the operational surface:

- `/claude-review:setup` — verify local Claude CLI readiness and report
  whether subscription auth is detected (which suppresses budget/beta flags).
  Use `--json` for machine-parseable hook output.
- `/claude-review:status`, `/claude-review:result`, `/claude-review:cancel` —
  manage background review jobs.
- `codex-claude-review` — direct CLI fallback outside slash commands.

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

- model: `claude-opus-4-7`
- effort: `high`
- mode: agentic-safe (read-only fenced tools enabled)

Large review snapshots automatically switch to a long-context profile:

- model: `claude-sonnet-4-6`
- effort: `high`
- beta header: `context-1m-2025-08-07` *(only honored on api-key auth; on
  subscription auth the helper suppresses `--betas` and surfaces a NOTE)*

Deep-review lane defaults:

- model: `claude-opus-4-7`
- effort: `max`
- budget cap: `--max-budget-usd 25` *(only honored on api-key auth; on
  subscription auth the helper suppresses `--max-budget-usd` and surfaces a
  NOTE. Use `--timeout-ms` for a wall-clock cap.)*

`/claude-review:setup` now reports whether subscription auth is detected so
you know up-front whether the budget/beta caps will apply.

## Install

Clone this repository somewhere stable and install from the repository root.

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

## Direct CLI Usage

```bash
codex-claude-review setup
codex-claude-review setup --json
codex-claude-review review
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
- `/claude-review:setup`
- `/claude-review:status`
- `/claude-review:result`
- `/claude-review:cancel`

The command docs are thin wrappers that tell Codex to invoke the local helper
and return its stdout directly.

## Flags

All review-like commands accept:

| Flag                          | Purpose                                                          |
|-------------------------------|------------------------------------------------------------------|
| `--background`                | Detach the review as a background job                            |
| `--base <ref>`                | Base ref for branch diff (default: auto-detect origin/main)      |
| `--scope auto\|working-tree\|branch` | Override scope detection                                  |
| `--model <name>`              | Override the model (e.g., `claude-sonnet-4-6`)                   |
| `--effort low\|medium\|high\|xhigh\|max` | Override effort                                       |
| `--profile quality\|long-context` | Force a profile                                              |
| `--long-context`              | Opt into the Sonnet 1M long-context beta                         |
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

Setup accepts `--json` for machine-parseable readiness checks.

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
  `--max-budget-usd` and `--betas` (which Claude only enforces on api-key
  auth) and surfaces a NOTE in rendered output, job logs, and invocation
  metadata explaining why the cap/beta is not honored.
- The stream parser tracks malformed JSON line count, exposes it under
  `activity.parseErrors`, and fails closed when no structured output can be
  recovered.
- Structured output is validated again after parsing. Missing arrays,
  malformed rich findings, or empty agentic evidence fail the job before
  rendering.
- `--add-dir` resolves symlinks with `realpath`, rejects filesystem root,
  unreadable paths, non-directories, and paths outside the allowed boundary
  before Claude starts.
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

macOS and Linux are supported for v1. Windows is not supported yet because
process-tree termination and Claude Code shell semantics have not been verified
there.

## Development

```bash
npm run lint
npm test
npm run check
npm run pack:check
```

The npm package is marked `private: true` by default. The release workflow
validates tags and only publishes when npm publishing is explicitly enabled
with repository configuration.

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
root.
