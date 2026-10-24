# Workbench — spec

**What this is:** the app as it is built now, screen by screen. Each section names its screenshot (`docs/design/current/*.png`, regenerated from the real app) and its code. When a change lands, its section here and its screenshot change in the same commit.
**Why things are this way:** [decisions.md](./decisions.md). **Explorations and variants:** `docs/design/explore/` and the design canvas; history, not the current state.
**Owner:** Matej Bošnjak · **Updated:** 2026-10-24

## Problem

Day-to-day work is spread across several `claude` sessions in terminal tabs, the `prd` tmux script for the local stack, `wt` for frontend worktrees, Productive for tasks, and GitHub for PRs and reviews, where replies to my comments are easy to miss. Switching context means re-finding the right session, worktree and PR for a task by hand.

## Goal

One personal desktop app that hosts Claude Code sessions as tabs, runs and switches the local stack, starts the day from one Today screen (Needs you, My tasks, My PRs, Reviews), and links tasks, PRs and sessions so each opens straight into the others.

## Non-goals

- No chat UI of its own: the real `claude` CLI runs in a terminal.
- Claude Code only; the agent model leaves room for Codex later.
- Just for me: no multi-user support, no distribution, no auto-update, no signed builds.
- Nothing is posted to GitHub, Productive or Slack without an explicit confirm.

## Architecture

```
Electron main (Node)                                  src/main
├─ sessions + pty-host   claude in node-pty; replay history; prefill    sessions.ts, pty-host.ts
├─ signal-server         unix socket; hook + statusline events         signal-server.ts, hooks-install.ts, state.ts
├─ TasksPoller           Productive REST, every 2 min                  productive/
├─ GitPoller             gh GraphQL, every 2 min                       github/poller.ts
├─ Linker                session ↔ task links, Summarize               linker.ts
├─ Suggester             link suggestions (rules only, no model)       suggest.ts
├─ FocusTracker, RunPr   a session's frontend PR; run it in `app`      focus-pr.ts, local/run-pr.ts
├─ Supervisor            local services, panes, worktrees, brew infra  local/
├─ GitHubPane            WebContentsView pool for github.com           github/pane.ts
├─ Workstreams           milestone/parent trees, on demand             workstreams.ts
├─ Caffeinate            powerSaveBlocker, Amphetamine, clamshell      caffeinate.ts, amphetamine.ts
├─ MemoryMonitor         ps sampling for ▌wb                           memory.ts
├─ Notifier, Drafts      native notifications; Claude-written drafts   notify.ts, drafts.ts
└─ Repo                  SQLite (better-sqlite3), append-only migrations   store/

Preload                  window.workbench IPC API                      src/preload/index.ts
Renderer (React 19 + Zustand)                                          src/renderer/src
├─ App, store, keys      views: today · local · session · workstream
└─ components/           one file per surface (below)
Shared (pure, tested)    src/shared: tasks, git, links, marks, runpr, pane, memory, workstream, agent
```

- **Hooks.** Settings → Install hooks backs up `~/.claude/settings.json`, adds only Workbench's marked entries for SessionStart, UserPromptSubmit, PostToolUse, Notification, Stop and SessionEnd, and offers Uninstall. Each entry runs a tiny client that sends `<kind> <wbId>` plus the JSON payload to the socket; with no socket it exits at once, silently. `WORKBENCH_SESSION_ID` tells Workbench's own tabs apart from external sessions.
- **Statusline.** The statusline becomes a wrapper that forwards the JSON (context %, 5h / week limits, model, effort) to the socket, then runs the previous statusline command unchanged. Uninstall restores it.
- **Tab state** from hook events: running (prompt submitted, or PostToolUse after a permission prompt), waiting (Notification), failed (non-zero exit), idle (Stop / not running).
- **Data.** `~/Library/Application Support/Workbench/workbench.db`, migrations append-only with `user_version` (7 now):

  | table | what |
  |---|---|
  | `sessions` | id, cwd, transcript_path, started_at, last_event_at, state, external, title, tab_order (NULL = closed), claude_id, model, effort, permission_mode, first_prompt, fork_from, title_locked |
  | `links` | session_id, task_id, via, created_by (auto / manual), created_at |
  | `link_tombstones` | links removed by hand; inference never re-adds them |
  | `summaries` | "where I left off" per session |
  | `seen` | conversation key → last message seen |
  | `drafts` | target, body, status, error |
  | `notes` | free-text note per workstream |
  | `session_prs` | PRs connected to a session by hand (link suggestion) |
  | `pr_tasks` | PRs connected to a task by hand, even when branch and body don't name it |
  | `suggest_dismissed` | link suggestions turned down, per session |
  | `settings` | JSON values: `productive:account`, `tasks:cache`, `sessionDefaults`, `defaultCwd`, `ui:*` (sidebar, snoozed, …) |

