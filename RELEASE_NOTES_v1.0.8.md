# codex-plugin-cc v1.0.8 - launch trust-boundary polish

This release resolves the final public-readiness issues found in an
adversarial launch review.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Removed the public plugin manifest `Write` capability so metadata matches
  the documented read-only reviewer boundary.
- Aligned platform support claims: v1 is supported/tested on macOS and Linux;
  Windows is not claimed until process-tree and shell semantics are verified.

## Verification

- `npm run check`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
- Public npm install smoke from a throwaway `/tmp` workspace
