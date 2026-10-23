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

  | State | Colour | Shown when |
  |---|---|---|
  | running | blue `--info` | a prompt was submitted and no Stop has arrived |
  | waiting for you | purple `--accent` | a Notification arrived, e.g. a permission prompt or idle input |
  | failed | red `--bad` | the process exited non-zero |
  | idle | grey `--faint` | the session is stopped |

  Tabs show the state as a bar along their bottom edge (see TopBar under Shell chrome).
- **External sessions.** Sessions started in a normal terminal report through the same hooks. They appear as read-only "external" tabs. "Take over" waits for the terminal copy to exit, then resumes the session inside Workbench.
- **PR links in terminal output.** An xterm link provider recognises `github.com/<org>/<repo>/pull/<n>`. A click opens the PR's row in My git or My reviews (GitHub when it's in neither), and ⌘-click opens GitHub. Hovering shows a card with the PR's state and CI status.
- **Pickers.** The picker lives in the StatusBar (toolbar).
  - New sessions start with `--model`, `--effort` and `--permission-mode` from the picker. The defaults are stored in settings.
  - A change to a running session restarts it in place with `claude --resume <id>` and the new flags. If a turn is in progress, the restart waits for its Stop.
  - Typing `/model` or `/effort` into the session is not used: claude saves those as the global default in `~/.claude/settings.json` (`model`, `modelSettings.*.effortLevel`), which would change every other session. Permission mode is only reported in hook payloads, so it can't be confirmed live either.

### Caffeinate

Keeps the Mac awake while sessions run.

- **Control.** A cup button in the **TopBar**, right of the session tabs and before ⌘K (design: `docs/design/CaffeinateButton.dc.html`).
  - It's a fixed 44px, so it never takes room from the tabs. The cup and the button's glow show the state.
  - Click it, or press `c`, to open a popover with the three states, each with a one-line description and a key (`o` / `a` / `l`), plus an "applies to: this session / all" switch. Esc closes it.
  - The states:

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
- **Icon.** A realistic espresso cup on a saucer: white porcelain, brown coffee with crema, steam rising.
  - **Off:** an empty grey cup with no steam, and the button has no glow.
  - **Awake:** coffee in the cup with animated steam, a warm coffee-coloured border and glow (`#C98D55`).
  - **Lid closed:** the Awake cup plus a cyan shut-laptop badge, with a cyan border and glow (`#6FC3E0`).
  - The steam stops if Reduce Motion is on.
- **Tabs.** Caffeinated session tabs show the icon at 13px after the title.
- **Lid closed availability.** The option is enabled on AC power when the Amphetamine setup check passes; no external display is needed. Without Amphetamine, it is enabled only in Apple's clamshell mode (AC power plus an external display).

### Today › My tasks

