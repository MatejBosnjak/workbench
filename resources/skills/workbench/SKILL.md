---
name: workbench
description: Use only when the WORKBENCH_SESSION_ID environment variable is set (this session runs in a Workbench tab). Gives this session's Productive task and GitHub PRs, and links a PR or task to the session, through the `wb` command. Use when asked what this session or task is about, which PR or task it belongs to, the PR's CI or review state, or right after opening a PR with gh pr create.
---

# Workbench

This Claude Code session runs inside **Workbench**, the user's desktop app around Claude Code. Each tab is a session. A session can be linked to Productive tasks and GitHub PRs, and those links drive the app: the session bar, the task sidebar (⌘I), the PR sidebar with the GitHub page (⌘⇧I), and the Today view (My tasks, Needs you, My PRs, Reviews).

Ask Workbench through `wb` (on PATH in Workbench tabs; also at `@@WB@@`). It reads Workbench's own state, so it is faster and more accurate than searching the filesystem or the APIs.

| Command | Use it for |
|---|---|
| `wb status` | This session: its linked task(s) with id, status, project and URL; its PRs with CI, review decision and reviewers; cwd and branch. Run it first when the user asks what this session is working on. |
| `wb tasks [filter]` | The user's Productive tasks, with ids. |
| `wb prs [filter]` | The user's open PRs and review requests, with URLs. |
| `wb link-pr <url>` / `wb unlink-pr <url>` | Put a PR on this session, or take it off. |
| `wb link-task <id or url>` / `wb unlink-task <id>` | Link one of the user's tasks to this session, or unlink it. |

## When to act

- After `gh pr create` in this session, run `wb link-pr <the new PR URL>` so the PR shows on the session. Say in one line that you linked it.
- When the user names a task or PR for this session ("this is for task 2097…", "we're on PR 24733"), link it with `wb link-task` or `wb link-pr`.
- Don't link guesses. Link only what the user named or what this session created.

## Limits

- `wb` changes links inside Workbench only. It never posts to GitHub or Productive; anything posted there (comments, statuses, to-dos, reviews) still needs the user's explicit OK.
- `wb` answers only inside a Workbench tab. If it says Workbench isn't running or this isn't a Workbench session, carry on without it.
