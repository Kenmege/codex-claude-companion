# codex-plugin-cc migration shim

This package is the staged compatibility shim for **Codex-Claude Bridge by
Kenmege**. It preserves the `codex-claude` and `codex-claude-review` executable
names while forwarding arguments, environment, standard I/O, exit status, and
termination signals to `codex-claude-companion`.

The scaffold is intentionally marked `private` until the coordinated migration
release. It must not be published independently of the canonical package.
Its exact `0.0.0-development` dependency is a non-publishable placeholder, not
a release prediction. The coordinated release must atomically replace both the
shim version and that dependency with the same approved canonical bridge
version before removing `private: true`.