- **Packaging.** `pnpm install-app`: electron-builder `--mac dir`, copied to `/Applications/Workbench.app`. Unsigned, no auto-update; rebuild after pulling.

## Visual style

Image: every screenshot below. Code: `src/renderer/src/theme.css`, `styles.css`.

- TUI look: JetBrains Mono 12.5px with tabular numbers; 1px square boxes with the title set into the top border; the active box's border and title in the accent.
- Selected rows are filled with the accent, text in `--on-accent`.
- Theme **Dusk** only (muted synthwave on graphite, purple accent). Colours are CSS tokens.
- **Status colours.** Productive's 17 status colours each map to a bright stand-in (`statusVivid`) for marks, labels, the strip and chips; Productive's own pastel pairs (`statusColors`) stay for tag-style badges such as the status button.
- Shortcuts are never printed in the UI except in the ⌨ popover and tooltips.

## Shell: TopBar, StatusBar, keys

Image: `docs/design/current/keys.png` (⌨ popover); TopBar and StatusBar appear in every image. Code: `TopBar.tsx`, `StatusBar.tsx`, `keys.ts`, `App.tsx`.

- **TopBar** (56px, chrome background, 2px accent line below): `▌wb` memory button, places `1 Today` and `2 Local up/n`, a temporary workstream place when one is open (× closes it), a divider, session tabs `3…n`, `+` new session, then the caffeinate cup and ⌘K.
  - The current place or tab is filled/outlined in the accent.
  - **Session tabs** carry their state as a bar along the bottom edge: 2px at 45% on other tabs, 3px full on the current one. The current tab is a purple-tinted box, outlined top/left/right, with a 2px accent top line. A waiting tab that isn't current shows only the muted purple bar.
  - Tabs: double-click renames (a manual name sticks over claude's terminal title; clearing it unlocks), drag to reorder, middle-click closes, hover shows state, title and cwd. Caffeinated tabs show the cup at 13px.
  - **Overflow:** tabs never wrap or shrink; the strip scrolls sideways with no scrollbar. Hovering within 56px of an edge scrolls that way (faster nearer the edge; the cursor shows the direction only while there's more), the vertical wheel scrolls it, edges fade while tabs hide beyond them, and a `+N ▾` menu lists tabs out of view. The current tab always scrolls fully into view.
- **StatusBar** (38px, fixed-width cells so nothing moves): ⌨ shortcuts, the active session's state dot, name and age; in the middle the Run PR chip and a `⚠ hooks` chip when hooks or the statusline aren't installed (click installs); then the meters and the picker.
  - **ctx** (green, full-strength gradient; amber ≥ 60% with a `/compact` button that runs it, red ≥ 75%), **5h** (purple, `↻HH:MM` reset), **wk** (blue). 48px bars; the gradient's strength ranks them. Until a first value arrives the track shows a faint sweep and the value reads `—`. Hover shows the full text.
- **Keys** (only when no terminal or text field has focus):

  | Key | Action |
  |---|---|
  | j / k, ↑ / ↓ | move |
  | ⏎ | open |
  | tab | next pane (Today: Needs you → My tasks → My PRs → Reviews) |
  | r | run the selected frontend PR in the app |
  | s | new session (on the selected task in My tasks) |
  | / | filter (My tasks), else ⌘K |
  | g / v | My PRs / Reviews |
  | 1–9 | 1 Today, 2 Local, 3… sessions |
  | c | caffeinate popover |
  | z | sleep a Needs you item until tomorrow 08:00 |
  | m | mark the selected PR's replies seen (My PRs) |
  | ? | shortcuts popover |

  ⌘ shortcuts (menu): ⌘T new session, ⇧⌘T new session in folder…, ⌘W close tab, ⌘K switch or run, ⌘I task sidebar, ⇧⌘I PR sidebar, ⇧⌘[ / ⇧⌘] previous / next tab, ⌘[ / ⌘] previous / next bookmark, ⌘1–9 places and tabs.

## ⌘K palette

Image: `docs/design/current/palette.png`. Code: `Palette.tsx`.

- Groups: Sessions, Recently closed, Actions (new session, new session in folder…). Typing also searches Workstreams, Tasks and PRs (mine and reviews, bots excluded); every query word must match.
- `/command` runs a slash command in the current running session. `/model` and `/effort` are refused there (they rewrite the global defaults); the picker covers them.

## Today › Needs you

Image: `docs/design/current/today-needs.png`. Code: `TodayView.tsx` (Home, Peek), `needs.ts`, `NeedPreview.tsx`.

- **Counters** under the TopBar on every Today tab: Needs you, My tasks, My PRs, Reviews, 5h limit. Each has a big number with its breakdown stacked at the right (e.g. `2 PRs · 1 thread · 1 task`, `7 working · 10 in review`, `3 need a reply · 13 drafts`, `N waiting on authors · 11 bot PRs hidden`, `resets 16:00`). The active one (the tab shown) has a larger, glowing number and a near-white outline; switching eases over 0.25s. Clicking a counter switches tab; 5h isn't a tab.
- **Needs you** lists, newest first: changes requested, reply needed, CI failing, conflicts (on my PRs), and overdue tasks. Each row: kind, ref, text, detail, and `zz`.
  - `zz` / `z` sleeps an item until tomorrow 08:00; it wakes sooner if the item changes (a new message, push or due date). Sleeping items sit in a **Sleeping** box with "wake".
  - **Threads** box: up to six reply-needed conversations with the last message quoted; more link to My PRs.
- **Needs reply:** a conversation (an unresolved review thread, or the PR's own conversation of comments plus review bodies) whose last message isn't mine and isn't marked seen. Bots and bare approvals don't count.
- Click or ⏎ shows the item in the right sidebar; ⏎ again or a double-click opens it (a PR in the GitHub pane at its last message; a task into its session).
- **PR card** (sidebar): kind, ref with CI, title, branch, updated, the PR's task chips and best session (or `+ new ✻`), the latest message; ⏎ open, **draft reply with Claude**, ▶ Run app (frontend), sleep, open in browser.
- **Notifications** (native): a new reply or comment on my PR, changes requested, CI failed (not on drafts), a new review request, and a session waiting or finished (skipped while that tab is on screen and the window focused). Each opens its row or tab. The first poll only records what's there; more than four at once become one summary.

## Today › My tasks

Image: `docs/design/current/today-tasks.png`. Code: `TodayView.tsx` (Home, TaskStrip), `src/shared/tasks.ts`, `src/main/productive/tasks.ts`.

- **Source.** Productive REST with the keychain token, every 2 min plus refresh. The filter is my saved "List view" filter, discovered once from `/filters` and stored with org and person in `productive:account` (fallback: assigned to me, not started or started). The last result is cached so Today has something before the first fetch.
- Productive's assignee filter also returns tasks assigned to someone else where an open to-do is mine; a second call (`/todos`, mine, open, `include=task`) counts those to-dos per task.
- **Strip** above the list: a bar of the status mix, one chip per status with its count (click to filter, several allowed, "clear"), and **group by project / status** (remembered). Statuses are ordered nearest-done first; same-named statuses across workflows count as one.
- **Group by project** (default): Bugs first, then Product: CRM, then A–Z; within a project, placement order, nested under parent or milestone. Box titles `My tasks › <project> (n)`.
- **Group by status:** one box per status in strip order, titled in its colour; rows flat in project order.
- **Rows** (quiet, hairline-separated, no tint):
  - tree lines from parent to children (a continuous guide per level, `├` / `└` joints);
  - a glowing status dot in the status colour (a ring for not started, a diamond for a milestone);
  - the title exactly as in Productive; a parent is bold with its child count; a subtask shown without its parent names it in faint text;
  - the status name in its colour, due date (red when late), and the best session's mark plus count, or `+ ✻` on hover/selection to start one;
  - a context header (hollow diamond) for a parent that isn't mine ("not assigned to you") or is filtered out; click opens its workstream.
- **To-do-only rows** (assigned to someone else, in my list for my open to-dos): a `☐ N to-do(s)` chip and the assignee's avatar at the row end; my own rows have no avatar.
- `/` opens a title filter; j / k select; ⏎ or double-click continues the task (below); `s` starts a new session on it; `r` runs its frontend PR.

## Task card (Today sidebar and session task sidebar)

Image: `docs/design/current/today-task-card.png`. Code: `TaskPreview.tsx`, `TaskDetails.tsx`, `Chips.tsx`.

- **Card** (box titled `<project> › <task list>`): the parent (opens its workstream), the title (links to Productive, underlined in the status colour) with the **status button** (Productive's pastel tag; ▾ menu of the workflow's statuses, keyboard-navigable; a pick applies at once, no confirm), due and last activity.
- **PR** row: PR chips (▶ Run app on frontend ones); **sessions (N)** with **link ✻** to link an open session by hand.
- Linked sessions: mark, time, first prompt; × unlinks. **left off**: Summarize / refresh runs `claude -p --model haiku` over the latest linked transcript's tail; cached per session.
- On the box's bottom edge: **+ new ✻** (always a new session) and **⏎ continue** (switch to the live session, open the latest tab, or resume it; hidden with no session).
- **Productive box** below it: description (URLs clickable); **to-dos** with done count, `+` add form (text, assignee from my colleagues or unassigned), hide/show done; each to-do has a checkbox and an assignee avatar with a searchable people picker. On someone else's task, my open to-dos are highlighted. **comments** newest first under a composer that's one quiet line until focused, then three lines with `@` tagging (tags notify), post, and **draft with Claude**.
- Writes: comments, adding a to-do and ticking a to-do ask first with a native confirm showing the exact text and target. Status picks and to-do assignee picks apply directly (the pick is the approval).

## Today › My PRs

Image: `docs/design/current/today-prs.png`. Code: `GitView.tsx` (GitView, PrRow), `src/shared/git.ts`, `src/main/github/poller.ts`.

- **Source.** `gh api graphql` every 2 min: my open PRs (review decision, CI rollup, mergeable state, draft, head branch), review requests made to me directly (team requests don't count), threads and comments.
- Left list, right the GitHub pane (resizable split, remembered).
- Repo chips and **Hide drafts**. Grouped by stage, nearest to merge first: Ready to merge, In review, Changes requested (not yet addressed), Draft. A PR opened from a link that isn't in my lists gets a temporary **Opened** group.
- **Row:** a rail in the stage colour; ref and title; the task chip; ▶ Run app (frontend); `↩ N` when replies wait on me (opens the first in Needs you); age; an `n/4` score. Under it four checks, each ✓ / ✕ / ·: CI (no CI counts as passing), reviews, conflicts, open threads. 4/4 rows get a faint green tint. Within a stage: highest score, then most recently updated.
- ⏎ / click opens in the pane, ⌘-click the browser, `m` marks replies seen.

## Today › Reviews

Image: `docs/design/current/today-reviews.png`. Code: `GitView.tsx` (ReviewsView, ReviewRow).

- **Reviews** box: PRs waiting on my review (requested, or re-requested after I asked for changes), in **New this week** and **Waiting longer** (oldest first). Repo chips and **Hide bots** (on by default) apply to both boxes. The counter counts only this box.
- **You asked for changes** box: PRs where my latest review asked for changes and I haven't been re-requested; latest first.
- **Row:** ref, title, author (· bot), "your task" chip when it names one of my tasks, CI dot, ▶ Run app, age (amber after 3 days, red after 14).

## GitHub pane

Image: `docs/design/current/github-pane.png`. Code: `GitPane.tsx`, `PrLinks.tsx`, `src/main/github/pane.ts`, `src/shared/pane.ts`.

- An Electron `WebContentsView` (not an iframe) drawn over the right panel of My PRs / Reviews, or full width (⤢), or in a session's PR sidebar. One native view is shared; a still image stands in while an overlay or menu covers it.
- **Strip:** ref, state, CI, `N reply needed`, the **Task ▾** and **Session ▾** buttons, ▶ Run app (frontend), ‹ › history, `⌘↩ browser`, ⤢, ×.
  - **Task ▾**: the first task's rail, Productive logo and title (`+N`); the menu lists the PR's tasks with status. Click shows it in My tasks; ↗ opens Productive.
  - **Session ▾**: the best session's mark and title (`+N`); the menu lists sessions linked to those tasks plus any session working on this frontend PR, live first. Click switches (reopening a closed tab); "+ new ✻ for this task". With a task but no session, the button is `+ new ✻` directly. Hidden with neither.
- **Opening.** A click or ⏎ on a PR row. Any productiveio PR link elsewhere (terminal, cards, workstream) switches to My PRs or Reviews with it selected. ⌘-click always opens the browser. All of `github.com/productiveio/*` stays in the pane; other sites and new windows go to the browser.
- **Live views:** the 2 most recent PRs stay loaded (instant switch, scroll and typed text kept), least recent evicted first. Before evicting a page with text I typed and haven't sent, it asks; GitHub's prefilled boxes don't count.
- **Login:** its own persistent partition (`persist:github`): GitHub login with Google (choose "Try another way" at the passkey step), then the authenticator code. Google sign-in pages are allowed only within that flow. Settings → Sign Out of GitHub clears it. No Node integration, context isolation on.
- **Replies:** opening a PR never clears "reply needed"; my reply being last, or `m`, does. The PR is re-fetched when the page navigates and after a comment is submitted.
- **Draft reply with Claude:** `claude -p --model sonnet` writes the reply (read-only tools in my checkout of the PR's branch, else no tools); Workbench opens the thread, clicks Reply and fills GitHub's box. I post with GitHub's Comment button. If the box can't be found, the draft goes to the clipboard and the pane scrolls to the thread.
- **Keys** while it has focus: plain keys and Esc go to GitHub; ⌘J back to the list (leaves full width), ⌘[ / ⌘] back / forward, ⌘R reload, ⌘L copy URL, ⌘↩ browser, ⌘= / ⌘- / ⌘0 zoom (on top of the app zoom, default 115%, 70–200%, remembered), ⌘K and ⌘1–9 as everywhere.

## Links: tasks, PRs, sessions

Image: chips appear in `today-tasks.png`, `today-prs.png`, `github-pane.png`, `session.png`. Code: `src/shared/links.ts`, `Chips.tsx`, `linker.ts`.

- Worked out once in `links.ts` for every view (task row, card, session bar, GitHub pane, PR lists, Needs you), so they always agree.
- **Task chip:** status rail, Productive logo, title. Click shows it in My tasks; ⌘-click opens Productive.
- **PR chip:** GitHub logo, title, CI dot. Click opens the pane; ⌘-click the browser.
- **Session mark:** ● running / ● waiting / ● failed in the tab colours, ○ idle (tab open, claude exited), ↺ closed (resume). "Best" session = live first, then most recent.
- Chips cut short grow into the full title after 120ms hover or on focus (10% larger, state in words, accent glow, drawn above everything, growing leftwards near the right edge); no animation with reduced motion.
- **+ new ✻** (the spark means "session") always starts a new session on the task: tab named after it, linked "started from this task", in the task's worktree if one exists, and its first prompt prefilled (`lets look at this task <url> `) once claude's input box is up. A task session that never got a prompt gets the prompt again whenever it starts fresh.
- **Session ↔ task links:**
  - explicit: started from the task, linked by hand, or a link suggestion accepted;
  - inferred (strong signals only): a Productive task URL in the first 3 prompts; a task id in the cwd/worktree or branch name (only ids of my tasks); a PR the session touches (its branch, or its URL in a prompt) whose branch or body names the task.
  - Every link keeps its `via`, shown on hover. A link removed by hand is never re-added by inference.
- **A PR's tasks:** task ids in its branch, Productive task URLs in its body, plus tasks connected by hand (`pr_tasks`).

## Session view

Image: `docs/design/current/session.png`. Code: `Terminal.tsx`, `TermView.tsx`, `TaskSide.tsx` (SessionBar), `ExternalPanel.tsx`, `PrCard.tsx`, `src/main/sessions.ts`, `pty-host.ts`.

- **Spawning.** `claude` (or `claude --resume <id>`) in a pty, with `--model` / `--effort` / `--permission-mode` from the session's settings. Default cwd `~/Productive/work` (setting `defaultCwd`); a task session starts in the task's worktree when there is one. Fork (from a workstream) starts `--resume <id> --fork-session` in a new tab.
- **Terminal:** xterm.js with WebGL, 10,000 lines of scrollback; main keeps replay history so a reopened view redraws. Shift+⏎ sends a newline to claude; ⌘C copies a selection. URLs are links: productiveio PR links open the GitHub pane (⌘-click the browser) and show a hover card with state, review decision, checks and ▶ Run app (open frontend PRs); other URLs open the browser.
- **Session bar** (38px, raised, under the TopBar, only for Workbench sessions):
  - **Task button:** status rail, Productive logo, title, status, `⌘I` → task sidebar. No task: "link task…".
  - **PR button:** GitHub logo, title, CI state, `+N`, `⌘⇧I` → PR sidebar; hidden with no PR. The session's PRs, in order: connected by hand, the frontend PR its branch is on, PRs of its tasks.
  - `+ new ✻` for the same task; the branch (⎇) at the right. The open sidebar's button is lit.
- **External sessions** (started in another terminal, reported through the same hooks) are read-only tabs showing state and cwd, with **Take over**: waits for the terminal copy to exit, then resumes it here.

## Session bookmarks

Image: `docs/design/current/session.png` (rail), `docs/design/current/session-legend.png`. Code: `Marks.tsx`, `src/shared/marks.ts`, `src/main/marks.ts`.

- A 16px rail at the terminal's right edge with one mark per **prompt** (violet circle), **Subagent result** (teal diamond) and **question for you** (orange triangle), each glowing, placed at its position in the scrollback.
- Marks come from the transcript (read incrementally by offset; refetched every 2s while output flows) and are matched to the terminal buffer (`❯` prompts, `⏺` results, `⎿ ·` questions), newest first.
- Hover or focus shows the text, kind and time. Click jumps there with a short soft scroll and briefly outlines the line, then hands focus back to the terminal. ⌘[ / ⌘] step to the previous / next mark; arrows, Home and End move within the rail.
- `+N` at the top counts marks older than the scrollback (tooltip lists them). `?` at the foot opens the legend (Esc or click outside closes). Below 28rem width the rail hides; ⌘[ / ⌘] still work.

## Session task sidebar (⌘I)

Image: `docs/design/current/session-task-side.png`. Code: `TaskSide.tsx` (TaskSide).

- At the right of the terminal, 34% of the window by default (420–560px): the task card and Productive box (as in Today). Several linked tasks: chips at the top pick one. No task: a filter and a list of my tasks to link.
- Readability: the title at 14px without the status underline (it shows on hover); the parent on one line; labels (PR, sessions, left off, description, to-dos, comments) in a quieter tone than their content, with space between sections. URLs in descriptions, to-dos and comments read short: a GitHub PR or issue as `repo#n`, others without `https://`; the full URL is the tooltip.

## Session PR sidebar (⌘⇧I)

Image: `docs/design/current/session-pr-side.png`. Code: `TaskSide.tsx` (PrSide), `GitPane.tsx`.

- 45% wide by default: the GitHub pane on the session's PR, with chips to pick between several. × closes the sidebar.
- **Width (both sidebars):** drag the left edge to resize (←/→ when it has focus); double-click resets to the default. Each sidebar remembers its width (`ui:sideWidths`), never narrower than 320px or leaving the terminal less than 360px. The GitHub pane waits behind a still while dragging.

## Link suggestions

Image: `docs/design/current/session-suggest.png`. Code: `LinkSuggest.tsx`, `src/main/suggest.ts`.

- Rule-based, no model. A card under the session bar, one at a time (`+N more` waits behind it); × means "not this" and is remembered for the session (`suggest_dismissed`). Needs hooks.
- **Task id in a prompt:** a bare 7–9 digit number (not in a URL or path; at most 3 per prompt) that is a Productive task (my list first, else one cached lookup) and not already linked. Card: "Link task?", status dot, title, area, status; **Link** stores a manual link.
- **PR opened by the session:** a PR URL printed in its output that it opened: printed in a turn that ran `gh pr create`, or my own PR under 15 minutes old. A URL pasted in the prompt doesn't count. Card "New PR":
  - session has a task → **Connect** (PR to session and task) or **+ add PR to-do in Productive** (also a `PR: <url>` to-do, after a confirm);
  - no task but the PR's branch or body names one → **Connect both** or **PR only**;
  - no task → **Connect to session** or **+ pick a task…** (also opens the task sidebar).
- Connected PRs are stored (`session_prs`, `pr_tasks`) and show everywhere a task's or session's PRs do.

## Picker

Image: `docs/design/current/picker.png`. Code: `Picker.tsx`, `src/shared/agent.ts`.

- At the StatusBar's right edge: agent (Claude Code; Codex disabled), model (Opus 5.5 1M, Opus 5.5 200K, Sonnet 5.5, Haiku 5.5, Fable 5.1), effort, permissions (ask, auto, accept edits, plan, bypass). It shows what's in effect: live statusline/hook data, then the session's flags, then defaults; "no flag" shows what claude resolves it to.
- With no session it sets the defaults for new sessions (default permission mode: bypass). On a running session it saves the flags and restarts it in place with `--resume`; mid-turn, after the turn's Stop.

## Caffeinate

Image: `docs/design/current/caffeinate.png`. Code: `CaffeinateControl.tsx`, `Cup.tsx`, `src/main/caffeinate.ts`, `amphetamine.ts`.

- A 44px espresso cup in the TopBar: empty grey (Off), coffee with animated steam and a coffee glow (Awake), plus a cyan shut-laptop badge and glow (Lid closed). Steam stops with Reduce Motion.
- Click or `c` opens the popover: Off / Awake / Lid closed (`o` / `a` / `l`), each with a note, and **applies to: this session / all**. Esc closes.
- **Awake:** `powerSaveBlocker('prevent-app-suspension')`; turns itself off when the scoped sessions stop.
- **Lid closed:** on AC power, via Amphetamine's AppleScript (`start new session` indefinite + `enable closed display mode`; `end session` only for a session Workbench started, remembered across crashes; asks before replacing one it didn't start). Needs Amphetamine's Power Protect helper; otherwise unavailable with the reason shown. Without Amphetamine, available only in clamshell mode (AC + external display) via `caffeinate -s`. Unplugging falls back to Awake with a notification.

## Memory (`▌wb`)

Image: `docs/design/current/memory.png`. Code: `Memory.tsx`, `src/main/memory.ts`, `src/shared/memory.ts`.

- `▌wb 2.4G`: total of Workbench's processes, every session's process tree, and local services. The `▌` blends light purple → purple → dark purple → dark red → bright red in steps of 1/12 of RAM (OKLab, eased 0.8s); critical memory pressure forces bright red.
- Click opens the popover (Esc / outside closes): total with RAM and pressure, a 30-minute sparkline and change, a bar split Workbench / Sessions / Local services, and three sections: **Workbench** (window, main, GitHub pages with "close idle", GPU, helpers, headless claude runs), **Sessions** (each tab's tree by size, e.g. `claude 312 · node ×2 96`, ↗ for 30 MB+ growth over 10 min, click opens it), **Local services** (each service and its shell panes).
- Sampling: one `ps` plus the pressure sysctl every 30s, every 5s while open.

## Workstream

Image: `docs/design/current/workstream.png`. Code: `WorkstreamView.tsx`, `src/main/workstreams.ts`, `src/shared/workstream.ts`.

- One screen per milestone or parent task, opened from a task's parent, a context header, or ⌘K; it shows as a temporary TopBar place until closed.
- Loaded on open and Refresh, never polled: the Productive tree (root plus 3 levels, including others' and closed subtasks) and history; PRs from a GitHub search in productiveio for the tree's task ids (rollup PRs mentioning many tasks are skipped unless their branch names the task); transcript line counts and durations.
- Header: title, status, **Post update to task** (Productive comment draft with confirm), **Resume last session**. Tabs: **Timeline** (sessions, PR events, task events in time order, filterable by subtask), **Sessions · N** (Open tab / Resume, Fork with context), **PRs · N**, **Notes** (local).
- Side: **Structure** tree with status, PR, worktree and session chips; every row ends with the assignee's avatar (mine ringed violet, unassigned a dashed ring); closed subtasks folded behind "show N closed". **Start work** per open subtask of mine: switch to its running session, or start one in its worktree; without one, pick a repo and Workbench creates `feature/<taskId>-<slug>` in `<worktrees>/<repo>-<taskId>-<slug>` from `origin/<default>` after a confirm showing the commands (or "No worktree · default folder"). **Where I left off** with Summarize latest.

## Local

Image: `docs/design/current/local.png`. Code: `LocalView.tsx`, `Panes.tsx`, `WorktreeSwitcher.tsx`, `src/main/local/`.

- **Config** (`services.json` in the data folder, seeded from `prd`): app (`pnpm start`, port 4201, 2 panes), api (`bundle exec sidekiq`), e2e-tests (`npm run cli`), exporter, pdf-generator, pdf-viewer (`npm run start`), AI (`DEV_API_ENV=production pnpm start` in `ai-agent`). Profiles: prd · full, Frontend only, AI work, Exports & PDF.
- Header: profile switch, **Stop all**, **Start missing (n)**. A Run PR job shows inline here while it runs.
- Left: services in the profile with status dot, uptime and state; **Infra · brew services** chips (mysql, redis, memcached, meilisearch, nginx), a stopped one starts on click.
- Right: the branch button (opens the worktree switcher), path and how far behind its base, Open in browser, Start / Restart / Stop, and split, resizable terminal panes (service log plus shells; layout saved per service).
- Services run inside the app: quitting stops them, after a confirm while any run.
- **Worktree switcher** (from `~/.wtrc.json`): filter, recency order, badges (● dirty, ✓ merged, ⬆ gone, ⚠ unmerged). ⏎ switch and run, ⌘O switch, ⌘. open in editor, ⌘⌫ remove, **Run alongside on new port**.

## Run PR in app

Image: chip in the StatusBar of `session.png`. Code: `RunPr.tsx`, `src/main/focus-pr.ts`, `src/main/local/run-pr.ts`, `src/shared/runpr.ts`.

- **Focus PR** per session from signals: its cwd is a frontend worktree on a PR's branch, or a frontend PR URL / `#n` in its prompts or output (strongest, newest wins); then a PR of its task, or a `gh pr view/checkout/diff <n>` it ran.
- **Chip:** "App · <branch> → Session · fe #n ▶ Run" on a mismatch; "Switching app to fe #n · step i of n" with a bar while running; "✓ App on fe #n · <url>" when they match; "Run fe #n failed · details"; ↩ Back after a base-checkout run.
- ▶ Run app also on frontend rows in My PRs / Reviews, the task card's PRs, Needs you's PR card, the GitHub pane strip and the terminal PR card.
- **Worktree found** (by branch, then upstream, then head commit, only under `.wtrc` worktree folders): stop `app`, run the repo's command there.
- **No worktree:** the base checkout (`app`'s folder, `~/Productive/app`; never `~/Productive/work/repos/frontend`). A dirty tree asks: Stash and continue / Run alongside / Cancel. Then fetch, checkout (remembering the previous branch and stash for ↩ Back), `pnpm i` only if the lockfile changed, build lib · ui · form · prosemirror when their sources changed, restart, wait for the app to answer.
- **Run alongside:** a second `app` on the next free port, from the worktree or a detached `frontend-review-<n>` worktree. A port held by a process Workbench didn't start stops the run with that message.
- The run panel (from the chip or inline in Local) shows steps, a log tail and Cancel.

## Open questions

- Lid-closed keep-awake on battery or without an external display: verify what `caffeinate -s` actually allows.
- Quiet hours for notifications: none for now.
