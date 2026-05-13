# codex-plugin-cc v1.0.12 - final CodeQL launch cleanup

This release removes the last CodeQL alerts on the shipped package files before
the X.com launch gate.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Documents the child-process helper's controlled command boundary for CodeQL:
  executable names are validated/resolved and spawned without a shell, while
  callers still pass explicit argument arrays.
- Adjusts a release-docs test assertion so CodeQL no longer treats a forbidden
  registry-host string check as URL substring sanitization.

## Verification

- `npm run check`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
