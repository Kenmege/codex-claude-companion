# codex-plugin-cc v1.0.7 - install-friction polish

This release tightens the public npm install docs after the package went live.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Removed remaining pre-publish wording from the README install section.
- Added an explicit migration command for early users who installed the
  historical scoped package or source checkout and see an `EEXIST` global
  binary collision.

## Verification

- `npm run check`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
- Public npm install smoke from a throwaway `/tmp` workspace
