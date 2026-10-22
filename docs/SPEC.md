# Workbench — spec

**Status:** draft · **Owner:** Matej Bošnjak · **Updated:** 2026-10-22
**Design:** https://claude.ai/artifact/2KN1pTQZj99QBCqf6RDmMx (base: C · Focus, theme Dusk)
**Decision log:** [decisions.md](./decisions.md)

## Problem

Day-to-day work happens across many separate places:
- several `claude` sessions in terminal tabs
- the `prd` tmux script running the local stack
- `wt` for switching frontend worktrees
- Productive for tasks
- GitHub for PRs and review requests, where replies to my comments are easy to miss

Switching context means re-finding the right session, worktree and PR for a task by hand.

## Goal

One personal desktop app that:

1. **Hosts Claude Code sessions** as tabs, showing each session's state, context use and plan limits at a glance.
2. **Runs and switches the local stack**, replacing `prd` and `wt`.
3. **Starts the day from one Today screen**, with My tasks, My git and My reviews.
4. **Links sessions to tasks**, so a task opens straight into its sessions, the running one, and "where I left off".

## Non-goals

- No chat UI of its own. The real `claude` CLI runs in a terminal.
- No Codex in v1. The agent model leaves room for it later.
- Not for the team. There's no multi-user support, no Productive branding, and no distribution beyond my own machine.
- No auto-update and no signed builds.
- Nothing is posted to GitHub or Productive without an explicit confirm.

## Architecture

```
Electron main (Node)
├─ pty-host        node-pty processes: claude sessions + local services
├─ signal-server   local unix socket; receives hook + statusline events
├─ pollers         Productive REST (2 min) · gh GraphQL (2 min)
├─ linker          session ↔ task inference
├─ store           SQLite: sessions, links, seen-state, drafts, summaries, settings
└─ services        process supervision, health checks, worktree ops (~/.wtrc.json)

Renderer (web UI)
├─ TopBar          Today · Local │ session tabs │ ⌘K
├─ Today           My tasks · My git · My reviews, task preview
├─ Session view    xterm.js bound to a pty
├─ Local           service list, split/resizable panes, worktree switcher
└─ StatusBar       context %, 5h / week limits, model · effort · permissions picker
```

### Sessions

- **Spawning.** A session is `claude` (or `claude --resume <id>`) started in a pty. The working directory is the task's worktree when there is one, otherwise the work repo root, matching what `cc` does today.
- **Hooks.** `~/.claude/settings.json` gets global hooks (Notification, Stop, SessionStart, SessionEnd, UserPromptSubmit). Each one runs a tiny client that writes `{event, session_id, cwd, transcript_path, …}` to the Workbench socket. If the socket is missing, the client exits right away, in under 50ms, and prints nothing.
- **Statusline.** The configured statusline becomes a wrapper. It forwards the statusline JSON to the socket (`context_window.used_percentage`, `rate_limits.five_hour`, model, effort) and then runs `scripts/statusline.sh`, so terminal output stays exactly as it is now.
- **Tab states:**

  | State | Shown when |
  |---|---|
  | running | a prompt was submitted and no Stop has arrived |
  | waiting for you | a Notification arrived, e.g. a permission prompt or idle input |
  | failed | the process exited non-zero |
  | idle | the session is stopped |

  Tabs show the state as a coloured overline, and the open tab moves it to an underline.
- **External sessions.** Sessions started in a normal terminal report through the same hooks. They appear as read-only "external" tabs. "Take over" waits for the terminal copy to exit, then resumes the session inside Workbench.
- **PR links in terminal output.** An xterm link provider recognises `github.com/<org>/<repo>/pull/<n>`. A click opens the PR in Workbench, and ⌘-click opens GitHub. Hovering shows a card with the PR's state and CI status.
- **Pickers.** Model, effort and permission changes are sent into the pty as the matching CLI commands (see Open questions). The defaults for new sessions are stored in settings.

### Today › My tasks

- **Source.** The Productive REST API, using the token from the macOS keychain. The filter is the saved List view filter, decoded from its URL once and stored in settings.
- **Shape.** Tasks are grouped by project, with Bugs pinned first, then Product: CRM, then the rest alphabetically. Inside a project they're ordered by placement and nested under their parent or milestone.
  - A milestone that isn't mine gets a muted header.
  - A parent hidden by a filter shows as "filtered out".
  - Subtasks don't repeat the parent's task list.
- **Row.** Each row shows:
  - a status glyph: a ring in the status colour, with a filled core once started; not-started statuses get a dashed, tinted ring
  - a left stripe for started tasks
  - a background tint for bug priority
  - the title, with a milestone or bug icon
  - the task list, shown only when it differs from the parent's
  - the due date
  - the session count, with a live dot when a session is running
- **Preview.** Clicking a row opens a right-hand peek with:
  - the status, parent and title
  - where the task lives, its due date, last activity and linked PRs
  - its linked sessions, with the running one highlighted ("Open tab")
  - "Where I left off"
  - a primary action: Switch to running session, Resume latest, or Start session
