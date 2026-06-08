# X Announcement Draft

Do not post this without Kennedy approval.

## Short Version

I released Codex Plugin CC: a Codex plugin that lets Codex hand serious review
work to Claude Code from the terminal.

It supports read-only agentic review, ship/no-ship gates, security review,
folder/non-git review, background jobs, and Claude Code's Opus 1M alias.

Repo: https://github.com/Kenmege/codex-plugin-cc

## After npmjs Publish

Use this only after `npm view codex-plugin-cc version` returns the live version.

```text
Install:
npm install -g codex-plugin-cc
codex-claude-review enable
codex-claude-review doctor
```

## Thread Option

1. I built Codex Plugin CC to make Codex and Claude Code work together in a
   practical shipping loop.

2. Codex stays in the implementation lane. Claude gets a read-only review lane
   with evidence-cited findings, folder review, security review, deep review,
   and background jobs.

3. The default boundary is deliberately conservative: no edits, no writes, no
   raw shell, no arbitrary git. The reviewer can inspect, reason, and report.

4. The useful commands:

   ```bash
   codex-claude-review review --preset ship --base main
   codex-claude-review review --preset security
   codex-claude-review folder ./paper --preset research --long-context
   codex-claude-review review --preset deep --background
   ```

5. First public repo, built under adversarial review pressure and a deliberately
   conservative read-only boundary. The launch posture is simple: useful tool
   first, claims backed by what the package actually does today.

   https://github.com/Kenmege/codex-plugin-cc
