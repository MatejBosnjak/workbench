# Decisions: Claude Workbench
**Date:** 2026-10-22
**Design:** https://claude.ai/artifact/2KN1pTQZj99QBCqf6RDmMx (base: C · Focus)

Personal local GUI for working with Claude Code instead of the terminal: today's Productive tasks, PRs and review requests, sessions linked to tasks, and the local dev services.

## Resolved
- **App shell** — Electron desktop app; Node in main, node-pty + xterm.js for terminals *(JS stack everywhere, fastest to build)*
- **Session runtime** — the real `claude` CLI in a PTY, not an Agent SDK chat UI *(plugins, skills, hooks and /commands keep working unchanged)*
- **State signals** — global hooks in `~/.claude/settings.json` (Notification / Stop / SessionStart …) post to Workbench's local socket; they must no-op in under ~50ms when Workbench isn't running. The statusline slot is taken by `~/.claude/statusline-command.sh`, so Workbench installs a wrapper that sends the JSON to Workbench and prints the existing statusline unchanged *(the context % and 5h/week limits come from it)*
- **Sessions started outside Workbench** — shown as read-only "external" tabs with live state; "Take over" resumes them inside Workbench with `claude --resume <id>` once the terminal copy has exited
- **Agents** — Claude Code only in v1; the Agent row is hidden or disabled. The session model is agent-agnostic (a command plus a state adapter) so Codex can be added later. Model / effort / permission pickers act on the running session by restarting it with `--resume` (see Picker)
- **My tasks source** — Productive REST API, called from the main process with the keychain token, using the same filter as the saved List view URL (decoded once, stored in config). Grouped by project, then parent/milestone, ordered by placement as in Productive; Bugs pinned first, then Product: CRM. Polled about every 2 min, plus a manual refresh
- **My git / My reviews source** — `gh api graphql` polled about every 2 min: open PRs, review requests, reviewThreads, comments. A thread "needs reply" when its last message isn't the user's and it isn't marked seen; seen state is stored locally. A native notification fires for each new item
- **Session ↔ task linking** — sessions started from a task are linked explicitly. Other sessions are auto-linked on strong signals: the task URL in the first prompts, a task id in the cwd or branch, or a PR linked to the task. The preview shows "linked via …", with manual link and unlink. Links are stored in local SQLite
- **"Where I left off"** — generated on demand from a "Summarize" action in the task preview, using `claude -p --model haiku` over the transcript tail; no background usage
- **Local services** — Workbench supervises them directly: node-pty processes from a config ported from the `prd` script, with restart, logs and a port/health check. Quitting asks whether to stop the services or leave them running. No tmux. Docker infra chips only show status and run `docker compose up`
- **Worktrees** — reimplemented in Node, reading `~/.wtrc.json`: recency order, per-repo command, cleanup badges (merged / gone / dirty / unmerged). Switching restarts the `app` service in the new cwd; "Run alongside" starts a second app instance on the next free port. `wt` stays usable in the terminal
- **Outbound writes** — drafts are written in-app and sent only after an explicit confirm step that shows the exact text and target. This covers GitHub replies, Productive comments and status changes *(the never-post-without-approval rule)*
- **v1 scope** — sessions + top bar + status bar + ⌘K; Today › My tasks + task preview; Today › My git + My reviews (needs-reply highlighting, notifications, drafts); Local services + worktrees
- **Task workstream screen** (milestone timeline, structure tree) — v1.1; in v1 the Today task preview covers it
- **Build order** — 1) shell + PTY sessions (replaces terminal / `cc`) → 2) Local (replaces `prd` + `wt`) → 3) My tasks + preview + linking → 4) My git / reviews + notifications + drafts. Each phase must be usable daily before the next starts
- **Home** — a private repo on the user's personal GitHub profile, with a lite spec at `docs/SPEC.md`

- **Picker** — in the StatusBar. New sessions get `--model` / `--effort` / `--permission-mode`. A running session is restarted with `--resume` and the new flags (after the current turn, if one is running). *Verified in phase 1: `/model` and `/effort` work mid-session but also rewrite the global defaults in `~/.claude/settings.json`, and permission mode only appears in hook payloads, so typing commands into the pty was dropped*
- **Theme for v1** — Dusk only
- **Notifications** — all five: new reply/comment on my PR, changes requested, CI failed, session waiting for me, new review request
- **Packaging** — local unsigned `electron-builder` build into /Applications, no auto-update *(simplest)*
- **Hook install** — Workbench installs them (Settings → Install hooks), backs up `~/.claude/settings.json`, adds only its own marked entries, and offers Uninstall

- **Caffeinate** — a ☕ in the StatusBar with Off / Awake / Awake with lid closed, scoped to this session or all sessions; icon variant 4h (filled espresso cup + shut-laptop badge), also shown on session tabs

## Open / Deferred
- **Lid-closed keep-awake on battery or without an external display** — verify what `caffeinate -s` actually allows
- **Quiet hours** — none for now
