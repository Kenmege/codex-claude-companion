# codex-plugin-cc v1.0.6 - public npm page polish

This release removes stale pre-publish wording from the README rendered on
npmjs after the package went live.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Public npm is now presented as the canonical install lane.
- Source install is documented as the local plugin development path.
- Version metadata is aligned across `package.json`, `package-lock.json`, and
  `.codex-plugin/plugin.json`.

## Verification

- `npm run check`
- `npm run pack:check`
- Public npm install smoke from a throwaway `/tmp` workspace
