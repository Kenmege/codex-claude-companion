# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

## [1.0.0] - 2026-05-07

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
- Subscription auth detection now suppresses API-key-only budget/beta flags and surfaces the suppression in rendered output, logs, and invocation metadata.

### Fixed

- Fixed stream parsing to count malformed JSON lines and fail closed when no structured output can be recovered.
- Fixed renderer crashes on missing findings arrays by validating live output and defensively rendering persisted legacy records.
- Fixed background job state corruption risk from partial writes.
- Fixed stale CI that referenced a missing build script and only tested one Node version.

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
