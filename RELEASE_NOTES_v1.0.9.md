# codex-plugin-cc v1.0.9 - attribution and install safety

This release resolves the remaining launch-readiness issues found by the
Claude Opus 4.7 elite review.

## Install

```bash
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Changes

- Top-level NOTICE now identifies Kennedy Umege as the current package
  publisher while preserving OpenAI attribution for upstream-derived portions.
- The upstream Claude Code marketplace manifest no longer presents the Kenmege
  repository as OpenAI-owned.
- Public docs no longer make unverifiable unreleased-model-name claims.
- Reviewer-composition docs now distinguish shipped Claude automation from
  external GitHub Apps/settings for Copilot, Codex, and Devin.
- SECURITY.md now points researchers to GitHub Security Advisories.
- `codex-claude-review enable` now uses a same-directory temp file, atomic
  rename, and a timestamped backup before changing an existing Codex config.

## Verification

- `npm run check`
- `npm run pack:check`
- `npm audit --audit-level=moderate`
- Public npm install smoke from a throwaway `/tmp` workspace
