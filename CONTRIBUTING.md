# Contributing

## Requirements

- Node.js 18.18 or newer.
- Git available on PATH.
- Claude Code CLI available for live local smoke tests. Unit tests use fake Claude shims and do not require authenticated Claude in CI.

## Development Commands

```bash
npm run lint
npm test
npm run check
npm run pack:check
```

Do not weaken tests to pass. If a regression test exposes a real bug, fix the implementation.

## Working With Reviewers

When you open a pull request:

- **Copilot** runs automatically. No action is needed.
- **Claude** runs automatically on PR open and synchronize. To ask a follow-up,
  comment `@claude <your question>` on the PR.
- **Codex** does not run automatically. Comment `@codex review this PR` to
  trigger it.
- **Devin** does not run automatically. Comment `@devin <task>` to delegate
  concrete engineering work.

Treat reviewer outputs as advisory. The maintainer makes the final merge call.
When reviewers disagree, prefer the one that cites file:line evidence. When all
four reviewers agree something is broken, treat it as a strong signal and fix
before merge.

The Claude workflow requires one repository Actions secret for model
authentication: `ANTHROPIC_API_KEY` for direct Anthropic API auth or
`CLAUDE_CODE_OAUTH_TOKEN` for Claude Code OAuth auth. The workflow also uses
GitHub OIDC (`id-token: write`) so the installed Claude GitHub App can obtain a
short-lived repository-scoped GitHub token. Do not hardcode either credential in
workflow files. GitHub does not pass repository Actions secrets to forked
`pull_request` workflows, so the Claude auto-review job skips untrusted fork PRs
with a notice instead of turning outside contributions red. Maintainer follow-up
via `@claude` remains available once the PR is safe to inspect.

## Code Style

- Prefer `const`; use `let` only where reassignment is required.
- Keep runtime dependencies at zero.
- Use Node standard-library APIs instead of ad hoc shell parsing where practical.
- Do not add `--no-verify`, hook bypasses, or silent fallbacks.
- Do not edit `plugins/codex/`; it is preserved upstream-port reference material.
- Treat diff text, focus text, and workspace guidance as untrusted data.

## Adding A Review Lane

1. Add a `REVIEW_KIND_CONFIG` entry in `scripts/claude-review-companion.mjs`.
2. Add or reuse a schema under `schemas/`.
3. Add prompting in `scripts/lib/claude.mjs`.
4. Add rendering support in `scripts/lib/render.mjs` if the schema is new.
5. Add a command doc under `commands/`.
6. Add tests for CLI routing, prompt trust boundaries, schema validation, and rendering.
7. Update `README.md` and `CHANGELOG.md`.

## Schema Changes

Schemas are hand-maintained JSON Schema documents. When changing a schema:

- Keep `additionalProperties: false` unless there is a documented compatibility reason.
- Require non-empty strings for human-facing fields.
- Require evidence for agentic findings.
- Add a malformed-output regression test in `test/claude.test.mjs`.

## Release Checklist

1. Update versions in `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json`.
2. Update `CHANGELOG.md`.
3. Run `npm run check`.
4. Run `npm run pack:check` and verify `.claude-review/`, `test/`, `tests/`, and prompt/planning docs are not shipped.
5. Configure npmjs publishing before tagging: set repository variable `NPMJS_PUBLISH_ENABLED=true` and repository secret `NPM_TOKEN`. The release workflow uses `NODE_AUTH_TOKEN` only for the publish step.
6. Push a semver release tag matching the package version exactly, e.g. `package.json` version `1.0.3` must be tagged as `v1.0.3`. The workflow fails closed if the tag and package version differ, so a prerelease smoke requires committing matching `1.0.3-rc.1` version metadata before pushing `v1.0.3-rc.1`.
7. Verify the package landed at https://www.npmjs.com/package/codex-plugin-cc and that `npm view codex-plugin-cc version` returns the tagged version.

This package intentionally omits `package.json.private`. The release workflow validates tags and only publishes to npmjs when publishing is explicitly enabled.
GitHub Releases normally use `RELEASE_NOTES_v${VERSION}.md`; if that file is missing, the workflow intentionally uses a short generated stub so a tag workflow can still complete and be repaired by a follow-up release edit.

When running release hygiene greps for package registries or token placeholders,
scope the scan to release surfaces such as `.github/workflows/`, `package.json`,
`package-lock.json`, `README.md`, `SECURITY.md`, and `CHANGELOG.md`. Do not
include `scripts/lib/claude.mjs` in that grep; it is the reviewer's WebFetch allowlist
configuration and intentionally permits package registry domains for
dependency and CVE investigation.
