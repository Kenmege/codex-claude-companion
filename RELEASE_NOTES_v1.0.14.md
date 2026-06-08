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

## Verification

- `npm run check`
- `node --test tests/*.test.mjs`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
