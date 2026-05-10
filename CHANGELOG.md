# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

### Added

- Added public-launch community files: issue templates, PR template,
  CODEOWNERS, Code of Conduct, and v1.0.2 release notes.
- Added README launch hero, quickstart, CI/license/Node badges, and reviewer
  composition documentation.

### Fixed

- Relaxed marketplace-name validation so forks can rename their private Codex
  marketplace without breaking `npm run check`.
- Hardened Claude review workflow auth selection so public fork PRs are skipped
  with a notice when GitHub withholds repository Actions secrets.

### Security

- `.github/workflows/claude.yml` hardening pass (PR #8, 2026-05-10),
  surfaced by an external review of the same workflow file when ported
  to a sister repo:
  - Added `Bash`, `BashOutput`, and `KillShell` to `--disallowedTools`
    on **both** the `auto-review` and `interactive` jobs. Closes a
    prompt-injection-to-secret-exfil vector where a crafted file in a
    PR diff could instruct Claude to `curl` the runner's
    `CLAUDE_CODE_OAUTH_TOKEN` out of the environment. The interactive
    fence was added in a follow-up commit on this same branch after a
    residual maintainer-on-fork-PR exfil path was identified mid-
    review (the env-level fork-head check cannot detect fork PRs from
    `issue_comment` events because the PR object is not in that
    payload). Cost is the occasional ability to ask Claude to run
    shell during interactive sessions; that capability is mostly
    covered by Pull Request CI anyway, and the token is the higher-
    value asset.
  - Restricted the `interactive` job trigger to OWNER, MEMBER, and
    COLLABORATOR `author_association` values across all four event
    types (`issue_comment`, `pull_request_review_comment`,
    `pull_request_review`, `issues`). The previous fork-PR guard
    used `github.event.pull_request`, which is null on `issue_comment`
    events on PR threads, so the guard failed open for the very case
    it was supposed to defend against (Copilot finding on PR #8). The
    fork-head check at the env level is retained as defense-in-depth
    for `pull_request_review*` events where the PR object is in the
    payload.
  - Skip Dependabot-authored `@claude` triggers in the `interactive`
    job (`sender.login != dependabot[bot]`). Maintainer `@claude`
    invocations on a Dependabot PR are intentionally allowed: a
    maintainer commenting `@claude` is a deliberate request for
    review, even when the PR author is Dependabot.
  - Skip Dependabot PRs in `auto-review`. Dependabot-triggered
    workflows do not receive repository Actions secrets by default,
    so the auth preflight always failed; routing around it cleanly
    avoids noisy red checks on dep-update PRs.
  - Deduplicated the OAuth and API-key prompt blocks via job-scoped
    env vars (`CLAUDE_AUTO_REVIEW_PROMPT` on `auto-review`,
    `CLAUDE_INTERACTIVE_PROMPT` on `interactive`) so future prompt
    edits only need to land in one place. Job-scope rather than
    workflow-scope means the auto-review prompt's interpolation of
    `github.event.pull_request.number` only fires for `pull_request`
    events (fix #6 from Copilot's second-pass review on PR #8).
  - Added `persist-credentials: false` to all `actions/checkout` steps
    so the default `GITHUB_TOKEN` is not left on disk inside the
    runner's `.git/config`.
  - **Reverted attempted F1**: an earlier commit on this branch
    removed workflow-level `id-token: write` under the assumption
    that no step uses OIDC. That was wrong:
    `anthropics/claude-code-action` itself exchanges an OIDC token
    for a GitHub installation token at runtime
    (`src/github/token.ts:138 setupGitHubToken`). Removing the scope
    causes the action to fail with `Could not fetch an OIDC token. Did
    you remember to add id-token: write to your workflow permissions?`
    (verified on PR #8 run 25627012564). The scope is restored with a
    comment block explaining why it is load-bearing.
  - **L1 fix (Codex review of PR #8)**: added `|| ''` defensiveness on
    `github.event.comment.body` references in the `issue_comment` and
    `pull_request_review_comment` arms of the `interactive` trigger
    gate, matching the pattern already used for `review.body` and
    `issue.body`/`issue.title`.
  - **INFO-1 fix (Codex review of PR #8)**: narrowed the `issues`
    trigger from `[opened, assigned]` to `[opened]`. The `assigned`
    action would re-fire the @claude trigger every time someone is
    assigned to an issue whose title or body contains @claude — a
    redundant trigger surface without added signal.
  - **Comment + notice cleanup (fixes #7 and #9 from Copilot's
    second-pass review on PR #8)**: removed the obsolete "interactive
    job has Bash permitted" wording from the trigger-gate comment
    block; rewrote the fork-PR skip notice to accurately describe
    *why* the guard exists (CLAUDE_CODE_OAUTH_TOKEN is in scope on
    `issue_comment` / `pull_request_review*` events; the guard skips
    so Claude is not run with token access against fork-controlled
    diff content). The previous notice incorrectly claimed secrets
    were withheld, which is the opposite of why the guard is needed.
  - **`--disallowedTools` argument format**: switched all four
    `--disallowedTools` invocations from comma-separated
    (`Edit,Write,...`) to space-separated multi-value
    (`Edit Write NotebookEdit Bash BashOutput KillShell`). Both
    forms are documented as supported by the Claude Code CLI, but
    the repo's own helper (`scripts/lib/claude.mjs:194-196`) builds
    the argv as `args.push("--disallowedTools", ...disallowedTools)`
    — i.e., one flag followed by individual tool values as separate
    args. Aligning the workflow with that convention removes any
    parser-version ambiguity (Copilot review on PR #8, 2026-05-10).
  - **`issue_comment` fork-PR resolution (Codex P1, 2026-05-10)**:
    added a `resolve_pr_head` step that, on `issue_comment` events
    on PR threads, calls `gh api repos/<repo>/pulls/<n>` to fetch
    `head.repo.full_name` and exposes `is_fork` as a step output.
    The preflight step now consults both the env-level
    `IS_UNTRUSTED_FORK_PR` (which works for `pull_request_review*`
    events where the PR object is in the payload) and the resolved
    `IC_FORK` from the lookup step. Without this, a maintainer
    commenting `@claude` on a fork-authored PR thread would still
    pass the author_association gate and reach the Claude action
    with `CLAUDE_CODE_OAUTH_TOKEN` in scope, with only the Bash
    fence as a defense — closing the residual M1 path Codex
    flagged in the second round.

## [1.0.3] — 2026-05-08

First public OSS release of @kenmege/codex-plugin-cc.

- Repository visibility flipped from private to public.
- `release.yml`: `npm publish --access public --provenance` so the
  package is consumable by anyone and ships with a provenance
  attestation. Replaces the `--access restricted` private-era
  publish path used for 1.0.1 and 1.0.2.
- `release.yml`: new step that auto-creates a GitHub Release for
  every published tag, sourced from `RELEASE_NOTES_v${VERSION}.md`.
- 1.0.0 / 1.0.1 / 1.0.2 were private-era launch attempts; 1.0.3 is
  the version readers should depend on.

## [1.0.2] — 2026-05-08

- Workflow fix: removed npm provenance from the restricted GitHub Packages
  publish path. The v1.0.1 tag reached `npm publish` but GitHub Packages rejected
  `npm publish --provenance --access restricted` with `EUSAGE` because npm
  provenance requires public-access publishing for a first publish.
- Removed `publishConfig.provenance` and the unused `id-token: write`
  permission from `release.yml`; the workflow continues to publish to
  `https://npm.pkg.github.com` with `GITHUB_TOKEN` and `--access restricted`.
- Initial public release version-bumped to 1.0.2; the v1.0.0 and v1.0.1 tags
  were launch attempts that never produced a published package or GitHub release.

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
