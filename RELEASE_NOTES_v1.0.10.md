# codex-plugin-cc v1.0.10 - final public-trust polish

This release resolves the final visible trust issues from the second
adversarial pre-announcement gate.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Removed the OpenSSF Scorecard badge from the README until the public score
  catches up with the repository's intended trust posture.
- Updated the bug-report template to ask for `codex-plugin-cc` / helper
  version evidence instead of the historical scoped package name.

## Verification

- `npm run check`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
- Public npm install smoke from a throwaway `/tmp` workspace
