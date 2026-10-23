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
- **Hooks.** Workbench installs them itself via Settings → Install hooks. It backs up `~/.claude/settings.json` first, adds only its own entries (marked so they can be found), and has an Uninstall action. The entries are global hooks (Notification, Stop, SessionStart, SessionEnd, UserPromptSubmit). Each one runs a tiny client that writes `{event, session_id, cwd, transcript_path, …}` to the Workbench socket. If the socket is missing, the client exits right away, in under 50ms, and prints nothing.
- **Statusline.** The configured statusline becomes a wrapper. It forwards the statusline JSON to the socket (`context_window.used_percentage`, `rate_limits.five_hour`, model, effort) and then runs the currently configured statusline command (`~/.claude/statusline-command.sh`), so terminal output stays exactly as it is now.
- **Tab states:**

  | State | Shown when |
  |---|---|
  | running | a prompt was submitted and no Stop has arrived |
  | waiting for you | a Notification arrived, e.g. a permission prompt or idle input |
  | failed | the process exited non-zero |
  | idle | the session is stopped |

  Tabs show the state as a coloured overline, and the open tab moves it to an underline.
- **External sessions.** Sessions started in a normal terminal report through the same hooks. They appear as read-only "external" tabs. "Take over" waits for the terminal copy to exit, then resumes the session inside Workbench.
- **PR links in terminal output.** An xterm link provider recognises `github.com/<org>/<repo>/pull/<n>`. A click opens the PR's row in My git or My reviews (GitHub when it's in neither), and ⌘-click opens GitHub. Hovering shows a card with the PR's state and CI status.
- **Pickers.** The picker lives in the StatusBar (toolbar).
  - New sessions start with `--model`, `--effort` and `--permission-mode` from the picker. The defaults are stored in settings.
  - A change to a running session restarts it in place with `claude --resume <id>` and the new flags. If a turn is in progress, the restart waits for its Stop.
  - Typing `/model` or `/effort` into the session is not used: claude saves those as the global default in `~/.claude/settings.json` (`model`, `modelSettings.*.effortLevel`), which would change every other session. Permission mode is only reported in hook payloads, so it can't be confirmed live either.

### Caffeinate

Keeps the Mac awake while sessions run.

- **Control.** A ☕ button in the StatusBar, next to the agent picker, opens a menu with three states and a scope (This session / All sessions):

  | State | What it does |
  |---|---|
  | Off | the Mac sleeps as usual |
  | Awake | stays awake while the session(s) run, using Electron `powerSaveBlocker('prevent-app-suspension')` |
  | Awake, lid closed | keeps running with the lid shut; needs power |

- **Auto-off.** "Awake" turns itself off when the scoped session(s) stop.
- **Lid closed.** `caffeinate` can't stop lid-close sleep on Apple Silicon, so this mode drives **Amphetamine** (installed) through its AppleScript dictionary (checked with `sdef /Applications/Amphetamine.app`), run via `osascript`:
  - Start: `start new session with options {duration:0, interval:0, displaySleepAllowed:true}`, then `enable closed display mode`.
  - Stop: `end session`, but only for a session Workbench started. Workbench records that it started it, and reads `session is active` to keep its state in sync.
  - `start new session` ends any running Amphetamine session, Trigger sessions included. If one that Workbench didn't start is already running, Workbench asks before replacing it.
  - **One-time setup:**
    - Install Amphetamine's **Power Protect** helper (needed on Apple Silicon, otherwise every session asks for Touch ID or a password).
    - Dismiss the closed-display warning once with "Do Not Show This Message Again" (Preferences → Sessions).

    Workbench checks that Amphetamine is installed and that Power Protect is (it installs `~/Library/Application Scripts/com.if.Amphetamine/powerProtect.scpt`). If either is missing, "Lid closed" shows as unavailable and says what's missing. Scripting access is checked on first use, when macOS asks once for Automation permission.
  - **Power.** If power is unplugged, the mode falls back to Awake and sends a notification.
  - **To verify by hand:** that `enable closed display mode` really keeps the Mac running with the lid shut. Its dictionary notes mention the "Allow system to sleep when display is closed" preference, so the meaning could be inverted.
  - **Rejected:** `sudo pmset disablesleep 1`. It needs root, reports disagree on whether it works on Apple Silicon, and it disables sleep everywhere, battery included.
