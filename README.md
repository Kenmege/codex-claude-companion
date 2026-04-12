# Claude Review Plugin For Codex

Use Claude from inside Codex CLI sessions for high-scrutiny review passes over
Codex or GPT-generated changes.

This repository started from `openai/codex-plugin-cc` and keeps that history,
but the runtime here is deliberately reversed:

- upstream plugin: Claude Code -> Codex review/runtime
- this plugin: Codex -> Claude review/runtime

## What You Get

- `/claude-review:review` for a normal read-only Claude review
- `/claude-review:adversarial-review` for a harder challenge pass
- `/claude-review:elite-review` for an exhaustive, adversarial, high-level and
  low-level ship review
- `/claude-review:setup` to verify local Claude CLI readiness
- `/claude-review:status`, `/claude-review:result`, and `/claude-review:cancel`
  for background review jobs
- `codex-claude-review` as a direct CLI fallback outside slash commands

## Default Review Profile

Quality-first reviews default to:

- model: `claude-opus-4-6`
- effort: `high`

Large review snapshots can automatically switch to a long-context profile:

- model: `claude-sonnet-4-6`
- effort: `high`
- beta header: `context-1m-2025-08-07`

That switch is explicitly reported in the rendered output. The plugin does not
silently claim that Opus 4.6 has official 1M support.

## Install

Clone this repository somewhere stable. The intended local path for this build is:

- `/Users/kenmege/codex-plugin-cc`

Install the helper binary:

```bash
npm install -g /Users/kenmege/codex-plugin-cc
```

Or link it during development:

```bash
cd /Users/kenmege/codex-plugin-cc
npm link
```

Then load the plugin in Codex from this repository root. The plugin manifest is:

- `.codex-plugin/plugin.json`

## Direct CLI Usage

The helper works even without the plugin command layer:

```bash
codex-claude-review setup
codex-claude-review review
codex-claude-review review --base main
codex-claude-review adversarial-review --background look for migration and rollback risk
codex-claude-review elite-review --background focus on architecture, rollback, and hidden failure modes
codex-claude-review status
codex-claude-review result <job-id>
codex-claude-review cancel <job-id>
```

## Slash Commands

Once loaded as a Codex plugin, the intended slash command surface is:

- `/claude-review:review`
- `/claude-review:adversarial-review`
- `/claude-review:elite-review`
- `/claude-review:setup`
- `/claude-review:status`
- `/claude-review:result`
- `/claude-review:cancel`

The command docs are thin wrappers that tell Codex to invoke the local helper
and return its stdout directly.

## Runtime Hardening

The helper runs Claude with `--setting-sources project,local` so user-level
Claude plugins and hooks do not hijack or stall the review flow. `setup` also
performs a live non-interactive structured-output probe instead of trusting
`claude auth status` alone.

`elite-review` uses a richer structured output contract that is designed to
surface executive ship/no-ship judgment, systemic risks, adversarial findings,
blind spots, and concrete test gaps in one pass.

## Workspace State

Per-workspace review state is stored under:

- `.claude-review/jobs/*.job.json`
- `.claude-review/jobs/*.input.json`
- `.claude-review/jobs/*.log`

This lets background jobs survive across Codex turns without polluting global
state.

## Development

```bash
npm run lint
npm test
npm run check
```

## Repository Layout

```text
.codex-plugin/plugin.json
commands/
docs/plans/
schemas/
scripts/
test/
```

The original Claude Code plugin subtree remains under `plugins/codex/` as an
upstream reference while this Codex-native runtime is developed at the repo
root.
