# Bridge runtime compatibility

`scripts/lib/bridge-runtime.mjs` is a fail-closed integration boundary. It does
not make the current bridge runnable by substituting process-memory state for
missing broker durability.

## Current verdict

The current concrete modules expose all required integration primitives, so
`inspectBridgeRuntimeCompatibility()` reports `ready: true` with an empty
`missing` list. The runtime binds:

- broker-owned supervisor leases, starting reservations, cancellation claims,
  delivery claims, acknowledgements, receipts, and fallback inbox state;
- exact tmux worker discovery and `live`, `dead`, `missing`, or `stale` process
  classification;
- terminal worker-result normalization against the validated result contract;
- durable dispatch identity containing `executor`, `tmuxSession`, `paneId`,
  `panePid`, `workerPid`, `claudeSessionId`, `origin`, and `recordedAt`.

`codex-claude bridge-doctor --json` combines that mechanical compatibility check
with executable discovery for tmux, Claude, and Codex. Its `ready: true` verdict
does not execute a real delegation, app-server delivery, acknowledgement,
recovery, or independent verification. Use the packaged integration smoke and a
throwaway end-to-end delegation before treating a release candidate as proven.

This mechanical readiness is not an adversarial security-boundary claim.
`inspectBridgeRuntimeCompatibility().securityModel` reports:

- `trusted-autonomous` is available only as `cooperative-host-trust-only`.
  A same-UID worker using `bypassPermissions` can inspect its host environment
  and files, so it cannot be cryptographically isolated from broker authority.
  A run declaring `securityRequirements.brokerAuthorityIsolation: true` is
  rejected before supervisor or executor side effects.
- `sandbox-autonomous` is unavailable until a separately verified UID or OS
  sandbox provides the required containment. The runtime rejects this profile
  even if an invalid or legacy ledger somehow contains it.

Compatibility remains capability-based. If a caller injects an incomplete
state, coordination, executor, inspection, normalization, or identity surface,
`createBridgeRuntime().run()` returns `action: "blocked"`, classification
`incompatible-runtime`, and `safeToLaunch: false` before supervisor or executor
side effects.

## Bound guarantees

- The real bridge ledger remains the lifecycle and result authority.
- Broker authority is resolved inside the runtime and is never sent to the
  worker launch transport or returned in a receipt.
- The launch path records dispatch before it can be observed as running.
- A starting job cannot be relaunched when a uniquely attributable tmux worker
  can be discovered; ambiguous discovery returns recovery-required.
- Request, result, cancellation, delivery, and identity shapes are adapted
  explicitly. Missing data is not synthesized.
- Cancellation reconstructs only the executor-private job id and runtime
  artifact paths from the broker-owned job directory; those transport details
  are not added to the durable dispatch identity or exposed to the worker.

The coordination interface remains a durability contract, not an in-memory
convenience API. Alternate implementations should be accepted only with
crash/restart tests proving lease, reservation, cancellation, delivery, and
discovery recovery.
