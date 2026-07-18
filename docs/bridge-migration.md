# Codex-Claude Bridge identity and migration

This document freezes naming and compatibility direction for a future bridge release. It does not rename or publish the current `codex-plugin-cc` package.

## Product identity

The product name will be **Codex-Claude Bridge**. The primary executable will remain `codex-claude`, preserving the command users already invoke. The product description will lead with its differentiated role: a durable Codex-to-Claude control plane with tmux process ownership, typed delegation contracts, collaboration events, delivery acknowledgement, and independent verification.

The current npm package and plugin identity will stay `codex-plugin-cc` during the implementation and compatibility period. Existing commands will remain available. If a later approved rename occurs, `codex-plugin-cc` will become a thin legacy shim that prints a migration notice and forwards compatible arguments to the new executable. Removal of that shim will require a separately announced major-version policy.

## Name guard and attribution

The bridge name must not imply that Anthropic or OpenAI endorses the project. OpenAI-derived plugin manifests, command conventions, or bundled components will retain their applicable copyright notices and attribution. The bridge will not use the same display name, package name, or logo as an official OpenAI plugin for Claude. Manifest validation will keep product-owned identity separate from upstream attribution.

## Target repository and package decision

The target repository name is `codex-claude-bridge`. The target package name is `@kenmege/codex-claude-bridge` if registry, scope-control, and name-confusion verification succeeds at the separately approved migration time; otherwise the target package name is `codex-claude-bridge`. This is a decision rule, not an availability or reservation claim. The public npm reservation was not performed because package reservation or publication is approval-gated. A same-turn registry and trademark/name-confusion check will be required before any approved reservation.

The current `codex-plugin-cc` repository and package remain authoritative until that compatibility migration is approved and completed. They are not renamed by this contract.

## Migration sequence

1. The current package will add the new bridge commands behind compatible `codex-claude` entry points.
2. Durable bridge receipts will record schema and runtime versions so mixed installations fail clearly.
3. Documentation will mark legacy review/workspace commands as compatibility lanes, not as tmux-owned bridge jobs.
4. Only after explicit approval may maintainers select and reserve a new package name, publish it, or change public manifests.
5. Any approved new package will ship the legacy shim before deprecation begins.

No public release, npm reservation, deployment, or external name claim is performed by this Phase-0 work.