- **Icon.** An espresso cup on a saucer (design variant 4h). Off is an outline cup. Awake is a filled cup with animated steam; the steam stops if Reduce Motion is on. Lid closed adds a small shut-laptop badge in the info colour.
- **Tabs.** Caffeinated session tabs show the icon at 13px after the title.
- **Lid closed availability.** The option is enabled on AC power when the Amphetamine setup check passes; no external display is needed. Without Amphetamine, it is enabled only in Apple's clamshell mode (AC power plus an external display).

### Today › My tasks

- **Source.** The Productive REST API, using the token from the macOS keychain. The filter is the saved "List view" filter, read once from the API's saved filters (`/filters`, creator = me) and stored in settings with the org and person ids.
- **Shape.** Tasks are grouped by project, with Bugs pinned first, then Product: CRM, then the rest alphabetically. Inside a project they're ordered by placement and nested under their parent or milestone.
  - A milestone that isn't mine gets a muted header.
  - A parent hidden by a filter shows as "filtered out".
  - Subtasks don't repeat the parent's task list.
- **Row.** Each row shows:
  - a status glyph: a ring in the status colour, with a filled core once started; not-started statuses get a dashed, tinted ring
  - a left stripe for started tasks
  - a background tint for bug priority (not shown yet: none of the current bug tasks carry a priority field)
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
- **Needs reply.** A thread or review needs a reply when its last message isn't mine and I haven't marked it seen. Seen state is stored locally. A conversation is an unresolved review thread, or the PR's own conversation (comments plus review bodies). Bots and bare approvals don't count as messages.
  - Those rows get an orange edge and a quoted excerpt.
  - Each has "Draft reply with Claude", "Open on GitHub" and "Mark as seen".
- **Groups:**
  - My git: Needs you, Ready to merge, Waiting on reviewers, Drafts. Filter by repo or "Reply needed", with a Hide drafts toggle.
  - My reviews: Changes requested, New this week, Waiting longer. Filter by repo; bots are hidden by default. PRs where my latest review asked for changes stay listed under Changes requested.
