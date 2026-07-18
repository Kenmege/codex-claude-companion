# Codex-Claude Bridge identity and migration

This document records naming and compatibility direction for the implemented,
unreleased bridge. It does not rename, reserve, or publish a package.

## Product identity

The public product display name is **Codex-Claude Bridge**. The primary
executable remains `codex-claude`, preserving the command users already invoke.
Its differentiated role is a durable Codex-to-Claude control plane with tmux
process ownership, typed delegation contracts, collaboration events, delivery
acknowledgement, recovery, and independent verification.

The current npm package and plugin identity will stay `codex-plugin-cc` during the implementation and compatibility period. Existing commands will remain available. If a later approved rename occurs, `codex-plugin-cc` will become a thin legacy shim that prints a migration notice and forwards compatible arguments to the new executable. Removal of that shim will require a separately announced major-version policy.

The native Codex plugin ID and slash-command namespace remain `claude-review`
for compatibility, so commands continue to appear as `/claude-review:*` even
though the display name is Codex-Claude Bridge. The local wrapper marketplace is
named `codex-claude-bridge-local`, but its plugin source entry also remains
`claude-review`. Changing either compatibility identifier requires an explicit
migration with alias and rollback tests; this release does not claim that
identity migration is complete.

## Name guard and attribution

The bridge name must not imply that Anthropic or OpenAI endorses the project. OpenAI-derived plugin manifests, command conventions, or bundled components will retain their applicable copyright notices and attribution. The bridge will not use the same display name, package name, or logo as an official OpenAI plugin for Claude. Manifest validation will keep product-owned identity separate from upstream attribution.

## Target repository and package decision

The target repository name is `codex-claude-bridge`. The target package name is `@kenmege/codex-claude-bridge` if registry, scope-control, and name-confusion verification succeeds at the separately approved migration time; otherwise the target package name is `codex-claude-bridge`. This is a decision rule, not an availability or reservation claim. The public npm reservation was not performed because package reservation or publication is approval-gated. A same-turn registry and trademark/name-confusion check will be required before any approved reservation.

The current `codex-plugin-cc` repository and package remain authoritative until that compatibility migration is approved and completed. They are not renamed by this contract.

## Migration sequence

1. The current repository adds bridge commands behind the compatible `codex-claude` entry point and `/claude-review:*` namespace; publication remains a separate approval-gated release action.
2. Durable bridge receipts will record schema and runtime versions so mixed installations fail clearly.
3. Documentation will mark legacy review/workspace commands as compatibility lanes, not as tmux-owned bridge jobs.
4. Only after explicit approval may maintainers select and reserve a new package name, publish it, or change public manifests.
5. Any approved new package will ship the legacy shim before deprecation begins.

No public release, npm reservation, deployment, or external name claim is performed by this Phase-0 work.
