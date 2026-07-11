# Codex Plugin CC v1.1.1

## Provenance correction for the Codex-supervised Claude coding workspace

v1.1.1 republishes the v1.1 feature line through the tag-bound npm trusted
publishing workflow. The coding workspace, Codex orchestration, and isolated
review capabilities introduced in v1.1.0 are unchanged. The plugin
never launches a nested Codex process; GPT-side supervision remains with the
active Codex task and inherits its selected model.

## What changed

- The release workflow accepts publication only when its GitHub workflow
  identity was triggered from the exact release tag.
- Release checkout remains bound to the triggering tag ref.
- Manual recovery must be dispatched from the release tag itself and is
  rejected from the default branch.
- The full repository and package verification suites run before publication.

## Upgrade

```bash
npm install -g codex-plugin-cc@1.1.1
```

Users of v1.1.0 should upgrade. That version will be deprecated after v1.1.1's
tag, package, provenance, and installation smoke tests are independently
verified.