- **Drafts.** "Draft reply with Claude" runs a headless `claude -p --model sonnet` with the thread as context (read-only tools, in my checkout of the PR's branch when there is one) and puts the result in an editable draft. Sending goes through a native confirm that shows the exact text and target. The same flow covers Productive comments ("Comment…" in the task preview). Productive status changes are not built yet.
- **Notifications.** A native macOS notification for each of:
  - a new reply or comment on my PR
  - changes requested
  - CI failed on my PR
  - a session waiting for me (permission prompt or finished)
  - a new review request

  Each notification opens the matching row or tab. The first poll on a fresh install only records what's there; more than four new items at once become one summary notification. Session notifications are skipped while that tab is on screen.

### Session ↔ task linking

- **Explicit.** A session started from a task, or linked by hand.
- **Inferred.** Strong signals only:
  - a Productive task URL in the first user prompts
  - a task id in the cwd or worktree name, or in the branch name
  - the session touched a PR that's linked to the task
- Every link stores its `via`, which the preview shows ("linked via PR #30227"). Links can be removed or added by hand; a link removed by hand is not re-added by inference.
- Task ids in paths and branches only count when they match one of my tasks, so other 7–9 digit numbers don't create links. A session touches a PR when it runs on the PR's branch or a prompt contains the PR's URL; the PR's tasks come from a task id in its branch or a task URL in its body.

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

  Each service has a cwd (`~/Productive/<service>`, `~/Productive/ai-agent` for AI), a command, a health port where known, extra shell panes, and profile tags (prd · full, Frontend only, AI work, Exports & PDF). The config is a JSON file in Workbench's data folder, seeded from `prd`.
- **Supervision.** Workbench spawns each service in a pty and handles start, stop and restart, the logs and a health check. Services run inside the app, so quitting Workbench stops them (it asks first while any are running).
- **Infra.** mysql, redis, memcached, meilisearch and nginx run as Homebrew services on this machine, not Docker. Status chips come from `brew services list`, and a stopped one can be started with `brew services start`.
- **Panes.** Panes split and resize like tmux. The header shows only the branch, worktree path and how far it is behind develop.
- **Worktrees.** Reads `~/.wtrc.json`.
  - The list is ordered by recency, with badges for merged / gone / dirty / unmerged and the same keys as `wt`.
  - Switching restarts `app` in the new worktree.
  - "Run alongside" starts a second app instance on the next free port.

### Run PR in app

One click runs the frontend PR you're working on or reviewing in the `app` service. No more going back to a terminal to find the worktree or switch branches. Design: `docs/design/RunPR.dc.html`.

- **Focus PR.** Each session gets a focus PR from these signals, strongest first:
  1. its cwd is a frontend worktree whose branch belongs to an open PR
  2. a frontend PR URL or `#n` in its prompts (UserPromptSubmit) or terminal output (link provider)
  3. a frontend PR linked to the session's task
  4. a `gh pr view/checkout/diff <n>` it ran

  The newest strong signal wins.
- **Mismatch chip.** Local knows which branch `app` runs. When the active session's focus PR differs, the StatusBar shows "App · <branch> → Session · fe #<n> [▶ Run]". When they match it shows "✓ App on fe #<n> · localhost:4200".
- **Entry points.** ▶ Run app appears on:
  - frontend rows in My git and My reviews, with a hint under the button: "worktree · <name>" or "base checkout · fetch first". The PR already in the app gets an "In app" badge instead.
  - linked PRs in the task preview
  - the PR hover card in terminals
  - the mismatch chip
- **Resolve the PR to a worktree.** Use `git worktree list --porcelain`, only inside the `worktreesDir` folders from `~/.wtrc.json`. Match the PR on, in order:
  1. branch name equals `headRefName`
  2. the branch's upstream equals `origin/<headRefName>`
  3. the worktree HEAD contains `headRefOid`

  Branches get renamed, as with fe #30227 (`21071355-…`) and the worktree on `20360127-…`, so name matching alone isn't enough.
- **Worktree found:**
  1. stop `app`
  2. run the per-repo command from `~/.wtrc.json` (`pnpm i && pnpm start`) in that worktree
- **No worktree** (typically a review): use the base checkout, the folder the `app` service is configured with in `services.json` (`~/Productive/app`, the clone the app runs from day to day). Never touch `~/Productive/work/repos/frontend`, which is the read-only reference clone.
  1. **Dirty check.** If the tree has uncommitted changes, ask: Stash and continue (stash named `workbench: before fe #<n>`) / Run alongside / Cancel.
  2. `git fetch origin <headRefName>`. For a fork PR, `git fetch origin pull/<n>/head:pr-<n>`.
  3. `git checkout` that branch, after saving the previous branch or detached HEAD and any stash, for ↩ Back.
  4. `pnpm i`, skipped when `pnpm-lock.yaml` is unchanged since the last install in that checkout.
  5. Build the workspace packages (lib, ui, form, prosemirror) when their sources changed. A fresh checkout doesn't compile without them.
  6. Restart `app`.
- **Run alongside.** Starts a second `app` on the next free port instead of replacing the running one. A PR with a worktree runs from it; one without gets a detached review worktree `<worktrees>/frontend-review-<n>`, since the base checkout is where the main `app` runs.
- **Port in use.** If the app's port is held by a process Workbench didn't start (e.g. the `prd` tmux session), the run stops with that message instead of starting a second server on the same port.
- **Run panel.** The run shows as a job in Local and in a popover from the chip: each step with done, running, skipped or pending; a live log tail; Cancel; and Run alongside instead.
- **Back.** After a base-checkout run, the chip offers "↩ Back to <previous>". It restores the branch, pops the stash and restarts `app`.

### Shell chrome

- **TopBar.** Today and Local are fixed places in their own group, followed by the session tabs and ⌘K.
- **⌘K.** Searches sessions, workstreams, PRs and Productive tasks, and runs a slash command in the current session (`/model` and `/effort` are refused there because they rewrite the global defaults; the picker covers them).
- **StatusBar.** Always visible, showing:
  - the active session's context, with `/compact` suggested at 60% or more and shown red at 75% or more
  - the 5h limit and when it resets
  - the week limit
  - the model · effort · permissions picker
- **Theme.** v1 ships **Dusk** only: muted synthwave on a graphite base, with a purple accent. Colours are CSS variable tokens, so more themes can be added later; the design also explores Graphite, Midnight, Forest and Synthwave.

### Task workstream (v1.1)

- **What.** One screen per milestone or parent task with all its subtasks. It opens from the task preview ("Workstream"), a context header in My tasks, or ⌘K, and shows as a temporary place in the TopBar until closed.
- **Data.** Loaded when opened and on Refresh, never polled. The tree (root plus 3 levels, including other people's and closed subtasks) and its history (subtasks created, status changes) come from Productive. PRs come from a GitHub search in the `productiveio` org for the tree's task ids; release-style PRs that mention many tasks are skipped unless their branch names the task. Session cards read line counts and duration from the transcripts.
- **Timeline.** Sessions, PR events (opened, merged, closed) and task events in time order, filterable by subtask. Closed subtasks that aren't mine and have no sessions or PRs stay out of it.
- **Sessions.** Resume, or Fork with context: a new tab started with `claude --resume <id> --fork-session`, linked to the same tasks.
- **Structure.** The tree with status, PR, worktree and session chips; closed subtasks are folded.
- **Start work.** Per open subtask of mine: switch to its running session, or start one in its worktree. Without a worktree, pick a repo and Workbench runs `git fetch` + `git worktree add -b feature/<taskId>-<slug> <worktrees>/<repo>-<taskId>-<slug> origin/<default>` after a confirm that shows the exact commands.
- **Where I left off, Notes.** Summaries of the latest sessions (Summarize on demand) and a local free-text note per workstream.
- **Post update to task** uses the Productive comment draft and its confirm.

## Data model (SQLite)

| table | columns |
|---|---|
| `sessions` | id, cwd, transcript_path, started_at, last_event_at, state, external, title, tab_order, claude_id, model, effort, permission_mode, first_prompt, fork_from |
| `links` | session_id, task_id, via, created_by (auto/manual), created_at |
| `link_tombstones` | session_id, task_id (links removed by hand) |
| `seen` | thread_key, last_seen_message_id, seen_at |
| `drafts` | id, target (gh thread / productive task), body, status, created_at |
| `summaries` | session_id, text, model, created_at |
| `notes` | workstream_id, body, updated_at |
| `settings` | key, value |

## Phases

Each phase must be usable daily before the next one starts.

1. **Shell + sessions.** Electron app, TopBar, PTY tabs, hooks + statusline wrapper, StatusBar, pickers, caffeinate, ⌘K (sessions only), external tabs, PR link provider. *Replaces the terminal and `cc`.*
2. **Local.** Service supervision, split panes, worktree switcher, run alongside. *Replaces `prd` and `wt`.*
3. **My tasks.** Productive poller, grouping, preview, linking, Summarize.
4. **My git / My reviews.** gh poller, needs-reply detection, notifications, drafts with confirm.
5. **v1.1.** Task workstream screen: milestone timeline, structure tree, Start work.
6. **Run PR + lid closed.** Focus-PR detection, mismatch chip, ▶ Run app entry points, worktree / base-checkout run jobs with dirty guard and ↩ Back, Run alongside; Amphetamine-backed lid-closed caffeinate with its setup check.

## Packaging

`electron-builder` builds `/Applications/Workbench.app` locally, and I rebuild after pulling. The build is unsigned, so the first launch needs right-click → Open. No auto-update.

## Open questions

- **Quiet hours** for notifications: none for now; revisit after using it.
