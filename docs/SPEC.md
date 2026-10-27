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
- **`wb` and the workbench skill.** Install also writes `wb` next to the hook clients and the `workbench` skill to `~/.claude/skills/workbench/` (Uninstall removes it; until it's there the `⚠ hooks` chip asks for a reinstall). Workbench tabs get `wb` on their PATH. `wb` sends one line, `cmd <wbId> <name> <args>`, over the same socket (`nc`, no Node) and prints the text reply: `status` (this tab's task(s) with id, status, project, URL; its PRs with CI, review decision, reviewers, branch; cwd and branch), `tasks [filter]`, `prs [filter]`, `link-pr` / `unlink-pr <url>`, `link-task <id|url>` / `unlink-task <id>`. Links are Workbench's own (`session_prs`, task links); nothing is posted to GitHub or Productive. The skill applies only when `WORKBENCH_SESSION_ID` is set, and tells Claude to read `wb status` when asked what the session is about and to `wb link-pr` a PR it just opened with `gh pr create`. Code: `src/main/wb.ts`, `resources/bin/wb`, `resources/skills/workbench/SKILL.md`.
- **Statusline.** The statusline becomes a wrapper that forwards the JSON (context %, 5h / week limits, model, effort) to the socket, then runs the previous statusline command unchanged. Uninstall restores it.
- **Tab state** from hook events: running (prompt submitted, or PostToolUse after a permission prompt), waiting (Notification: a permission prompt or a question; not claude's "waiting for your input" reminder a minute after every turn, `notification_type: idle_prompt`, which changes nothing), failed (non-zero exit), idle (Stop / not running). An idle session that left **background work** out (see Session view) says so.
- **Data.** `~/Library/Application Support/Workbench/workbench.db`, migrations append-only with `user_version` (8 now):

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

Code (plumbing that every screen rests on): `src/main/index.ts`, `claude.ts`, `hooks-install.ts`, `signal-server.ts`, `state.ts`, `shell-env.ts`, `notify.ts`, `src/main/store/`, `src/main/productive/client.ts`, `src/main/github.ts`, `src/shared/types.ts`, `src/renderer/src/store.ts`, `src/renderer/src/main.tsx`, `src/renderer/index.html`, `env.d.ts`, `Box.tsx`, `xterm-theme.ts`.

## Visual style

Image: every screenshot below; the other themes in `theme-muthur.png`, `theme-brown.png`, `theme-console.png` and their `-session` shots. Code: `src/renderer/src/theme.css`, `styles.css`, `themes.css`, `src/shared/theme.ts`, `SevenSeg.tsx`.

- TUI look: JetBrains Mono 12.5px with tabular numbers; 1px square boxes with the title set into the top border; the box holding the selection gets a lighter border and title.
- **Violet means "needs you".** The accent marks waiting sessions (+N count, row marks, question bookmarks; not the tabs, see below), the Needs-you number, primary actions and the ▌wb mark. Selection and "current" don't use it, except the current session tab: selected rows, the current place, picked chips and the open sidebar's button are raised with a light outline or bar, and keep their own colours. Amber isn't an attention colour either; it's Productive's Working status, effort, and meter warnings.
- **Still at rest.** Nothing loops; glow is kept for a waiting tab and the Needs-you number. Plain ground behind lists and the terminal.
- **Themes.** Dusk (muted synthwave on graphite, purple accent) is the default; three cassette-futurism themes can be picked from the app menu (Workbench › Theme) or ⌘K (`theme`). The choice is the setting `ui:theme` (mirrored in localStorage so the first paint has it) and applies at once as `data-theme` on `<html>`; open terminals switch colours, face and size in place. Colours are CSS tokens; each theme replaces them and restyles the shell in `themes.css`; terminals read `--term-font` / `--term-size` / `--term-line`.
  - **MU/TH/UR:** amber phosphor on near-black, VT323 (scaled to JetBrains Mono's x-height with `font-size-adjust`, so sizes and column widths hold), light scanlines and a soft vignette over the whole window, chrome in capitals. Task rows and status chips print a three-letter status code in the status colour instead of the name and drop the dot; Working is reverse video. Counters print two digits; My PRs blue, Reviews violet; Needs you hot red (the accent). The current place and tab are reverse video. Meters are block cells. Terminals use VT323 at 21px with no synthetic bold, and are left out of the `font-size-adjust` (xterm measures its cell in the DOM but draws on a canvas, so an adjusted measure overlaps the glyphs).
  - **Brown workstation:** smoked-brown chrome, Space Mono; places, top-bar buttons and tabs are keycaps, the current one the orange key, pressed; `▌wb` carries the four sunset stripes; each counter has its stripe colour down the left and its number in it; box titles small amber capitals; faint scanlines; the meters sit on a grey-green LCD strip with dark segments.
  - **Ops console:** slate panels on a perforated ground, Share Tech Mono, a cream → orange → rust → brown stripe under the top bar; box and counter titles on embossed Dymo tape (Needs you on red tape); counters are screwed plates with seven-segment LED digits (amber, Needs you red); status dots are glowing lamps and status names small capitals; status chips carry a toggle switch; meters are green LED ladders.
  - Segmented meters (Muthur, Brown, Console) drop the quarter cuts; the ctx thresholds and the pace mark stay (on Brown the pace mark is LCD ink).
- **Session colours tell sessions apart; they never mean state.** Each session gets one of seven colours when its tab opens and keeps it: a 2px bar at the tab's left, the current tab's 2px top line, its +N row and the status bar. The new tab's colour is the one furthest round the palette from the two tabs before it, then the least used, so neighbours never match. The palettes are muted and darker than the bright status colours, and leave out the accent: Dusk clay, ochre, moss, teal, slate, rose, stone; Brown 70s upholstery (no orange, the current key); Ops console Dymo tape (no red or orange). MU/TH/UR prints a block sigil (▚ ▞ ▀ ▄ ▌ ▐ ▓) before the title instead, in the phosphor. State is a glyph after the title, the same in every theme: a round white **?** and a bold title while waiting, a dim `···` while running, a boxed **!** after a failed run, a dim `◷` when its turn ended with background work still out, nothing when idle. Hovering a glyph says what it means: the waiting session's own message ("Asks you: Claude needs your permission to use Bash"), the background tasks one per line ("wakes by itself").
- **Status colours.** Productive's 17 status colours each map to a bright stand-in (`statusVivid`) for marks, labels, the strip and chips; Productive's own pastel pairs (`statusColors`) stay for tag-style badges such as the status button.
- Shortcuts are never printed in the UI except in the ⌨ popover and tooltips.
- **No task or PR numbers on screen.** A PR reads as its repo (`fe`, `api`, `specs`) and title, a task as its title; GitHub links in text read `frontend PR`. Numbers stay in tooltips, search, git commands, and anything sent to Claude or GitHub. Notifications name the PR by title (`CI failed: <title>`).
- People show as their GitHub avatar (18px, round) with a 1.5px ring in their state colour, then the login (PR reviewers).
- Sidebars share one frame: 18px/14px padding and a box with its title set into the top border and its tools at the right (task sidebar, PR sidebar).
- Columns of stacked items keep a fixed width so they line up from row to row whether or not a row has a button (My PRs: checks and score columns are 84px, 28px apart; the score and Run app are centred one above the other; stacked lines use line-height 1.35 so a 3-check row stays about 60px).
- Status-bar meters are compact: label, a short bar, the value in a fixed 4ch so nothing moves.
- Buttons in one bar share its height (the session bar's are all 28px, `+ new ✻` included).
- Bars don't box their buttons: the top bar and session bar buttons are text on the bar, raised on hover; boxes are kept for content (lists, sidebars, cards). A session-bar button's state is a left mark (6px for the task status, which shows no status name), never a dot.
- A bar item with several things splits into segments, one per thing (the session bar's PRs): the icon once in front, no hairlines between segments, each raised on hover and lit on its own.
- A filter row above a long scrolling list stays pinned at its top (the workstream's Show row). A resizable sidebar shows its edge as a 2px line on hover or while dragging.
- Badges on a place button: a 15px round red ! at its top-right corner with a chrome ring; its hover card is a popover box under it. The aws chip takes the infra chip shape: ok dot green, expired tinted bad, logging in tinted accent with a pulsing dot.
- Status in pane headers: a crashed service's pane header says `· crashed · exit n` in the bad colour. Switcher sections (Worktrees, Branches) use small uppercase headers; a branch row is shorter than a worktree row and badged `local` (raised) or `remote` (info).
- Popovers open under the button that opens them, right-aligned to it (the TopBar cup's, the session bar cup's): popover colour, a heavy line and a shadow.
- Checkbox rows aren't wrapped in a `<label>` when their text holds links or sits next to a write: only the box itself is a hit target.
- My PRs and Reviews rows share one layout (rail, title over people, stacked checks, Run app column), so the two lists read the same.
- Window-like buttons take macOS traffic-light colours, softly tinted at rest (80% toward the muted text) and full on hover: × red (close), unlink yellow, ⤢ green. Tab × stays grey. Unlink is one icon everywhere (a link with a slash): PR sidebar, task sidebar, session rows.
- Pickers that link things (a PR to a session, a PR to a task) are one pattern: a menu with a filter box, rows in the list's own look (repo + title + CI dot, or status rail + title + status), already-linked rows dimmed, ↑↓ ↵ esc, and a hint line at the bottom.
- Status icons that need to read at bar size are pixel art on a whole-pixel grid (the Local Mac: 12×12 at 24px) rather than thin outlines; an unlit screen is the muted text colour at 22% on the bar.

## Shell: TopBar, StatusBar, keys

Image: `docs/design/current/keys.png` (⌨ popover); TopBar and StatusBar appear in every image. Code: `TopBar.tsx`, `SessionMark.tsx`, `StatusBar.tsx`, `keys.ts`, `App.tsx`, `src/shared/sessionColor.ts`, `src/main/store/repo.ts` (tab colours).

- **TopBar** (36px, chrome background, its buttons 26px tall, a 1px line below; the traffic lights centred in it): `▌wb` memory button, places **Today** and **Local** (keys 1 and 2, no numbers shown). Local is a 24px pixel-art classic Mac (12×12 grid, crisp edges) whose screen fills from the bottom a row at a time with the share of services running: amber while some are down, green when all are up, red when one crashed, dark with none; the count is in its tooltip ("Local · 2 of 7 services running"), and a red ! sits on its corner while the AWS login is expired (see Local), a temporary workstream place when one is open (× closes it), a divider, session tabs `3…n`, `+` new session, then the caffeinate cup (with a count of the sessions holding the Mac) and ⌘K.
  - Top bar buttons have no boxes: a raised background on hover; the current place is raised.
  - **Session tabs** are editor tabs: no boxes, the bar's full height, 12px titles, up to 180px wide, split by hairlines. Each carries its session colour as a 2px bar at its left and its state as a glyph after the title, which says what it means on hover (see Visual style); the tab's tooltip names the state (`Background work` for ◷); a waiting tab's title is bold and white. The current tab takes the session bar's raised colour and joins it, like a browser tab, with a 2px top line in its session colour; its × is 22px.
  - **Right-click a tab:** Close, Close Others, Close to the Left, Close to the Right, Close All (native menu; options with nothing to close are disabled). A bulk close that would stop a running turn asks first. If the tab on screen closes, the view moves to the nearest tab that stays, or Today.
  - Tabs: double-click renames (a manual name sticks over claude's terminal title; clearing it unlocks), drag to reorder, middle-click closes, hover shows the full title, then state and cwd. Tabs of sessions holding the Mac awake (by hand or Auto) show the cup at 13px; Lid closed only while the Mac really is.
  - **Overflow:** tabs never wrap or shrink; the strip scrolls sideways with no scrollbar. Hovering within 56px of an edge scrolls that way (faster nearer the edge; the cursor shows the direction only while there's more), the vertical wheel scrolls it, edges fade while tabs hide beyond them, and a `+N ▾` menu lists tabs out of view. The current tab always scrolls fully into view.
  - **+N** counts tabs out of view and, when any of them waits on you, adds a violet `●k` and a violet left border, so a waiting session never hides in the overflow. Its menu rows carry the session's colour bar, number, full title (cut only past 420px), state glyph and state.
- **StatusBar** (26px, 1px top rule, 11.5px text, fixed-width cells so nothing moves): ⌨ shortcuts, the active session's colour bar, name, state glyph and age; in the middle the Run PR chip (only while a run is going, after one fails, or with ↩ Back) and a `⚠ hooks` chip when hooks, the statusline or the workbench skill aren't installed (click installs); then the meters and the picker.
  - **ctx** (green, full-strength gradient; amber ≥ 60% with a `/compact` button that runs it, red ≥ 75%), **5h** (purple, `↻HH:MM` reset), **wk** (blue). 40×6px bars, values in tabular figures; the gradient's strength ranks them. Every bar has faint cuts at 25 / 50 / 75%; ctx also has faint amber and red marks at 60% and 75%. 5h and wk have a thin light pace mark at how much of the window has passed (from the reset time), so fill past it means the limit is going faster than it resets; the tooltip gives that share. Until a first value arrives the track shows a faint sweep and the value reads `—`. Hover shows the full text.
- **Theme** (Workbench menu › Theme, radio items; or ⌘K): switches the whole app at once (see Visual style). A full-window layer above everything (`.crt-fx`, never hit by the pointer) carries the scanlines of MU/TH/UR and Brown; it's hidden on the others.
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
  | ⇧Z | sleep a Needs you item until it changes |
  | m | mark the selected PR's replies seen (My PRs) |
  | ? | shortcuts popover |

  ⌘ shortcuts (menu): ⌘T new session, ⇧⌘T new session in folder…, ⌘W close tab, ⌘K switch or run, ⌘I task sidebar, ⇧⌘I PR sidebar (only when the session has a PR), both per session, ⌘F focus, ⇧⌘[ / ⇧⌘] previous / next tab, ⌘[ / ⌘] previous / next bookmark, ⌘1–9 places and tabs.

## ⌘K palette

Image: `docs/design/current/palette.png`. Code: `Palette.tsx`.

- Groups: Sessions, Recently closed, Actions (new session, new session in folder…). Typing also searches Workstreams, Tasks, PRs and Themes (`Theme: <name>`, the current one marked) (mine and reviews, bots excluded); every query word must match. Rows show status and project for tasks, repo and author for PRs; no numbers.
- `/command` runs a slash command in the current running session. `/model` and `/effort` are refused there (they rewrite the global defaults); the picker covers them.

## Focus (⌘F)

Image: `docs/design/current/focus.png`. Code: `Focus.tsx`, `notify.ts`, `store.ts`, `keys.ts`, `styles.css`.

- **This screen only.** The screen on view stays as it is (a session keeps its terminal, session bar and sidebar; Today the list and its card). Everything that points elsewhere fades to 20% grey: the TopBar's places, tabs, +N, cup and ⌘K, the status bar except the session cell, and Today's other counters. Resting the pointer on a faded part brings it back.
- A **focus** chip in the TopBar: `focus · this screen only · N held · ⌘F to leave`; clicking it leaves.
- **Held:** while focused, main holds every notification instead of showing it, including finished turns, and counts them in the chip.
- **Leaving** (⌘F, the chip, or Esc when no terminal or text field has focus; Esc in a terminal stays claude's) shows **While you were focused**: what was held, waiting sessions first, then GitHub, then finished turns, newest first within each. A row opens its tab or PR; ⏎ goes to the top one, esc stays. Nothing held: no list.

## Today › Needs you

Image: `docs/design/current/today-needs.png`. Code: `TodayView.tsx` (Home, Peek), `needs.ts`, `NeedPreview.tsx`, `DraftPanel.tsx`, `src/main/drafts.ts`.

- **Counters** under the TopBar on every Today tab: Needs you, My tasks, My PRs, Reviews (the 5h limit lives in the status bar). Each has a big number with its breakdown stacked at the right (e.g. `2 PRs · 1 thread · 1 task`, `7 working · 10 in review`, `3 need a reply · 13 drafts`, `N waiting on authors · 11 bot PRs hidden`). Needs you leads: wider, a 52px number, violet, glowing while anything waits; the others are 28px. The active one (the tab shown) gets a near-white outline. Clicking a counter switches tab.
- **Needs you** lists, newest first: changes requested, reply needed, CI failing, conflicts (on my PRs), and overdue tasks. Each row: kind, the PR's repo (or `task`), text, detail, and `zz`.
  - `zz` / `z` sleeps an item until tomorrow 08:00; it wakes sooner if the item changes (a new message, push or due date). ⇧-click `zz` / ⇧Z (or "until it changes" on the PR card) sleeps it with no end date, until the item changes. Sleeping items sit in a **Sleeping** box with "wake".
  - **Threads** box: up to six reply-needed conversations with the last message quoted; more link to My PRs.
- **Needs reply:** a conversation (an unresolved review thread, or the PR's own conversation of comments plus review bodies) whose last message isn't mine and isn't marked seen. Bots and bare approvals don't count.
- Click or ⏎ shows the item in the right sidebar (a task as the task card, where task links open in place; see Task card); ⏎ again or a double-click opens it (a PR in the GitHub pane at its last message; a task into its session).
- **PR card** (sidebar): kind, repo with CI, title, branch, updated, the PR's task chips and best session (or `+ new ✻`), the latest message; ⏎ open, **draft reply with Claude**, ▶ Run app (frontend), sleep (until tomorrow / until it changes), open in browser.
- **Notifications** (native), in tiers. A session **waiting** on you (a permission prompt or a question; claude's idle reminder after a turn doesn't count): banner with sound (skipped while that tab is on screen and the window focused). GitHub, already only what's for me (a new reply or comment on my PR, changes requested, CI failed not on drafts, a new review request): banner without sound, except a review request. A session **finishing** its turn: no banner; its tab shows it. Each opens its row or tab. The first poll only records what's there; more than four at once become one summary. The Dock badge counts sessions waiting on you. While focus is on, all of them are held (see Focus).

## Today › My tasks

Image: `docs/design/current/today-tasks.png`. Code: `TodayView.tsx` (Home, TaskStrip), `src/shared/tasks.ts`, `src/main/productive/tasks.ts`.

- **Source.** Productive REST with the keychain token (re-read from the login shell when missing), every 2 min plus refresh. The filter is my saved "List view" filter, discovered once from `/filters` and stored with org and person in `productive:account` (fallback: assigned to me, not started or started). The last result is cached so Today has something before the first fetch. The tasks snapshot also carries session links: tasks and PRs linked to each session, and PRs unlinked from one by hand.
- Productive's assignee filter also returns tasks assigned to someone else where an open to-do is mine; a second call (`/todos`, mine, open, `include=task`) counts those to-dos per task.
- **Strip** above the list: a bar of the status mix, one chip per status with its count (click to filter, several allowed, "clear"), and **group by project / status** (remembered). Statuses are ordered nearest-done first; same-named statuses across workflows count as one.
- **Group by project** (default): Bugs first, then Product: CRM, then A–Z; within a project, placement order, nested under parent or milestone. Box titles `My tasks › <project> (n)`.
- **Group by status:** one box per status in strip order, titled in its colour; rows flat in project order.
- **Rows** (quiet, hairline-separated, no tint):
  - tree lines from parent to children (a continuous guide per level, `├` / `└` joints);
  - a status dot in the status colour (a ring for not started, a diamond for a milestone);
  - the title exactly as in Productive; a parent is bold with its child count; a subtask shown without its parent names it in faint text;
  - the status name in its colour (a three-letter code on MU/TH/UR, see Visual style), due date (red when late), and the best session's mark plus count, or `+ ✻` on hover/selection to start one;
  - a context header (hollow diamond) for a parent that isn't mine ("not assigned to you") or is filtered out; click opens its workstream.
- **To-do-only rows** (assigned to someone else, in my list for my open to-dos): a `☐ N to-do(s)` chip and the assignee's avatar at the row end; my own rows have no avatar.
- `/` opens a title filter; j / k select; ⏎ or double-click continues the task (below); `s` starts a new session on it; `r` runs its frontend PR.

## Task card (Today sidebar and session task sidebar)

Image: `docs/design/current/today-task-card.png`. Code: `TaskPreview.tsx`, `TaskDetails.tsx`, `TaskTrail.tsx`, `Chips.tsx`.

- **Card** (box titled `<project> › <task list>`): the parent (opens its workstream), the title (links to Productive, underlined in the status colour) with the **status button** (Productive's pastel tag; ▾ menu of the workflow's statuses, keyboard-navigable; a pick applies at once, no confirm), due and last activity.
- **PR** row: PR chips (▶ Run app on frontend ones); GitHub links in the Productive description, to-dos and comments read `frontend PR` (the URL in the tooltip) and open in the GitHub pane like any productiveio PR link (⌘-click or right-click for the browser; other links open the browser); **sessions (N)** with **link ✻** to link an open session by hand.
- Linked sessions: mark, time, first prompt; a yellow unlink icon (always shown) unlinks. **left off**: Summarize / refresh runs `claude -p --model haiku` over the latest linked transcript's tail; cached per session.
- **Task links** (Productive task URLs in the description, to-dos and comments) read as the task's title once known (my list or a task already shown), else `Productive task`. Resting on one for 300ms shows a hover card: title, `<project> › <task list>`, status tag, assignee, to-dos done/total, with **open here** and **↗ Productive**. A click opens that task in the same sidebar in place of the current one (its full card and Productive box, even when it isn't in my list), with **← <previous task>** above it, scrolled to the top; links chain, back steps one at a time, and showing another task from the list starts over. ⌘-click or right-click for the browser. ⌘[ is not bound here (it steps session bookmarks).
- On the box's bottom edge: **+ new ✻** (always a new session) and **⏎ continue** (switch to the live session, open the latest tab, or resume it; hidden with no session).
- **Productive box** below it: description (URLs clickable); **to-dos** with done count, `+` add form (text, assignee from my colleagues or unassigned), hide/show done; each to-do has a checkbox and an assignee avatar with a searchable people picker. On someone else's task, my open to-dos are highlighted. **comments** newest first under a composer that's one quiet line until focused, then three lines with `@` tagging (tags notify), post, and **draft with Claude**.
- Writes: comments, adding a to-do and ticking a to-do ask first with a native confirm showing the exact text and target. Only the checkbox ticks a to-do; clicking its text or a link in it does not. Status picks and to-do assignee picks apply directly (the pick is the approval).
- A load error in the Productive box (and Couldn't load tasks on My tasks) has **retry**. A missing `PRODUCTIVE_AUTH_TOKEN` re-reads the login shell before failing, so a keychain that was locked when Workbench started fixes itself on the next fetch; a failed shell read isn't cached.

## Today › My PRs

Image: `docs/design/current/today-prs.png`. Code: `GitView.tsx` (GitView, PrRow), `src/shared/git.ts`, `src/main/github/poller.ts`.

- **Source.** `gh api graphql` every 2 min: my open PRs (review decision, CI rollup, mergeable state, draft, head branch, requested reviewers and each reviewer's latest review with their avatar, the author's avatar; the review list gets the same fields, never listing me as a reviewer), review requests made to me directly (team requests don't count), threads and comments.
- Left list, right the GitHub pane (resizable split, remembered).
- Repo chips, **Newest first** (remembered) and **Hide drafts**. Grouped by stage, nearest to merge first: Ready to merge, In review, Changes requested (not yet addressed), Draft. A PR opened from a link that isn't in my lists gets a temporary **Opened** group.
- **Row:** a rail in the stage colour; repo and title (the number in the repo's tooltip); the task chip; `↩ N` when replies wait on me (opens the first in Needs you); age. Under the title the **reviewers**: avatar ringed by state (grey waiting, green approved, red changes, blue commented), login, state; a requested reviewer is waiting even if they reviewed before; a PR that needs a review with nobody asked shows `! no reviewer` in amber (not on drafts). On the right the checks one under another, each ✓ / ✕ / · (CI or CI running, merge or conflict, threads or `N threads`; no CI counts as passing; the full text in the tooltip), then the `n/4` score (how many of the four merge checks pass: CI, reviews, conflicts, threads) with ▶ Run app under it on frontend PRs, without the worktree hint. 4/4 rows get a faint green tint. Within a stage: highest score, then most recently updated; with Newest first, most recently opened.
- ⏎ / click opens in the pane, ⌘-click the browser, `m` marks replies seen.
- Any of these PRs can also be linked to a session or a task by hand (see Session PR sidebar and GitHub pane); a pasted PR URL is cleaned to `github.com/<owner>/<repo>/pull/<n>` first.

## Today › Reviews

Image: `docs/design/current/today-reviews.png`. Code: `GitView.tsx` (ReviewsView, ReviewRow).

- **Reviews** box: PRs waiting on my review (requested, or re-requested after I asked for changes), in **New this week** and **Waiting longer** (oldest first). Repo chips and **Hide bots** (on by default) apply to both boxes. The counter counts only this box.
- **You asked for changes** box: PRs where my latest review asked for changes and I haven't been re-requested; latest first.
- **Row:** laid out like a My PRs row, with a left rail in the group's colour. Repo, title, "your task" chip when it names one of my tasks, and age since opened (amber after 3 days, red after 14). Under the title: the author's avatar and login ("author", or "bot"), then the other reviewers with their state ring (never me). Right: CI and merge one under the other (review requests don't load threads), and ▶ Run app for frontend. Source: `author.avatarUrl` and `latestReviews` are in the shared PR fields, so reviews get reviewers too.

## GitHub pane

Image: `docs/design/current/github-pane.png`. Code: `GitPane.tsx`, `PrLinks.tsx`, `LinkPicker.tsx`, `src/main/github/pane.ts`, `src/shared/pane.ts`.

- An Electron `WebContentsView` (not an iframe) drawn over the right panel of My PRs / Reviews, or full width (⤢), or in a session's PR sidebar. One native view is shared; a still image stands in while an overlay or menu covers it.
- **Strip:** repo and title (the title gives way when tight), state, a CI dot (wording in its tooltip), `↩ N` replies needed, the **Task ▾** and **Session ▾** buttons (capped at 200px), ▶ Run app (frontend), ‹ › history, ↗ browser (⌘↩), ⤢, ×.
  - **Task ▾**: the first task's rail, Productive logo and title (`+N`); the menu lists the PR's tasks with status. Click shows it in My tasks; ↗ opens Productive. Its last item, **+ link to a task…**, turns the menu into a picker of my tasks (status rail and status; the PR's tasks dimmed); ↵ stores the link in `pr_tasks`, so the PR shows on that task and its sessions. A PR that names none of my tasks gets a **link task…** button before `+ new ✻` that opens the same picker.
  - **Session ▾**: the best session's mark and title (`+N`); the menu lists sessions linked to those tasks plus any session working on this frontend PR, live first. Click switches (reopening a closed tab); "+ new ✻ for this task". With a task but no session, the button is `+ new ✻` directly.
  - **A PR that names none of my tasks** (a review, say) gets `+ new ✻` in their place (and "+ new ✻ for this PR" in Session ▾ once it has sessions): a new session named after the PR, connected to it by hand, its first prompt prefilled with `lets look at this PR <url>`.
- **Opening.** A click or ⏎ on a PR row. Any productiveio PR link elsewhere (terminal, cards, workstream) switches to My PRs or Reviews with it selected. ⌘-click always opens the browser. All of `github.com/productiveio/*` stays in the pane; other sites and new windows go to the browser.
- **Live views:** the 2 most recent PRs stay loaded (instant switch, scroll and typed text kept), least recent evicted first. Before evicting a page with text I typed and haven't sent, it asks; GitHub's prefilled boxes don't count.
- **Login:** its own persistent partition (`persist:github`): GitHub login with Google (choose "Try another way" at the passkey step), then the authenticator code. Google sign-in pages are allowed only within that flow. Settings → Sign Out of GitHub clears it. No Node integration, context isolation on.
- **Replies:** opening a PR never clears "reply needed"; my reply being last, or `m`, does. The PR is re-fetched when the page navigates and after a comment is submitted.
- **Draft reply with Claude:** `claude -p --model sonnet` writes the reply (read-only tools in my checkout of the PR's branch, else no tools); Workbench opens the thread, clicks Reply and fills GitHub's box. I post with GitHub's Comment button. If the box can't be found, the draft goes to the clipboard and the pane scrolls to the thread.
- **Keys** while it has focus: plain keys and Esc go to GitHub; ⌘J back to the list (leaves full width), ⌘[ / ⌘] back / forward, ⌘R reload, ⌘L copy URL, ⌘↩ browser, ⌘= / ⌘- / ⌘0 zoom (on top of the app zoom, default 115%, 70–200%, remembered), ⌘K and ⌘1–9 as everywhere.
- **Right-click** gives a browser's menu without Inspect: Open Link in Browser / Copy Link Address on a link, Undo … Select All in a text box, Copy on a selection, Copy Image on an image, then Back, Forward, Reload, Copy Page URL, Open Page in Browser. A mouse's side buttons go back and forward.

## Links: tasks, PRs, sessions

Image: chips appear in `today-tasks.png`, `today-prs.png`, `github-pane.png`, `session.png`. Code: `src/shared/links.ts`, `Chips.tsx`, `linker.ts`, `src/main/index.ts` (the link right-click menu).

- Worked out once in `links.ts` for every view (task row, card, session bar, GitHub pane, PR lists, Needs you) and for `wb status`, so they always agree. A session's PRs (`sessionPrs`) live there too, shared by the renderer and the main process.
- **Task chip:** status rail, Productive logo, title. Click shows it in My tasks; ⌘-click opens Productive.
- **PR chip:** GitHub logo, title, CI dot. Click opens the pane; ⌘-click the browser.
- **Right-click** on any link in the app's own pages (Productive text, cards) offers Open Link in Browser and Copy Link Address, whatever a plain click does. Chips and other button links don't have it (⌘-click them instead).
- **Session mark:** ● running / ● waiting / ● failed in the tab colours, ○ idle (tab open, claude exited), ↺ closed (resume). "Best" session = live first, then most recent.
- Chips cut short grow into the full title after 120ms hover or on focus (10% larger, state in words, accent glow, drawn above everything, growing leftwards near the right edge); no animation with reduced motion.
- **+ new ✻** (the spark means "session") always starts a new session on the task: tab named after it without its repo prefix (`FE: Service markup…` → `Service markup…`; FE/BE/AI agent/API/E2E…), linked "started from this task", in the task's worktree if one exists, and its first prompt prefilled (`lets look at this task <url> `) once claude's input box is up. A task session that never got a prompt gets the prompt again whenever it starts fresh.
- **Session ↔ task links:**
  - explicit: started from the task, linked by hand, or a link suggestion accepted;
  - inferred (strong signals only): a Productive task URL in the first 3 prompts; a task id in the cwd/worktree or branch name (only ids of my tasks); a PR the session touches (its branch, or its URL in a prompt) whose branch or body names the task.
  - Every link keeps its `via`, shown on hover. A link removed by hand is never re-added by inference.
- **A PR's tasks:** task ids in its branch, Productive task URLs in its body, plus tasks connected by hand (`pr_tasks`).

## Session view

Image: `docs/design/current/session.png`. Code: `Terminal.tsx`, `TermView.tsx`, `TaskSide.tsx` (SessionBar), `ExternalPanel.tsx`, `PrCard.tsx`, `src/main/sessions.ts`, `pty-host.ts`, `src/main/background.ts`, `src/shared/background.ts`.

- **Spawning.** `claude` (or `claude --resume <id>`) in a pty, with `--model` / `--effort` / `--permission-mode` from the session's settings. Default cwd `~/Productive/work` (setting `defaultCwd`); a task session starts in the task's worktree when there is one. Fork (from a workstream) starts `--resume <id> --fork-session` in a new tab. A new or reopened tab gets its session colour then (Visual style) and keeps it. The session's env carries `WORKBENCH_SESSION_ID` and puts Workbench's bin folder (with `wb`) first on PATH.
- **Terminal:** xterm.js with WebGL, 10,000 lines of scrollback, in the theme's colours and face (a theme switch restyles open terminals and refits them); main keeps replay history so a reopened view redraws (a pty's owner may rewrite output before it's kept, as Local strips its service shell's markers). Shift+⏎ sends a newline to claude; ⌘C copies a selection. Files dropped on a terminal are typed as their paths, shell-escaped and space-separated, as a paste (claude turns an image path into `[Image #n]`); a drop anywhere else in the window is ignored. URLs are links: productiveio PR links open the GitHub pane (⌘-click the browser) and show a hover card with repo, title, state, review decision, checks and ▶ Run app (open frontend PRs); other URLs open the browser.
- **Session bar** (38px, raised, under the TopBar, only for Workbench sessions):
  - **Task button:** a 6px status rail (the status shows only as its colour; the name is in the tooltip), Productive logo, title, `⌘I` → task sidebar. No task: "link task…".
  - **PRs:** the GitHub logo once, then a segment per PR: repo and CI in words (`fe ● failing`, `api ● passing`), worst first (failing, running, no CI, passing); title, number and CI in the tooltip. A segment opens the PR sidebar on that PR, lit while it's the one shown; clicking it again closes the sidebar. Over 3 PRs, the rest go behind `+N` (opens the first of them; titles in its tooltip). Then `⌘⇧I`, which toggles the sidebar. With no PR, **link PR…**. The session's PRs, in order: connected by hand, the frontend PR its branch is on, PRs of its tasks.
  - `+ new ✻` for the same task; at the right a small cup: this session's caffeinate hold (grey when none, coffee for Awake, the laptop badge for Lid closed). It opens a small popover for this session only: Off / Awake / Lid closed (`o` / `a` / `l`) and until; "Held by Auto while it works" when Auto holds it. Esc closes. The buttons have no boxes, a hairline between them; the open sidebar's button sits on the terminal's colour.
- **Background work.** When a turn ends (Stop), the session's transcript is read (incrementally) for tasks claude started in the background (Bash `run_in_background`, async Agent) since its process started, minus those whose `<task-notification>` came back or that TaskStop stopped. Any left: `◷` on the tab, "background work" in its tooltip and the +N row. The next hook event (it woke up, or exited) clears it.
- **External sessions** (started in another terminal, reported through the same hooks) are read-only tabs showing state and cwd, with **Take over**: waits for the terminal copy to exit, then resumes it here.

## Session bookmarks

Image: `docs/design/current/session.png` (rail), `docs/design/current/session-legend.png`. Code: `Marks.tsx`, `src/shared/marks.ts`, `src/main/marks.ts`.

- A 16px rail at the terminal's right edge with one mark per **prompt** (violet circle), **Subagent result** (teal diamond) and **question for you** (violet triangle: it's waiting on you), each glowing, placed at its position in the scrollback.
- Marks come from the transcript (read incrementally by offset; refetched every 2s while output flows) and are matched to the terminal buffer (`❯` prompts, `⏺` results, `⎿ ·` questions), newest first.
- Hover or focus shows the text, kind and time. Click jumps there with a short soft scroll and briefly outlines the line, then hands focus back to the terminal. ⌘[ / ⌘] step to the previous / next mark; arrows, Home and End move within the rail.
- `+N` at the top counts marks older than the scrollback (tooltip lists them). `?` at the foot opens the legend (Esc or click outside closes). Below 28rem width the rail hides; ⌘[ / ⌘] still work.

## Session task sidebar (⌘I)

Image: `docs/design/current/session-task-side.png`. Code: `TaskSide.tsx` (TaskSide).

- At the right of the terminal, 34% of the window by default (420–560px): the task card and Productive box (as in Today, task links opening in place with ← back). Several linked tasks: chips at the top pick one. No task: a filter and a list (titles only) of my tasks to link. The card's header tools match the PR sidebar: a yellow unlink takes the task off this session, then a soft red ×; the Today card keeps a plain ×.
- Readability: the title at 14px without the status underline (it shows on hover); the parent on one line; labels (PR, sessions, left off, description, to-dos, comments) in a quieter tone than their content, with space between sections. URLs in descriptions, to-dos and comments read short: a GitHub PR or issue as `repo#n`, others without `https://`; the full URL is the tooltip.

## Session PR sidebar (⌘⇧I)

Image: `docs/design/current/session-pr-side.png`. Code: `TaskSide.tsx` (PrSide), `GitPane.tsx`.

- 45% wide by default: the GitHub pane on the session's PR (the one picked in the session bar, else the first), with chips to pick between several, and a **+ link PR** chip at the end of the row. It opens a picker: filter my PRs and review requests (PRs already on the session are dimmed, marked linked), or paste any GitHub PR URL (`/files` and queries are stripped); ↑↓ ↵ esc. The pick is stored in `session_prs`. A session with no PR shows **link PR…** in the session bar, which opens the same picker. In the header's tools, the yellow unlink icon (after ‹ ›; the same icon as the task sidebar's) takes the shown PR off this session for good, however it got there (by hand, Run app, a linked task): it's kept as a dismissal (`suggest_dismissed`, key `pr:<url>`), so it isn't suggested again either; connecting it by hand later clears that. With no PR left the sidebar closes. Framed like the task sidebar: a box with the PR's repo, title, state and CI set into its top border and the tools (‹ › history, unlink, browser ⤢ ×, ▶ Run app for frontend) at its right; no Task ▾ / Session ▾ links, since the session bar already shows both. × closes the sidebar.
- **Per session:** each session remembers its own sidebar (task, PR or none; `ui:sessionSides`), closed until opened. The PR sidebar shows only while the session has a PR; ⌘⇧I does nothing without one.
- **Width (both sidebars):** drag the left edge to resize (←/→ when it has focus); double-click resets to the default. Each sidebar remembers its width (`ui:sideWidths`), never narrower than 320px or leaving the terminal less than 360px. The GitHub pane waits behind a still while dragging.

## Link suggestions

Image: `docs/design/current/session-suggest.png`. Code: `LinkSuggest.tsx`, `src/main/suggest.ts`.

- Rule-based, no model. A card under the session bar, one at a time (`+N more` waits behind it); × means "not this" and is remembered for the session (`suggest_dismissed`). Needs hooks.
- **Task id in a prompt:** a bare 7–9 digit number (not in a URL or path; at most 3 per prompt) that is a Productive task (my list first, else one cached lookup) and not already linked. Card: "Link task?", status dot, title, area, status; **Link** stores a manual link.
- **PR opened by the session:** a PR URL printed in its output that it opened: printed in a turn that ran `gh pr create`, or my own PR under 15 minutes old. A URL pasted in the prompt doesn't count. Card "New PR":
  - session has a task → **Connect** (PR to session and task) or **+ add PR to-do in Productive** (also a `PR: <url>` to-do, after a confirm);
  - no task but the PR's branch or body names one → **Connect both** or **PR only**;
  - no task → **Connect to session** or **+ pick a task…** (also opens the task sidebar).
- Connected PRs are stored (`session_prs`, `pr_tasks`) and show everywhere a task's or session's PRs do. Cards name a PR by repo and title.

## Picker

Image: `docs/design/current/picker.png`. Code: `Picker.tsx`, `src/shared/agent.ts`.

- At the StatusBar's right edge: agent (Claude Code; Codex disabled), model (Opus 5.5 1M, Opus 5.5 200K, Sonnet 5.5, Haiku 5.5, Fable 5.1), effort, permissions (ask, auto, accept edits, plan, bypass). It shows what's in effect: live statusline/hook data, then the session's flags, then defaults; "no flag" shows what claude resolves it to.
- With no session it sets the defaults for new sessions (default permission mode: bypass). On a running session it saves the flags and restarts it in place with `--resume`; mid-turn, after the turn's Stop.

## Caffeinate

Image: `docs/design/current/caffeinate.png`. Code: `CaffeinateControl.tsx`, `Cup.tsx`, `src/main/caffeinate.ts`, `amphetamine.ts`, `src/shared/caffeinate.ts`.

- **Holds.** Sessions keep the Mac awake by holding it: a session, a level (Awake / Lid closed) and when it lets go: **until done** (its turn ends; set on an idle session it waits for a turn to start and end), **until tab closes**, or **until I stop**. A closed tab always lets go. The Mac follows the strongest hold and sleeps as usual when none is left. My holds and Auto are saved (setting `caf:holds`); "until done" holds don't survive a restart.
- **Auto** (on by default): every session that's running holds the Mac (Awake), terminal sessions reporting through the hooks included; it lets go when the session stops or waits on me. A session with its own hold isn't doubled.
- **The cup** (44px wide, TopBar) shows what the Mac is doing: empty grey (Off), coffee with steam that plays twice when turned on and then rests, on a coffee-tinted button (Awake), plus a cyan shut-laptop badge (Lid closed); a badge counts the holds. No steam with Reduce Motion.
- **Popover** (click the cup or `c`; Esc closes): the head says what the Mac is doing (and via Amphetamine / clamshell); **Holding the Mac · n** lists each hold: cup, tab number and title (click opens it), state dot, terminal / working / waiting on you / idle, for how long, `auto`; its until (click cycles) and × to let go (auto rows have neither). **This session** (when a session is open): Off / Awake / Lid closed (`o` / `a` / `l`) and until (done / tab closes / I stop). The Auto checkbox at the bottom. A note says when something changed by itself ("Let go: … is done.").
- Tabs of held sessions show a small cup. The session bar's small cup sets just that session's hold (Image: `docs/design/current/session-cup.png`; see Session view).
- **Awake:** `powerSaveBlocker('prevent-app-suspension')` while any hold exists.
- **Lid closed:** on AC power, via Amphetamine's AppleScript (`start new session` indefinite + `enable closed display mode`; `end session` only for a session Workbench started, remembered across crashes; asks before replacing one it didn't start, and Awake if I keep mine). Needs Amphetamine's Power Protect helper; otherwise unavailable with the reason shown. Without Amphetamine, available only in clamshell mode (AC + external display) via `caffeinate -s`. Unplugging pauses it to Awake with a notification; the hold stays Lid closed and resumes on power.

## Memory (`▌wb`)

Image: `docs/design/current/memory.png`. Code: `Memory.tsx`, `src/main/memory.ts`, `src/shared/memory.ts`.

- `▌wb 2.4G`: total of Workbench's processes, every session's process tree, and local services. The `▌` blends light purple → purple → dark purple → dark red → bright red in steps of 1/12 of RAM (OKLab, eased 0.8s); critical memory pressure forces bright red.
- Click opens the popover (Esc / outside closes): total with RAM and pressure, a 30-minute sparkline and change, a bar split Workbench / Sessions / Local services, and three sections: **Workbench** (window, main, GitHub pages as a count with "close idle", GPU, helpers, headless claude runs), **Sessions** (each tab's tree by size, e.g. `claude 312 · node ×2 96`, ↗ for 30 MB+ growth over 10 min, click opens it), **Local services** (each service and its shell panes).
- Sampling: one `ps` plus the pressure sysctl every 30s, every 5s while open.

## Workstream

Image: `docs/design/current/workstream.png`. Code: `WorkstreamView.tsx`, `src/main/workstreams.ts`, `src/shared/workstream.ts`.

- One screen per milestone or parent task, opened from a task's parent, a context header, or ⌘K; it shows as a temporary TopBar place until closed.
- Loaded on open and Refresh, never polled: the Productive tree (root plus 3 levels, including others' and closed subtasks) and history; PRs from a GitHub search in productiveio for the tree's task ids (rollup PRs mentioning many tasks are skipped unless their branch names the task); transcript line counts and durations.
- Header: title, status, **Post update to task** (Productive comment draft with confirm), **Resume last session**. Tabs: **Timeline** (sessions, PR events, task events in time order; opens at the newest end). A sticky **Show** row filters it by repo: All, then each repo with its count, most first, and **other** for items no repo can be told for. A PR event counts for its own repo; a session or task event for the repos of its task's PRs, else the repo its title prefix names (FE: frontend, BE: api, AI: ai-agent, E/E2E: e2e-tests, Dev/Spec: specs), else its nearest parent's; the root's own PRs don't count, since a milestone's span every repo, **Sessions · N** (Open tab / Resume, Fork with context), **PRs · N**, **Notes** (local).
- Side: **Structure** tree with status, PR (repo and a short title; number in the tooltip), worktree and session chips; every row ends with the assignee's avatar (mine ringed violet, unassigned a dashed ring); closed subtasks folded behind "show N closed". **Start work** per open subtask of mine: switch to its running session, or start one in its worktree (the tab named after the subtask without its repo prefix); without one, pick a repo and Workbench creates `feature/<taskId>-<slug>` in `<worktrees>/<repo>-<taskId>-<slug>` from `origin/<default>` after a confirm showing the commands (or "No worktree · default folder"). **Where I left off** with Summarize latest.

## Local

Image: `docs/design/current/local.png`. Code: `LocalView.tsx`, `Panes.tsx`, `WorktreeSwitcher.tsx`, `src/main/local/` (`shell.ts`: the service terminal's zsh hooks; `aws.ts`: the AWS login), `panes.ts`, `ports.ts`, `src/shared/local.ts`.

- **Config** (`services.json` in the data folder, seeded from `prd`): app (`pnpm start`, port 4201, 2 panes), api (`bundle exec sidekiq`), realtime (`npm start`, port 4220; full and Frontend only), e2e-tests (`npm run cli`), exporter, pdf-generator, pdf-viewer (`npm run start`), AI (`DEV_API_ENV=production pnpm start` in `ai-agent`). Profiles: prd · full, Frontend only, AI work, Exports & PDF.
- Header: profile switch, **Stop all**, **Start missing (n)**. A Run PR job shows inline here while it runs.
- Left: services in the profile with status dot, uptime and state; **Infra · brew services** chips (mysql, redis, memcached, meilisearch, nginx), a stopped one starts on click.
- **aws chip** (last in the infra row, when `~/.aws/config` has an `[sso-session]`): green `aws` while the login holds (tooltip: token time, refreshed automatically), red `aws · expired · log in`, grey `aws · ?` when it can't tell (offline, no `aws`). Checked each minute from `~/.aws/sso/cache`; only when the cached token is past its expiry does it ask `aws sts get-caller-identity`, which refreshes it if the session still lives. Click runs `aws sso login --sso-session <name>`: the browser opens, the chip shows the device code (`aws · WXYZ-1234`) until it's done, a second click cancels. While expired, **2 Local** in the TopBar has a red **!**; hovering it says when it expired, the sso-session, and to click the chip.
- A service that crashes with an AWS expired-token error in its output (`Token is expired`, `ExpiredToken…`, `run 'aws sso login'`, …) shows `crashed · AWS login expired` in the list, gets an amber line under its exit line (`[AWS login expired · click the aws chip to log in, then Start]`), and the login is checked at once.
- Right: the branch button (opens the switcher), path and how far behind its base, Open in browser, Start / Restart / Stop, and split, resizable terminal panes (service terminal plus shells; layout saved per service).
- **Service terminal:** a login zsh in the service's folder, open as soon as the pane is. Start types the service command into it. When the command ends, the log stays, a dim line says how (`[api exited · code 1 · Start or ↑ ⏎ runs it again]`), and the prompt is there to fix things; ↑ ⏎ or Start runs it again. Stop sends Ctrl-C, then SIGTERM / SIGKILL to the command's process group after 5 s; the shell stays. The status (running, crashed · exit n in the pane header) follows the command, reported by hooks in the shell, not the shell. A shell typed `exit` reopens on Enter. With a login shell other than zsh, and for Run alongside copies, the command runs without a shell and the pane shows Not running / Crashed with Start.
- Services run inside the app: quitting stops them, after a confirm while any run.
- **Switcher** (from `~/.wtrc.json`): filter, two sections. **Worktrees**: recency order, badges (● dirty, ✓ merged, ⬆ gone, ⚠ unmerged); ⏎ switch and run, ⌘O switch, ⌘. open in editor, ⌘⌫ remove, **Run alongside on new port**. **Branches** of the base checkout (the service's own folder) that no worktree has: local ones, then remote-only ones as `origin/…`, newest first, up to 200 per section. ⏎ points the service at the base checkout and types `git switch <branch> && <command>` into its terminal (⌘O without the command); a remote-only branch becomes a local tracking branch. Uncommitted tracked changes ask first: Stash and continue (`git stash push -m "workbench: before <branch>"`) / Cancel.

## Run PR in app

Image: chip in the StatusBar of `session.png`. Code: `RunPr.tsx`, `src/main/focus-pr.ts`, `src/main/local/run-pr.ts`, `src/shared/runpr.ts`, `src/main/github/fe-pr.ts`.

- **Focus PR** per session from signals: its cwd is a frontend worktree on a PR's branch, or a frontend PR URL / `#n` in its prompts or output (strongest, newest wins); then a PR of its task, or a `gh pr view/checkout/diff <n>` it ran.
- **Chip** (only after a run): "Switching app to <PR title> · step i of n" with a bar while running; "Run failed · details"; "Base checkout on fe #n" with ↩ Back after a base-checkout run. A session whose PR isn't in the app gets no chip; ▶ Run app on its PR does that.
- ▶ Run app also on frontend rows in My PRs / Reviews, the task card's PRs, Needs you's PR card, the GitHub pane strip and the terminal PR card.
- **Worktree found** (by branch, then upstream, then head commit, only under `.wtrc` worktree folders): stop `app`, run the repo's command there.
- **No worktree:** the base checkout (`app`'s folder, `~/Productive/app`; never `~/Productive/work/repos/frontend`). A dirty tree asks: Stash and continue / Run alongside / Cancel. Then fetch, checkout (remembering the previous branch and stash for ↩ Back), `pnpm i` only if the lockfile changed, build lib · ui · form · prosemirror when their sources changed, restart, wait for the app to answer.
- **Run alongside:** a second `app` on the next free port, from the worktree or a detached `frontend-review-<n>` worktree. A port held by a process Workbench didn't start stops the run with that message.
- The run panel (from the chip or inline in Local) shows steps, a log tail and Cancel.

## Open questions

- Lid-closed keep-awake on battery or without an external display: verify what `caffeinate -s` actually allows.
- Quiet hours for notifications: none for now.
