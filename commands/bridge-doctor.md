---
description: Diagnose durable bridge dependencies, compatibility, and trust-profile availability.
---

# /claude-review:bridge-doctor

Run `codex-claude bridge-doctor --json` and return the complete result. `ready`
means the local bridge primitives and required executables are available; it is
not a security-isolation attestation and does not prove that a real delegation,
delivery, or verification has completed. Report `sandboxAutonomousAvailable`
and `trustedAutonomousContainment` exactly.
