# Codex-Claude Bridge identity and migration

This document records naming and compatibility direction for the implemented
bridge. It prepares, but does not perform, a public repository rename, package
reservation, or publication.

## Product identity

The public product display name is **Codex-Claude Bridge**. The primary
executable remains `codex-claude`, preserving the command users already invoke.
Its differentiated role is a durable Codex-to-Claude control plane with tmux
process ownership, typed delegation contracts, collaboration events, delivery
acknowledgement, recovery, and independent verification.

The current npm package stays `codex-plugin-cc` during the staged compatibility
period. Existing commands remain available. At the coordinated cutover,
`codex-plugin-cc` becomes a thin legacy shim that prints one migration notice and
forwards compatible arguments, environment, standard I/O, exit status, and
termination signals to the new package. Removal of that shim requires a
separately announced major-version policy.

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

The target repository name is `codex-claude-bridge`. The scoped name
`@kenmege/codex-claude-bridge` is the only current package candidate and remains
conditional on scope-control and final registry verification. An npm `E404` is
not a reservation or proof of scope ownership. The unscoped
`codex-claude-bridge` name is already occupied and is not a fallback. Public npm
reservation and publication remain approval-gated.

The current `codex-plugin-cc` repository and package remain authoritative until
that compatibility migration is approved and completed. They are not renamed by
this contract.

## Migration sequence

1. Keep `codex-plugin-cc` authoritative while bridge commands stabilize behind
   `codex-claude` and `/claude-review:*`.
2. Prepare and test the inert legacy-shim scaffold under
   `packages/codex-plugin-cc-shim/`; it remains private before cutover.
3. Release the full bridge on the existing package through a prerelease and a
   clean-install compatibility gate.
4. After explicit release approval and verified npm scope control, dual-publish
   the identical full implementation under the scoped candidate.
5. At the next synchronized stable release, make the scoped package canonical
   and replace `codex-plugin-cc` with the tested exact-version shim. Release
   automation must atomically replace the scaffold's `0.0.0-development`
   version and dependency with the same approved canonical version.
6. Preserve both executable names, `claude-review`, `/claude-review:*`, durable
   state paths, environment variables, and receipt schemas.
7. Rename the GitHub repository only after npm trusted-publisher, provenance,
   badges, workflows, and redirect checks pass against the new repository.
8. Support the shim for at least two stable releases plus an announced window;
   removal requires a separately announced major-version policy.

## Public cutover gate

The migration is fail-closed. Every item below must have recorded evidence before
the first scoped package release or repository rename:

- verified npm authentication and control of the `@kenmege` scope;
- final registry verification and a trusted-publisher dry run for the scoped name;
- clean-install parity between the old and new full packages before the old name
  becomes a shim;
- successful trusted publisher, provenance, badges, workflows, and repository
  redirects against the target repository;
- review of all modified OpenAI-derived files under `plugins/codex/` against the
  Apache-2.0 attribution requirements, including any required modification notices;
- explicit public-release approval from Kennedy.

**Release verdict: BLOCKED.** The current local preparation does not satisfy the
authenticated npm-scope or attribution-review gates and therefore must not be
published, renamed, or presented as reserved.

No public release, npm reservation, deployment, or external name claim is
performed by this repository preparation.
