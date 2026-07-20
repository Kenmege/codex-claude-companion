# Codex-Claude Bridge identity and migration

This document records naming and compatibility direction for the implemented
bridge. It authorizes the existing-package release candidate and the unscoped
cutover to the renamed `codex-claude-companion` package.

## Product identity

The public product display name is **Codex-Claude Bridge**. The primary
executable remains `codex-claude`, preserving the command users already invoke.
Its differentiated role is a durable Codex-to-Claude control plane with tmux
process ownership, typed delegation contracts, collaboration events, delivery
acknowledgement, recovery, and independent verification.

The npm package is now `codex-claude-companion`. The inherited name
`codex-plugin-cc` is deprecated: it becomes a thin legacy shim that prints one
migration notice and forwards compatible arguments, environment, standard I/O,
exit status, and termination signals to `codex-claude-companion`. Removal of that
shim requires a separately announced major-version policy.

The native Codex plugin ID and slash-command namespace remain `claude-review`
for compatibility, so commands continue to appear as `/claude-review:*` even
though the product display name is Codex-Claude Bridge. The checked-in root
manifest and generated compatibility wrapper both retain the established local
marketplace key `claude-review-private`, with source entry `claude-review`.
Those are compatibility identifiers, not the public product name. The separate
Claude Code reference marketplace is `kenmege-codex-reference`, with source
entry `codex`; it preserves the upstream Claude-to-Codex component and is not
the bridge identity. Changing any compatibility identifier requires an explicit
migration with alias and rollback tests.

## Name guard and attribution

The public qualifier is **Codex-Claude Bridge by Kenmege**. It is an independent
community project and is not affiliated with or endorsed by OpenAI or
Anthropic. OpenAI's `openai/codex-plugin-cc` is a Claude Code-to-Codex plugin;
this bridge is a Codex-to-Claude control plane. OpenAI-derived plugin manifests,
command conventions, and bundled components retain their applicable copyright
notices and attribution. Product-owned identity remains separate from upstream
attribution.

## Target repository and package decision

The canonical repository and npm package name is `codex-claude-companion`.

**Superseded plan (2026-07-20).** An earlier plan targeted the scoped package
`@kenmege/codex-claude-bridge` as the candidate. It is SUPERSEDED by Kennedy's
decision to publish under the unscoped `codex-claude-companion` name (scoped plan
dropped: name-family confusion and discoverability — the unscoped
`codex-claude-bridge` name is already occupied by an unrelated third party, and
the scoped `@kenmege/codex-claude-bridge` candidate shared that confusable
"bridge" family). The existing-package `codex-claude-companion@1.2.0-rc.1`
prerelease is approved on npm dist-tag `next`.

## Migration sequence

1. Keep `codex-claude-companion` authoritative while bridge commands stabilize
   behind `codex-claude` and `/claude-review:*`.
2. Prepare and test the inert legacy-shim scaffold under
   `packages/codex-plugin-cc-shim/`; it remains private before cutover.
3. Release the full bridge under `codex-claude-companion` through a prerelease and
   a clean-install compatibility gate.
4. At the next synchronized stable release, keep `codex-claude-companion`
   canonical and publish the tested exact-version `codex-plugin-cc` shim. Release
   automation must atomically replace the scaffold's `0.0.0-development` version
   and dependency with the same approved canonical version.
5. Preserve both executable names, `claude-review`, `/claude-review:*`, durable
   state paths, environment variables, and receipt schemas.
6. The GitHub repository rename to `codex-claude-companion` is complete; keep
   provenance, badges, workflows, and redirect checks green against it.
7. Support the shim for at least two stable releases plus an announced window;
   removal requires a separately announced major-version policy.

## Public cutover gate

The migration is fail-closed. Every item below must have recorded evidence before
each public package release:

- verified npmjs authentication and trusted-publisher control for
  `codex-claude-companion`;
- clean-install parity between the release candidate and the stable package
  before the legacy `codex-plugin-cc` name becomes a shim;
- successful trusted publisher, provenance, badges, workflows, and repository
  redirects against the `codex-claude-companion` repository;
- review of all modified OpenAI-derived files under `plugins/codex/` against the
  Apache-2.0 attribution requirements, including any required modification notices;
- explicit public-release approval from Kennedy.

**Existing-package prerelease verdict: APPROVED.** Kennedy approved publication
of `codex-claude-companion@1.2.0-rc.1` under npm dist-tag `next`. The trusted
publisher, CI, clean-install, provenance, and post-publish smoke gates still fail
closed.

**Unscoped cutover verdict: READY.** The canonical unscoped name is
`codex-claude-companion`, the GitHub repository rename is complete, and Kennedy
approved the direction. Each public release still fails closed on the recorded
evidence above.