- **Source.** The Productive REST API, using the token from the macOS keychain. The filter is the saved "List view" filter, read once from the API's saved filters (`/filters`, creator = me) and stored in settings with the org and person ids.
- **Status strip** (design: the "1b · Task status — D rail + label" board). Above the list:
  - a bar showing the mix of statuses among my tasks;
  - one chip per status with its count, in the status's Productive colour. Clicking chips filters the list (several can be picked; "clear" resets). The bar dims the statuses filtered out.
  - a **group by: project / status** switch, remembered per machine.
  - **Status colours** (design: the "1b · Task status colours" board, option C) map each of Productive's 17 status colours to a bright stand-in tuned for the dark theme, so a status keeps its Productive identity but reads clearly. They're used for rails, status labels, the strip, chips and status glyphs; Productive's own pastel pairs stay for tag-style badges (the task card's status button).
  - Statuses are the real Productive status names, ordered nearest-done first: started before not started, then later in the workflow (the status's `position`) first. Statuses from different workflows that share a name count as one.
- **Shape.** By default tasks are grouped by project, with Bugs pinned first, then Product: CRM, then the rest alphabetically. Inside a project they're ordered by placement and nested under their parent or milestone.
  - **Grouped by status:** one box per status in strip order, titled in the status colour; rows are flat, in their project order.
  - A subtask shown without its parent above it (status grouping, or the parent filtered out) names the parent in faint text after its title instead of drawing a tree mark.
  - A milestone that isn't mine gets a muted header.
  - A parent hidden by a filter shows as "filtered out".
  - Subtasks don't repeat the parent's task list.
- **Row.** Each row shows:
  - a 3px rail on the left and a faint background tint in the status colour (no tint for not-started statuses)
  - the status name at the right, in its colour, in a fixed-width column so it lines up across rows
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
  - **GitHub replies change in phase 8.** The draft goes into GitHub's own reply box in the GitHub pane, and you post it with GitHub's Comment button. Workbench never posts GitHub replies itself. The native-confirm flow stays for Productive comments.
- **Notifications.** A native macOS notification for each of:
  - a new reply or comment on my PR
  - changes requested
  - CI failed on my PR
  - a session waiting for me (permission prompt or finished)
  - a new review request

  Each notification opens the matching row or tab. The first poll on a fresh install only records what's there; more than four new items at once become one summary notification. Session notifications are skipped while that tab is on screen.

### GitHub pane (phase 8)

GitHub opens inside Workbench instead of the system browser. It uses an Electron `WebContentsView`, which is not an iframe, so GitHub's frame blocking doesn't apply. Decisions: `docs/decisions.md` › GitHub pane.

- **Layout.** In My git and My reviews, the right-hand panel becomes the GitHub page, with a resizable divider and the list on the left.
  - Above the page is a thin strip: PR ref, state, CI, a reply badge, ▶ Run app for frontend PRs, ⌘↩ open in browser, and close.
  - A ⤢ button switches to full width and back.
- **Opening.**
  - A click or ⏎ on a PR row opens that PR in the pane; j/k in the list moves to the next PR.
  - A PR link anywhere else (terminal, task preview, Run PR card, workstream) switches to Today › My git with that PR selected and open.
  - A PR that isn't in your lists gets a temporary "opened" group in My git.
  - ⌘-click always opens the system browser.
- **Scope.** Every `github.com/productiveio/*` page stays in the pane: PRs, files, checks, Actions, issues, commits. Other orgs, other sites and new-window links open in the system browser.
- **Views.** The 3 most recently opened PRs stay live, evicting the oldest first (about 150–200 MB each), so switching between them is instant and keeps scroll position and unsent comment text.
  - Before evicting a page with text in a comment box, Workbench asks first.
- **Login.** The pane uses its own persistent session (`partition: 'persist:github'`), separate from the app, so you log in once.
  - Login is GitHub's own login page inside the pane. The account signs in with Google (personal Google account), then GitHub's authenticator-app code. `productiveio` has no SAML SSO (`/orgs/productiveio/sso` returns 404).
  - Passkeys don't work in an embedded Electron view (no macOS passkey prompt), so on Google's passkey step choose "Try another way" (password plus the phone prompt). Verified in the spike, 2026-10-23.
  - Google's sign-in pages are allowed in the pane only as part of that login flow.
  - Settings has "Sign out of GitHub", which clears that partition.
  - The pane runs with no Node integration and context isolation on.
- **Reply state.** Opening a PR never clears "reply needed". It clears when your reply is the last message, or when you press `m`.
  - Workbench re-fetches the pane's PR when the page navigates and after a comment is submitted.
- **Draft reply with Claude.** Claude drafts the reply; Workbench scrolls the pane to the thread, opens its reply box and fills in the text. You edit it and post with GitHub's Comment button, which is the confirm.
  - Filling the box is done by a small script injected into the page, which depends on GitHub's page structure.
  - If the script can't find the reply box, Workbench copies the draft to the clipboard and scrolls to the thread instead.
- **Keyboard.** While the pane has focus, plain keys and Esc go to GitHub. Workbench keeps only ⌘ shortcuts:

  | Shortcut | Action |
  |---|---|
  | `⌘J` | back to the list (also leaves full width) |
  | `⌘[` / `⌘]` | back / forward |
  | `⌘R` | reload |
  | `⌘L` | copy URL |
  | `⌘↩` | open in browser |
  | `⌘K`, `⌘1–9` | as everywhere else |

- **Spike (done 2026-10-23):** login works in the embedded view (Google sign-in without the passkey, then the GitHub authenticator code). The reply-box fill works on a real PR thread: open the thread's URL (`#discussion_r…`), click its "Reply…" button, then set the visible `comment[body]` textarea through the native value setter and fire an `input` event; GitHub enables its Comment button.

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

### Visual style (TUI)

The whole app uses a terminal-style look. Reference: `docs/design/StyleTui.dc.html` (direction "1b" on the design canvas).

- **Type.** Everything is in JetBrains Mono at 12.5px, with tabular numbers.
- **Panels.** Panels are 1px boxes with square corners. Each panel's title sits inside its top border; the active panel's border and title are in the accent colour.
- **Rows.**
  - The selected row is filled with the accent colour, with text in `--on-accent`.
  - Status is a coloured `●` for started statuses or `○` for not-started ones.
  - Subtasks are indented with `└`, a milestone row starts with `◆`, and bug priority is shown as `!` or `!!`.
- **Counters.** A row of five boxed counters sits under the TopBar on Today. Each has a 38px number with its breakdown beside it, not under it: one part per line, stacked against the box's right edge (right-aligned) and aligned to the top of the number, in a faint 11.5px with tight line height so three lines fit the number's height. The active counter (the one whose list is shown; Needs you by default) has a larger number, 44px instead of 38px, with a soft glow in its own colour, and its box gets a near-white outline (`--text-2`) and a brighter title. The number sits on a fixed 48px line, so the box never changes height. Switching counters eases the size, glow and outline together over 0.25s, with the glow growing alongside the size rather than after it (no animation with reduced motion). The `·` in the examples below separates the breakdown lines:

  | Counter | Breakdown |
  |---|---|
  | Needs you | e.g. 2 PRs · 1 thread · 1 task |
  | My tasks | e.g. 7 working · 10 in review |
  | My PRs | e.g. 3 need a reply · 13 drafts |
  | Reviews | e.g. 11 bot PRs hidden |
  | 5h limit | percentage, with the reset time |

- **Keyboard.** ⌘1–⌘9 follow the taskbar numbers too (⌘1 Today, ⌘2 Local, ⌘3… sessions, ⌘9 the last session). The app is keyboard-first (j/k move, ⏎ open, tab next pane, r run app, s new session, / filter, g my git, v my reviews, 1–6 switch tab, c caffeinate). Shortcuts are not printed in the UI. A ⌨ icon at the left of the StatusBar shows them all in a popover on hover or focus.
- **Theme.** Dusk tokens are unchanged; only the shapes and type change.

### Shell chrome

- **TopBar.** A separate 56px bar with the chrome background, a 2px accent line along the bottom and a shadow over the content. All items are boxed segments with no wrapping; long session names are truncated.
  - Left to right: `▌wb`, then the fixed places `1 Today` and `2 Local 6/8`, a divider, the session tabs `3…n`, and on the right the caffeinate cup and ⌘K.
  - **Memory (`▌wb`).** `▌wb` is a button showing the total memory in use, e.g. `▌wb 2.4G` (design: the "1b · Memory" board).
    - **Total:** Workbench's own processes, plus every session's process tree (claude and whatever it started: MCP servers, test runners), plus local services.
    - **Glyph colour:** the `▌` blends light purple → purple → dark purple → dark red → bright red. Each step is 1/12 of the Mac's RAM, with red from a third (1.5 / 3 / 4.5 / 6 GB on an 18 GB Mac). Between steps the colour blends in OKLab and eases over 0.8s, so it never jumps at a threshold. macOS memory pressure "critical" forces bright red.
    - **Popover:** click opens it; Esc or a click outside closes it. It has:
      - the total, with the Mac's RAM and memory pressure;
      - a 30-minute sparkline with the change over that time;
      - a bar split into Workbench / Sessions / Local services;
      - three boxed sections:
        - **Workbench:** app window (with terminals mounted), main process (with terminal history), loaded GitHub pages (with "close idle"), GPU, helpers, and any headless claude run.
        - **Sessions:** each tab's process tree by size, with a breakdown like `claude 312 · node ×2 96`; ↗ marks growth of 30 MB+ over 10 minutes; a click opens the session.
        - **Local services:** each service, plus shell panes.
    - **Sampling:** one `ps` call plus `sysctl kern.memorystatus_vm_pressure_level`, every 30s in the background (enough for the colour and the trend) and every 5s while the popover is open.
  - The current screen is filled with the accent colour.
  - Session tabs have no state dot. Every tab carries its state colour as a bar along its bottom edge: 2px at 45% strength on unfocused tabs, so they stay quiet, and 3px at full strength on the current session. The current session is also a purple-tinted box (accent at 14% over `--raised`) with bright bold text, outlined on top, left and right in the accent at 70% plus a 2px accent line along the top, its bottom edge left to the state bar. An exited session's title stays at full strength while it's current. A waiting session that isn't current only ever shows the muted purple bar, so "needs you" and "current" never look alike. Hovering a tab shows its state as a tooltip.
  - **Overflow.** The session tabs take the free width between the divider and the cup and never wrap or shrink below their width. When they don't fit, the strip scrolls horizontally with no visible scrollbar:
    - Hovering within 56px of either edge scrolls that way, faster the closer the pointer is to the edge. It stops at the end of the strip.
    - In an edge zone the cursor is `w-resize` / `e-resize`, but only while there is more to scroll that way; otherwise it's the normal pointer.
    - Edge hover never blocks clicks. The strip tracks the pointer itself rather than laying a zone over the tabs, so a click in an edge zone still selects the tab under it.
    - A vertical mouse wheel over the strip scrolls it sideways.
    - An edge fades out while there are tabs beyond it.
    - A `+N ▾` chip after the strip counts the tabs fully or partly out of view, and is hidden when none are.
- **Session bar** (design: the "Workbench — Session bar" canvas). A 38px raised bar directly under the TopBar while a Workbench session is on screen; it belongs to that session, so the session's task and PR buttons live here, not in the TopBar.
  - **Task button:** the linked task's status rail (in its status colour), its title and its status name, then `⌘I`. It opens the task sidebar. With no linked task it reads "link task…" and opens the sidebar's link picker.
  - **PR button:** "PR" with the PR's CI state (● passing / failing / running), then `⌘⇧I`. It opens the PR sidebar (the GitHub pane), and is hidden when the session has no PR. More than one PR shows `+N`; the sidebar picks between them.
  - The open sidebar's button is lit (accent outline and tint). The PR's branch sits at the right in faint text.
  - **Task sidebar:**
    - Comments: the comment box sits above the comments, which run newest first. While not in use it's a single quiet line; focusing it or typing grows it to three lines with its post / "draft with Claude" bar.
    - To-dos: a `+` beside the to-dos heading opens an inline form with the text, an assignee (my Productive colleagues, or unassigned) and "⏎ add". Adding asks first, like every Productive write. Each to-do shows its assignee after its text.
- **⌘K.** Searches sessions, workstreams, PRs and Productive tasks, and runs a slash command in the current session (`/model` and `/effort` are refused there because they rewrite the global defaults; the picker covers them).
- **StatusBar.** Always visible, 38px, with a chrome background and a 2px top border. Every cell has a fixed width, so a value or state change never moves anything.
  - **Left:** the ⌨ shortcuts button, then the active session's name and duration.
  - **Right**, grouped next to the picker:
    - **ctx**: a 48px bar plus the percentage. `/compact` is suggested at 60% or more, and the bar turns red at 75% or more.
    - **5h**: a 48px bar, the percentage and `↻16:00`
    - **wk**: a 48px bar and the percentage
    - the model · effort · permissions picker at the right edge
  - **Bar tracks** use the lighter `--line-heavy` token, so an empty bar is still visible.
  - **Bar colours follow importance.** Each meter keeps its own hue (ctx green `--ok`, 5h purple `--accent`, wk blue `--info`), drawn as a gradient that brightens toward the fill's leading edge. How strong the gradient gets sets the rank: ctx goes from 35% to full strength, 5h from 30% to 80%, wk from 25% to 60%. ctx still switches hue with its value (amber `--warn` at 60%, red `--bad` at 75%) on the same full-strength gradient.
  - **Loading.** Until a meter's first value arrives, its track shows a faint highlight sweeping left to right (about 1.8s, low opacity) and the percentage reads `—`. With reduced motion the sweep is off. When the value arrives or changes, the fill eases to its new width over 0.6s.

  Hovering a meter shows its full text.
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
7. **TUI restyle.** Apply the visual style above across all screens: TopBar and StatusBar layout, the Today counters, the caffeinate cup button and popover, and the shortcuts popover.
8. **GitHub pane.** In-app GitHub as described above: split pane with a strip, opening from rows and links, `productiveio` scope, a pool of 2 live views (each loaded page costs about 85 MB), a persistent login partition, reply-state rules, Claude drafts filled into GitHub's reply box, ⌘-only keys. Starts with the login and reply-box spike.

## Packaging

`electron-builder` builds `/Applications/Workbench.app` locally, and I rebuild after pulling. The build is unsigned, so the first launch needs right-click → Open. No auto-update.

## Open questions

- **Quiet hours** for notifications: none for now; revisit after using it.
