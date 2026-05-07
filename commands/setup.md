---
description: Verify that the local Claude review runtime is installed and authenticated.
---

# /claude-review:setup

## Preflight

1. Prefer the helper binary `codex-claude-review` if it is available on PATH.
2. If it is not available, tell the user to install the helper from the plugin
   repository root with `npm install -g .`.

## Plan

Run the helper once in setup mode and report readiness.

## Commands

- Preferred:
  `codex-claude-review setup <user-arguments>`

Useful flags:

- `--json` for machine-parseable readiness output.

## Verification

Do not invent readiness. Use the helper output only.

## Summary

Return the helper stdout verbatim.

## Next Steps

If setup is not ready, follow the concrete next steps listed by the helper.
