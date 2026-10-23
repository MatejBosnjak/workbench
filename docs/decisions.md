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
- **Local services** — Workbench supervises them directly: node-pty processes from a config ported from the `prd` script, with restart, logs and a port/health check. Services live in the app process, so quitting stops them (with a confirm while any run); leaving them running was dropped to avoid a separate services daemon. No tmux. Infra chips show `brew services` status and can run `brew services start` *(infra is Homebrew here, not Docker)*
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

- **Lid-closed caffeinate** — driven by Amphetamine through AppleScript (`osascript`), with Power Protect and a one-time warning dismissal; only sessions Workbench started are ended; clamshell mode is the fallback without Amphetamine *(caffeinate can't prevent lid-close sleep on Apple Silicon; pmset disablesleep needs root and is unreliable)*
- **Run PR in app** — each session gets a focus PR; when it differs from the branch `app` runs, a status-bar chip offers Run. ▶ Run app also sits on PR rows, the task preview and the terminal hover card. A found worktree is used as-is (match by branch, then upstream, then head commit); otherwise the base checkout (the folder `app` is configured with, `~/Productive/app`) gets fetch → checkout → `pnpm i` if the lockfile changed → package build → restart, with a dirty guard and ↩ Back. Never the read-only `work/repos/frontend`

- **Visual style** — TUI (direction 1b): monospace, boxed panels, a separate accent-lined taskbar, big counters under it, shortcuts only in a ⌨ popover, and a fixed-width StatusBar with compact 48px meters
- **Caffeinate placement** — a 44px realistic cup button in the TopBar with a popover (click or `c`); replaces the StatusBar ☕ menu

- **GitHub pane** — GitHub opens in-app in an Electron `WebContentsView` (phase 8, after the restyle):
  - split view in My git / My reviews (list left, GitHub right, ⤢ full width)
  - a click or ⏎ on a row opens the PR in the pane; PR links elsewhere jump to My git with the PR open; ⌘-click goes to the browser
  - all of `github.com/productiveio` stays in-app
  - the 3 most recent PRs stay live; unsent comments are guarded
  - one persistent login partition (password + authenticator code; no SAML SSO in the org)
  - "reply needed" clears only when you reply or press `m`
  - Claude drafts go into GitHub's reply box and you post with GitHub's own button
  - only ⌘ shortcuts are kept while the pane has focus

## Open / Deferred
- **Lid-closed keep-awake on battery or without an external display** — verify what `caffeinate -s` actually allows
- **Quiet hours** — none for now
