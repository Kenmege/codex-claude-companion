# Codex-Claude Bridge contracts

This document freezes the Phase-0 contracts for the planned Codex-Claude Bridge. The target column is a release contract, not a claim about the current `codex-plugin-cc@1.1.1` runtime.

## Capability matrix

| Capability | Direct `claude` CLI | `codex-plugin-cc@1.1.1` | Target bridge |
|---|---|---|---|
| Launch a prompt | Native | Wrapped for review and workspace modes | Typed delegation request |
| Agent, model, and effort selection | Native flags | Review/workspace selectors | Named or custom agent plus caller-supplied model and effort |
| Permission policy | Caller chooses flags | Read-only review fence or supervised workspace default | Named, validated trust profile with effective arguments in the receipt |
| Durable process ownership | Shell or Claude background mode | Claude background supervisor; viewer terminal is separate | Actual worker process owned by a named tmux session |
| Codex origin correlation | Manual | Not persisted as a bridge contract | Thread, turn, cwd, repository, branch, head, and job ID |
| Mid-run collaboration | Manual terminal interaction | Status/log polling | Ordered, deduplicated question, message, progress, and cancellation events |
| Result return | Manual copy/paste | Status/result polling | Active-wait return, correlated Codex follow-up, or durable inbox fallback |
| Independent verification | Manual | Codex may review after polling | Separate verification state and bounded repair workflow |
| Crash recovery | Manual archaeology | Job files for review lanes | Reconciliation across ledger, tmux, Claude session, repository, and delivery state |

## Exact meaning of `trusted-autonomous`

`trusted-autonomous` will be an explicit local-workspace trust profile. It will never be the default. Resolving it requires the caller to provide the profile by name and an existing absolute workspace path. Policy resolution canonicalizes that path with `realpath` into a resolved absolute workspace path, confirms it is a directory, and, when a permitted root is supplied, rejects a canonical workspace outside that root. The request and receipt will retain the requested and canonical paths. Its complete Claude permission argument list is:

```text
--permission-mode bypassPermissions
```

That mode will bypass Claude's interactive permission checks inside the selected workspace. It does not create an OS sandbox, restrict network access, prevent an agent from operating outside the repository, or make arbitrary source code trustworthy. `sandbox-autonomous` will be used when bypass permissions must be contained by a separately proven OS or container sandbox.

Selecting this profile will not authorize public publishing, deployment, credential changes, or destructive host actions. Those actions will remain governed separately from Claude's local permission mode. The receipt will record the selected profile and exact effective Claude permission arguments, excluding secrets.

`sandbox-autonomous` is unavailable in Phase 0. Its future request contract retains an executor-produced structured attestation bound to the job ID, executor, canonical workspace path, issue time, and expected authority, but caller-supplied attestations are never accepted as proof. The Phase-0 resolver fails closed even when those fields appear to match. A later executor-owned verifier must validate the authority, freshness, exact job/executor/workspace binding, and runtime sandbox evidence before this profile can become usable. A naked caller-supplied boolean is also not accepted as sandbox proof.

## Other trust profiles

| Profile | Effective permission policy | Boundary |
|---|---|---|
| `review-readonly` | Empty persistent setting sources; read/search/task tools only; `Edit`, `Write`, and `NotebookEdit` denied; `default` permission mode; strict MCP config | Existing shell-free review fence preserved |
| `standard` | `--permission-mode default` | Claude-native supervised coding behavior |
| `trusted-autonomous` | `--permission-mode bypassPermissions` | Explicitly trusted absolute local workspace |
| `sandbox-autonomous` | Unavailable in Phase 0; future policy is `--permission-mode bypassPermissions` | Executor-owned verifier must validate a job-bound OS/container sandbox attestation before dispatch |

Contradictory combinations fail closed. Examples include asking `review-readonly` for anything outside its exact read/search/task and approved WebFetch allowlist, overriding either safe profile with `bypassPermissions`, or selecting `sandbox-autonomous` before executor-owned provenance verification exists.

## Agent presets

The checked-in registry defines `implementer`, `debugger`, `reviewer`, `security-reviewer`, `researcher`, and `elite-reviewer`. Presets choose a role and default trust profile only. They do not freeze a Claude model ID; model and effort remain explicit delegation inputs. The request contract will support a named agent, inline custom-agent JSON, a custom-agent file, plugin directories, MCP configuration paths, additional directories, setting-source policy, and the resolved Claude runtime version.

## Durable state contracts

- `schemas/bridge-delegation-request.schema.json` records immutable origin, worker, execution, policy, and task acceptance data.
- `schemas/bridge-event.schema.json` defines the ordered, deduplicated event journal.
- `schemas/bridge-result.schema.json` defines the worker outcome and its evidence.
- `schemas/bridge-receipt.schema.json` defines delivery and verification lifecycle state.

Worker completion, delivery, acknowledgement, and verification are separate states. A Claude process exiting successfully cannot by itself mark a result delivered, acknowledged, or verified.

The receipt rejects impossible lifecycle combinations. Nonterminal, failed, or cancelled workers cannot be marked delivered or acknowledged; only a completed worker can reach those delivery states. Failed or cancelled workers may leave delivery pending or record a failed delivery attempt. Delivery and acknowledgement require at least one attempt and their corresponding timestamps, while a failed delivery requires an error and cannot carry delivered or acknowledged timestamps. Verification `passed` or `failed` also requires a completed worker.

Production callers validate receipts through `validateBridgeReceiptContract` in `scripts/lib/bridge-contracts.mjs`. That single entry point always applies both the JSON Schema and semantic chronology rules. Delivery follows `createdAt <= deliveredAt <= acknowledgedAt`; verification independently follows `createdAt <= verifiedAt`. Verification may therefore finish before delivery or acknowledgement without invalidating the receipt.

Product identity and compatibility policy are frozen separately in [Bridge identity and migration](bridge-migration.md).
