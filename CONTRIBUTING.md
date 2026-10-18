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

`npm test` and `npm run test:windows` include the bounded fast-check properties in
`tests/property-fuzzing.test.mjs` for Codex argument parsing, job artifact paths,
Markdown table rendering and job-state operation sequences. Run them alone with
`node scripts/run-tests.mjs tests/property-fuzzing.test.mjs tests/input-boundaries.test.mjs`.
Failures print a replay seed, shrink path and counterexample; reproduce the
failure with the reported `seed` and `path` in that property's `fc.assert` options.
Keep the property and add a minimal ordinary regression test before fixing a defect.
State properties isolate plugin data in a temporary workspace and remove it after
each generated sequence, including failed or shrinking cases.

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

The Claude workflow's preferred keyless authentication is workload identity
federation. Configure the Console federation rule and these non-secret
repository variables: `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
`ANTHROPIC_SERVICE_ACCOUNT_ID`, and `ANTHROPIC_WORKSPACE_ID`. No repository
authentication secret is needed for federation. Scope the Console rule to the
intended repository, owner, events, and `claude.yml` workflow. GitHub OIDC
(`id-token: write`) supplies a short-lived identity token for Anthropic access;
the action also uses OIDC for the installed Claude GitHub App's repository token.

Both jobs select exactly one mode: federation when the rule and organization
variables are set, otherwise `CLAUDE_CODE_OAUTH_TOKEN`, otherwise
`ANTHROPIC_API_KEY` from repository Actions secrets. OAuth and API keys are
fallbacks when federation is not configured, not retries after a federation
failure. Federation steps pass only the four federation auth inputs because a
static credential would override federation inside the action. Never hardcode
credentials in workflow files.

Untrusted fork PRs are skipped with a notice before checkout or Claude in every
auth mode, including maintainer `@claude` follow-ups on fork PRs. The interactive
job also restricts mentions to owners, members, and collaborators. See the
[workflow trust boundary](docs/security/claude-workflow.md) for the fork checks
and tool fences that protect both static credentials and federation tokens.

## Code Style

- Prefer `const`; use `let` only where reassignment is required.
- Keep runtime dependencies minimal, pinned, and justified. The bridge currently
  uses Ajv and ajv-formats for strict JSON Schema validation.
- Use Node standard-library APIs instead of ad hoc shell parsing where practical.
- Do not add `--no-verify`, hook bypasses, or silent fallbacks.
- Treat `plugins/codex/` as a production delivery adapter. Changes require
  adapter tests, package-closure tests, and a fresh packed-install smoke test.
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
5. Configure npmjs publishing before tagging: set repository variable `NPMJS_PUBLISH_ENABLED=true`, then configure an npm trusted publisher for the `Kenmege/codex-claude-companion` GitHub repository and `release.yml` workflow. The workflow requests `id-token: write` and exchanges GitHub OIDC identity for short-lived npm publishing access; do not add a long-lived npm publishing credential.
6. Push a semver release tag matching the package version exactly, e.g. `package.json` version `1.0.3` must be tagged as `v1.0.3`. The workflow fails closed if the tag and package version differ, so a prerelease smoke requires committing matching `1.0.3-rc.1` version metadata before pushing `v1.0.3-rc.1`.
7. Verify the package landed at https://www.npmjs.com/package/codex-claude-companion. For a stable release, `npm view codex-claude-companion version` must return the tagged version. For a prerelease, stable must remain unchanged and `npm view codex-claude-companion@next version` must return the tagged version.

This package intentionally omits `package.json.private`. The release workflow validates tags and only publishes to npmjs when publishing is explicitly enabled.
GitHub Releases normally use `RELEASE_NOTES_v${VERSION}.md`; if that file is missing, the workflow intentionally uses a short generated stub so a tag workflow can still complete and be repaired by a follow-up release edit.

When running release hygiene greps for package registries or token placeholders,
scope the scan to release surfaces such as `.github/workflows/`, `package.json`,
`package-lock.json`, `README.md`, `SECURITY.md`, and `CHANGELOG.md`. Do not
include `scripts/lib/claude.mjs` in that grep; it is the reviewer's WebFetch allowlist
configuration and intentionally permits package registry domains for
dependency and CVE investigation.
