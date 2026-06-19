# codex-plugin-cc v1.0.14 - Claude review hierarchy and alias refresh

This release makes the product hierarchy explicit: the core workflow is Codex
delegating review work to an elite Claude reviewer for evidence-cited
ship/no-ship feedback. The bundled Codex companion commands remain available as
secondary setup, status, and task-delegation plumbing.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Recentered README positioning around Codex -> Claude review as the primary
  product surface.
- Updated Claude review defaults from fixed versioned model IDs to Claude Code's
  `opus` and `opus[1m]` aliases, with `xhigh` effort for quality-first reviews.
- Added README coverage for the Codex companion commands while keeping
  `/codex:rescue` framed as a thin forwarding path, not the main plugin
  workflow.
- Updated bundled Codex rescue prompt guidance to `gpt-5-5-prompting`,
  including `gpt-5.5`, `gpt-5.4-mini`, and `spark` forwarding examples.
- Bumped the npm/Codex plugin release metadata to `1.0.14`.
- Added bundled Codex skill metadata and package inclusion for natural-language
  Claude review routing on current Codex plugin runtimes.
- Updated `codex-claude-review enable` to prefer the native Codex plugin CLI
  install flow through a local wrapper marketplace while retaining the legacy
  TOML writer for explicit `--config` paths and older Codex runtimes.
- Added Claude Code CLI version reporting and a minimum-version diagnostic for
  the `opus` / `xhigh` default review profile.
- Documented that Claude Code `auto` permission mode remains intentionally
  rejected for this read-only reviewer boundary, even with newer Claude Code
  auto-mode safety improvements.
- Refreshed the pinned Claude Code GitHub Action reference to v1.0.152.
- `enable` writes Codex config through an owner-only atomic temp file (`0o600`),
  tightening any legacy group/world-readable config file when the legacy TOML
  fallback path is used.

## Verification

- `npm run check` (runs both `test/*.test.mjs` and `tests/*.test.mjs`)
- `node --test tests/*.test.mjs`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