- **Where I left off.** Generated only on demand from a "Summarize" action, which runs `claude -p --model haiku` over the tail of the latest linked transcripts. The result is cached per session.

### Today › My git and My reviews

- **Source.** `gh api graphql` every 2 minutes. It fetches my open PRs (review decision, CI rollup, mergeable state, draft flag, head branch), review requests, review threads and comments.
- **Needs reply.** A thread or review needs a reply when its last message isn't mine and I haven't marked it seen. Seen state is stored locally.
  - Those rows get an orange edge and a quoted excerpt.
  - Each has "Draft reply with Claude", "Open on GitHub" and "Mark as seen".
- **Groups:**
  - My git: Needs you, Ready to merge, Waiting on reviewers, Drafts. Filter by repo or "Reply needed", with a Hide drafts toggle.
  - My reviews: Changes requested, New this week, Waiting longer. Filter by repo; bots are hidden by default.
- **Drafts.** "Draft reply with Claude" runs a headless `claude -p` with the thread as context and puts the result in an editable draft. Sending goes through a confirm step that shows the exact text and target. The same flow covers Productive comments and status changes.
- **Notifications.** A native notification for each new needs-reply item. Which other events notify is open.

### Session ↔ task linking

- **Explicit.** A session started from a task, or linked by hand.
- **Inferred.** Strong signals only:
  - a Productive task URL in the first user prompts
  - a task id in the cwd or worktree name, or in the branch name
  - the session touched a PR that's linked to the task
- Every link stores its `via`, which the preview shows ("linked via PR #30227"). Links can be removed or added by hand.

### Local services

- **Config.** Services are ported from `prd`:

  | Service | Command |
  |---|---|
  | app | `pnpm start` |
  | api | `bundle exec sidekiq` |
  | e2e-tests | `npm run cli` |
  | exporter | `npm run start` |
  | pdf-generator | `npm run start` |
  | pdf-viewer | `npm run start` |
  | AI | `DEV_API_ENV=production pnpm start` |

  Each service has a cwd, a command, a health port, and extra shell panes.
- **Supervision.** Workbench spawns each service in a pty and handles start, stop and restart, the logs and a health check. Quitting asks whether to stop the services or leave them running.
- **Docker infra.** Status chips, plus `docker compose up` when something is missing.
- **Panes.** Panes split and resize like tmux. The header shows only the branch, worktree path and how far it is behind develop.
- **Worktrees.** Reads `~/.wtrc.json`.
  - The list is ordered by recency, with badges for merged / gone / dirty / unmerged and the same keys as `wt`.
  - Switching restarts `app` in the new worktree.
  - "Run alongside" starts a second app instance on the next free port.

### Shell chrome

- **TopBar.** Today and Local are fixed places in their own group, followed by the session tabs and ⌘K.
- **⌘K.** Searches workstreams, PRs and Productive tasks, and can run a slash command in the current session.
- **StatusBar.** Always visible, showing:
  - the active session's context, with `/compact` suggested at 60% or more and shown red at 75% or more
  - the 5h limit and when it resets
  - the week limit
  - the model · effort · permissions picker
- **Themes.** All dark, defined as CSS variable tokens. The design has Graphite, Midnight, Forest, Dusk (muted synth, purple accent) and Synthwave.

## Data model (SQLite)

| table | columns |
|---|---|
| `sessions` | id, cwd, transcript_path, started_at, last_event_at, state, external, title |
| `links` | session_id, task_id, via, created_by (auto/manual), created_at |
| `seen` | thread_key, last_seen_message_id, seen_at |
| `drafts` | id, target (gh thread / productive task), body, status, created_at |
| `summaries` | session_id, text, model, created_at |
| `settings` | key, value |

## Phases

Each phase must be usable daily before the next one starts.

1. **Shell + sessions.** Electron app, TopBar, PTY tabs, hooks + statusline wrapper, StatusBar, pickers, ⌘K (sessions only), external tabs, PR link provider. *Replaces the terminal and `cc`.*
2. **Local.** Service supervision, split panes, worktree switcher, run alongside. *Replaces `prd` and `wt`.*
3. **My tasks.** Productive poller, grouping, preview, linking, Summarize.
4. **My git / My reviews.** gh poller, needs-reply detection, notifications, drafts with confirm.
5. **v1.1.** Task workstream screen: milestone timeline, structure tree, Start work.

## Open questions

- **Picker commands.** Which commands or keys does the CLI accept mid-session for model, effort and permission mode? This decides whether PTY injection is enough or a picker change needs a restart with `--resume`.
- **Themes for v1.** Graphite + Dusk only, or all five?
- **Notification rules.** Which events notify (new reply, changes requested, CI failed, session waiting), and should there be quiet hours?
- **Packaging.** Is an unsigned `electron-builder` build in `/Applications` enough?
- **Hook install.** Does Workbench write and maintain the global hooks entry itself, with a backup, or are they set up by hand once?
