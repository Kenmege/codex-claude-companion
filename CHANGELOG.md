# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

### Added

- Added public-launch community files: issue templates, PR template,
  CODEOWNERS, Code of Conduct, and v1.0.1 release notes.
- Added README launch hero, quickstart, CI/license/Node badges, and reviewer
  composition documentation.

### Fixed

- Relaxed marketplace-name validation so forks can rename their private Codex
  marketplace without breaking `npm run check`.
- Hardened Claude review workflow auth selection so public fork PRs are skipped
  with a notice when GitHub withholds repository Actions secrets.

## [1.0.1] — 2026-05-08

- Workflow fix: removed `npm pkg set private=false` from `release.yml`. The
  defensive line wrote the string "false" to `package.json.private` (truthy in
  JS), which caused npm publish to exit `EPRIVATE`. The package.json shape
  regression test added in PR #2 already enforces the absence of the `private`
  field at source, so the workflow-side normalization is no longer needed.
- Initial public release version-bumped to 1.0.1; the v1.0.0 tag was created
  during launch but never produced a published package or a GitHub release.
- Removed the legacy `context-1m-2025-08-07` beta-header injection from the
  long-context Sonnet profile. 1M context is GA on Sonnet 4.6 and Opus 4.6+ at
  standard pricing as of 2026-03-13; the legacy header was retired for Sonnet 4
  / 4.5 on 2026-04-30.

### Added

- Added agentic review lanes for `review`, `adversarial-review`, `elite-review`, `deep-review`, and `security-review`.
- Added read-only Claude tool fencing with native `Read`, `Glob`, `Grep`, `Task`, `WebFetch`, `WebSearch`, and a single `git-safe.mjs` Bash wrapper.
- Added strict structured-output validation so malformed Claude payloads fail closed before rendering.
- Added versioned job records with `schemaVersion`, atomic writes, exclusive job creation, stale-running detection, and persisted `invocationMeta`.
- Added `setup --json`, `--quiet`, `--debug`, validated `--add-dir`, validated `--mcp-config`, and exit-code contract support.
- Added CI matrix for Node 18.18, 20, and 22 plus package-content verification.
- Added release workflow scaffolding. Publishing is disabled by default while `package.json` remains `private: true`.
- Added `SECURITY.md`, `CONTRIBUTING.md`, and `docs/architecture.md`.

### Security

- Hardened the Bash surface against command/path escape by replacing raw git/cat/find/grep-style shell rules with `scripts/bin/git-safe.mjs`.
- Fixed prompt-injection exposure by consistently framing external review material inside `<untrusted_diff>`, `<untrusted_focus>`, and `<workspace_guidance>`.
- Blocked unsafe permission modes such as `bypassPermissions`, `acceptEdits`, and arbitrary auto-approval modes.
- Added WebFetch domain allowlisting and explicit `--unrestricted` warning behavior.
- Added validation for extra directory access and MCP config inputs before launching Claude.

### Changed

- Promoted default model to `claude-opus-4-7`.
- Agentic safe mode is now the default; legacy structured-output-only behavior remains available with `--legacy`.
- Subscription auth detection now suppresses API-key-only budget flags and surfaces the suppression in rendered output, logs, and invocation metadata.
- Repackaged for GitHub Packages publishing under `@kenmege/codex-plugin-cc`; the release workflow now uses `GITHUB_TOKEN` and publishes to `https://npm.pkg.github.com`.
  References: GitHub Docs "Working with the npm registry" (https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry), "About permissions for GitHub Packages" (https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages), and "Automatic token authentication" (https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication).

### Fixed

- Fixed stream parsing to count malformed JSON lines and fail closed when no structured output can be recovered.
- Fixed renderer crashes on missing findings arrays by validating live output and defensively rendering persisted legacy records.
- Fixed background job state corruption risk from partial writes.
- Fixed stale CI that referenced a missing build script and only tested one Node version.
- Fixed release workflow safety so a tag must match `package.json` before GitHub Packages publish can run.
- Fixed CLI help so `--help`, `-h`, and `help` exit successfully while unknown commands still return usage error code `2`.
- Fixed the `review` lane so positional focus text is preserved instead of silently discarded.
- Fixed stale job lock recovery when a lock holder has died, and routed detached worker stdout/stderr into the job log for early-crash diagnostics.
- Documented the `CODEX_CLAUDE_ADD_DIR_BOUNDARY` override for symlinked monorepo and tighter-boundary deployments.

## [0.2.1] - 2026-05-07

### Added

- Added hardening for the v0.2.0 agentic refactor, including permission-mode checks, schema evidence requirements, trust-boundary tags, WebFetch allowlists, strict MCP defaulting, and subscription-auth notes.

### Security

- Addressed reviewer-identified NO_SHIP risks in Bash allowlisting, prompt injection, empty evidence, unsafe permission modes, and unscoped MCP inheritance.

## [0.2.0] - 2026-05-07

### Added

- Added the first agentic review implementation with Claude tool access, new review lanes, and richer structured output.

### Changed

- Replaced structured-output-only review with agentic review as the default path.

## [0.1.0] - 2026-04-12

### Added

- Initial Codex-native Claude review helper.
- Added `review`, `adversarial-review`, and `elite-review` lanes using structured output without agentic tools.
