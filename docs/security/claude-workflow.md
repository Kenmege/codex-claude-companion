# Claude workflow trust boundary

Verified against [claude.yml](../../.github/workflows/claude.yml) on 2026-10-18.
The `interactive` job handles `issue_comment` in the base repository, where
secrets are available. Its safety depends on these cumulative controls:

- An `@claude` mention must come from an author whose `author_association` is
  `OWNER`, `MEMBER`, or `COLLABORATOR`. Both Dependabot sender identities are
  excluded. An external contributor's mention cannot start the job.
- Fork PRs are skipped before checkout and before either Claude invocation.
  Review events carry the head repository in their payload. For PR-thread
  `issue_comment` events, `Resolve PR head for issue_comment events` queries
  the PR API because the event does not contain a `pull_request` object.
  Only an exact head-repository match produces `is_fork=false`; missing or
  different repository data produces `true`. An API command failure fails
  the shell step, and the subsequent steps retain their default success
  condition. The lookup therefore fails closed. Ordinary issues have no PR
  head to check.
- Checkout is pinned to a full action commit SHA, uses the resolved head SHA
  for PR comments, and sets `persist-credentials: false`.
- Both authentication paths disallow `Bash`, `BashOutput`, `KillShell`, `Edit`,
  `Write`, and `NotebookEdit` through `claude_args`.

The pinned Claude action also performs its own checkout for an open PR:
[`setupBranch` in branch.ts at f27be6b65a4652f08a2ba3cff79114829b588967](https://github.com/anthropics/claude-code-action/blob/f27be6b65a4652f08a2ba3cff79114829b588967/src/github/operations/branch.ts)
fetches the head branch (the pull ref for a fork) and checks it out. Removing
our checkout would therefore not remove the action's PR-head checkout
behavior or establish a security boundary. Closed or merged PRs instead
fall through to source-branch setup. The action can resolve a moving branch;
the initial SHA checkout is not an immutable snapshot guarantee for its
entire execution.

[CodeQL alert #72](https://github.com/Kenmege/codex-claude-companion/security/code-scanning/72)
and [alert #73](https://github.com/Kenmege/codex-claude-companion/security/code-scanning/73)
were dismissed as false positives on the basis of these controls. Reopen both
alerts if any gate changes, and reassess this document when the action pin
changes. The dismissal is specific to this collaborator-only, fork-excluding
workflow; it is not a claim that repository content or trusted contributors
are inherently safe. Treat all issue, comment, and diff content as untrusted.
