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
- **Outbound writes** — drafts are written in-app and sent only after an explicit confirm step that shows the exact text and target. This covers GitHub replies and Productive comments and to-dos *(the never-post-without-approval rule)*. Status changes picked in the task's status menu and to-do assignees picked in the person menu apply without a confirm — the pick is the approval
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
  - one persistent login partition (Google sign-in without passkeys, then the authenticator code; no SAML SSO in the org)
  - "reply needed" clears only when you reply or press `m`
  - Claude drafts go into GitHub's reply box and you post with GitHub's own button
  - only ⌘ shortcuts are kept while the pane has focus

## Open / Deferred
- **Lid-closed keep-awake on battery or without an external display** — verify what `caffeinate -s` actually allows
- **Quiet hours** — none for now

## Added 2026-10-24
- **Current state lives in `docs/SPEC.md` and `docs/design/current/*.png`** — the screenshots come from the real app (`pnpm snap`, scratch profile, live data), so they can't drift; mocks in `docs/design/explore/` and the canvas are history *(sessions kept building from stale pre-TUI mocks)*
- **Live GitHub views: 2, not 3** *(each loaded page is ~85 MB)*
- **GitHub login** — at Google's passkey step pick "Try another way" *(passkeys don't work in an embedded Electron view; spike 2026-10-23)*
- **Pane fill** — drafts are put into GitHub's reply box by an injected script that depends on GitHub's DOM; when it can't find the box, the draft goes to the clipboard
- **Run PR worktree match** — branch, then upstream, then head commit *(branches get renamed: fe #30227 is on `21071355-…`, its worktree on `20360127-…`)*
- **Run api** — the api is what puma-dev's `~/.puma-dev/api.productive.io` link points at, so a run repoints the link (one rename) and moves sidekiq with it; ↩ Back restores the state before the first api run. Worktrees lack gitignored config (without `config/application.yml` Rails falls back to AWS SSM and fails with a misleading expired-SSO error), so they're symlinked from the base checkout, not copied. `db:migrate` always runs (picked over asking): the dev database is shared, so a PR's migrations stay after ↩ Back. No Run alongside: one puma-dev host, one database
- **Run PR on the base checkout rebuilds lib, ui, form and prosemirror** *(a fresh checkout doesn't compile without them)*
- **A port held by a process Workbench didn't start stops the run** rather than starting a second server
- **Lid closed** — `sudo pmset disablesleep 1` rejected *(needs root, unreliable on Apple Silicon, disables sleep everywhere including on battery)*
- **Link suggestions are rules only, no tokens** — a bare 7–9 digit id in a prompt; a PR counts as the session's when printed in a turn that ran `gh pr create`, or when it's mine and under 15 minutes old; a URL pasted into the prompt never counts
- **My tasks rows** — version A: quiet rows, glowing status dots, tree lines; tasks there only for a to-do of mine show the assignee's avatar and a to-do chip, my own rows show nothing extra
- **Workstream tree** — option B: an avatar on every row, mine ringed violet

## Added 2026-10-25

- **Caffeinate is per-session holds, not one global setting** — one {mode, scope, session} silently moved off a session when another picked Awake, and nothing listed who kept the Mac up. Holds (level + until done / tab closes / I stop) list in the cup's popover (option A of `CaffeinateHolds`); a small cup in the session bar instead of a full per-session control (option B). Auto (running sessions hold the Mac) replaces "applies to: all" and is on by default. A session asking for itself (`wb awake`, option C) is deferred.
- **Session bar trimmed** — the task's status is only its (wider, 6px) rail colour; the PR button drops its title and the branch is gone; the sidebars show both.

## Added 2026-10-26

- **Service terminals are shells.** A crashed service used to cover its log with "Crashed · Start"; fixing it (bundle install, a migration) meant another pane. Now the command runs inside a login zsh, so the prompt is right under the error. Status still has to follow the command, not the shell, for Start missing, the Local counter and Run PR: a ZDOTDIR of our own sources the user's zsh files and adds preexec / precmd hooks that print OSC markers with the command line and its exit code; main strips them from the output. Only zsh gets this (it's the login shell here); others keep the old direct run.
- **Branches in the switcher** come from the base checkout only, and the checkout is typed into the service terminal rather than run behind the scenes, so a conflict or hook failure is visible and fixable in place.
- **AWS login is read from the SSO cache, not by calling AWS.** The cached access token lasts an hour and the SDK refreshes it while the session lives, so a past `expiresAt` alone would cry wolf every hour: only then does `aws sts get-caller-identity` decide. No amber "expiring soon" state for the same reason. It's flagged on the Local tab and the chip only, not in Needs you (rejected: noise in the day's list).
- **Themes are a skin over one layout.** The cassette-futurism set (MU/TH/UR, Brown workstation, Ops console, Night drive; Hi-Fi deck dropped) changes tokens, faces and decoration in CSS under `data-theme`; markup changes only where CSS can't do it: status codes on MU/TH/UR, seven-segment counters on Ops console, per-digit cells over unlit 8s on Night drive (Orbitron's digits differ in width). Night drive left out its board's message-centre strip and session odometer: new behaviour, not a skin. Dusk stays the default. MU/TH/UR keeps some status colour *(pure amber lost readability)*, and Brown's chrome is dark *(beige drew the eye away from the content)*.
- **Dropped files are read in the preload.** Electron 32 removed `File.path`, so the renderer can't see where a dropped file lives; `webUtils.getPathForFile` (preload only) gives it. Paths go in through xterm's `paste` so claude gets bracketed paste and attaches images.
- **Tab colour is the session, not its state.** With ten or more tabs, titles that start alike ("Redesign contact form…") and claude's default "Claude Code" made tabs indistinguishable, while the colour only said state. Each session now has a colour of its own (canvas: Session tabs boards; the colour bar option, at 2px), and state became a glyph (? ··· !). Lost on purpose: the violet tab wash that caught the eye from the side, violet on the tab and status-bar dot, the red failed bar; violet still marks waiting on the +N count, Needs you and Focus. Task status already spans the whole hue wheel, so session colours are kept apart by being muted, darker and a different shape (a bar on a tab, not a rail or dot), from each theme's own world; MU/TH/UR uses sigils so the phosphor stays one colour. Colour per task was rejected: it would bring back the problem inside a task.
- **? means it asks you something, nothing else.** claude fires Notification a minute after every finished turn ("waiting for your input"); counting it made every done tab a ? with sound. Only permission prompts and questions wait now. A turn that ended with background tasks out shows ◷ instead: it's busy on its own and wakes by itself. Found by reading the transcript at Stop, not by a new hook or state; kept to Bash and async Agent tasks (canvas: Session tab state board).
- **The session bar lists every PR, worst CI first.** One button with the first PR's CI and `+N` hid a failing second PR. Each PR gets a segment with its repo and CI in words (the number is in the tooltip); past 3 the rest go behind `+N`, but sorting puts any failure in view. A dot-per-PR summary was rejected: it says something fails, not which.
- **A task link opens in the sidebar it's in, with ← back.** Productive task links in to-dos and comments went to the browser. Showing the linked task in place (canvas: Task links board, A with C's hover card) keeps one place for a task, chains, and needs no overlay over the GitHub pane. A modal was rejected: a second, different task view. The hover card alone isn't a container; it previews and hands off to the click.

## realtime is a service, meilisearch stays a brew chip

Measured idle: realtime (nodemon + node) ~0% CPU and ~40–60 MB, meilisearch ~0% and under 30 MB, so both can run all the time. realtime goes in the profiles that run the app (full, Frontend only) so its socket is there when the app is. meilisearch stays a brew service: it isn't tied to a checkout, and with no master key (launchd doesn't read `~/.zprofile`) it accepts the API's key anyway.

## Running tab: a faint dot ring that moves

A tab title cut with `…` next to the `···` running glyph read as two ellipses. The title now fades instead of being cut, and running is a braille cell's six dots, all always shown, with a soft highlight going round (canvas: TabRunGlyph, E3 picked over a full-contrast spinner and calmer stand-ins). It's the one loop in the app, kept as low-contrast as it can be while still showing the session is alive. Drawn in CSS rather than by swapping braille characters each frame, which stepped and jittered.

## Worktree cleanup goes by the PR, not by git

`wt`'s cleanup calls a worktree merged when git says its branch is merged or its upstream is gone. Squash merges never look merged to git and most remote branches outlive their PR, so only 21 of 127 worktrees with merged PRs showed up. Local › Worktrees asks GitHub (and Productive for tasks without a PR) instead, and checks the PR's head has HEAD before deleting a branch. It's a view in Local next to Services (canvas: Local › Worktrees board), not a mode of the switcher, which is for picking a worktree. Only Done is swept in bulk; branches are deleted only for merged PRs, so everything else can come back with `git worktree add`. Sizes and the low-disk line came from a parallel proposal: 94% full with ~150 GB in done worktrees made the case. `du` is slow on node_modules, so sizes come after the verdicts rather than holding them up.

## Figma link: a grey mark that inherits

A task's design lives in Productive's Figma custom field, and subtasks usually don't repeat it, so a subtask without one shows the nearest ancestor's. The mark sits after the title in grey and only takes Figma's colours on hover or selection (canvas: Figma link board, B): the brand colours on every linked row (A) would be the only coloured logo in a quiet list, and a separate column (C) put it away from the title and was empty on most rows. Inherited marks are fainter so a glance says whose link it is.


## AWS login: checked as the SDK sees it, not with sts

`aws sts get-caller-identity` kept the chip green for hours after the SSO session ended: the CLI answers from its own role credentials in `~/.aws/cli/cache` (12 h) and never touches the SSO token. The api's Ruby SDK doesn't share that cache, so it failed with `InvalidSSOToken: Token is invalid and failed to refresh` while Workbench said all was well. The check now reads the sso-session's cached token and, near its end, refreshes it through SSO-OIDC exactly like the SDK (same file, same rotation; refresh tokens are reusable, so racing the api's own refresh is harmless). Sidekiq doesn't crash on it either, its jobs just fail, so a running service's output is watched for the error too, not only a crash's.

## Session readability: typography and focus, not a background

Asked for a background "for better readability", two rounds of decoration (aurora, horizon grid, wallpaper behind frosted glass, gradient skies) were mocked and dropped: anything behind text varies the contrast under the letters and gives attention something to drift to, which is the opposite of what's needed, especially with ADHD. What helps is typography (line height 1.25 → 1.45, a lifted sheet so text on near-black glares less) and focus: the current turn in front, older turns dimmed, a mark for where you left off and the prompt pinned once it scrolls away, because the expensive moment is coming back to a tab after a switch. A 100-column reading column was tried and rejected as too narrow; the sheet keeps the full width with a slight inset. Dimming is an overlay drawn from the bookmark rail's prompt positions, not xterm decorations, so it follows scrolling without per-line bookkeeping (canvas: Session view — readability and focus, D).

## Added 2026-10-28

- **My own to-dos live in Needs you, not in Productive.** Personal to-dos (car registration, the dentist) have no Productive task to hang on, and a separate list would be one more place to look; they're Needs you rows like any other (canvas: Needs you to-dos, option C), with the same sleep. Rejected: B, an own To-dos box that only lets due ones into Needs you (the counter stays "act now", but undated ones get forgotten). A to-do dated later sleeps until its day rather than counting, so a backlog doesn't swell the number. Captured from a session, it keeps the link so ⏎ goes back there; capture is ⌥⌘T (a menu accelerator, so it works inside a terminal) because the to-do usually comes up mid-prompt.

## ADHD review: less to weigh, one place to start, only what's wrong

A review of every screen for ADHD (canvas: ADHD review boards, Today and Session/Focus/Local) found the costs in the same few places: totals that can't be acted on shown as loudly as the one that can, no obvious first row, the same thing listed several times, and long lists of ✓ hiding the one ✕. Built from it:
- **Counters, option B:** the boxes stay (the themes draw on them), but My tasks / My PRs / Reviews show their actionable part with the total as a faint `of n`. Rejected A, one text line for the three: it loses the four-box rhythm.
- **NEXT in Needs you** is picked by rule, not a model: what unblocks a merge or a person first. It's moved to the top rather than marked in place, so ⏎ on opening Today works without moving the selection; z sleeps a wrong pick.
- **Threads box dropped:** the reply's last message is quoted on its row instead; each thing shows once.
- **My PRs state cell:** only failing checks are spelled out; the 4/4 score went (its tint stays). Drafts fold; Hide drafts went with it. The list is full width until a PR opens.
- **Focus** asks for an optional line and shows whole minutes (so nothing ticks), amber from 45 minutes; leaving says the line back with done / keep going / to-do for later, because the expensive moment is coming back after an interruption. The session bar's red PR segments fade in Focus: the failure is already in Needs you.
- **Bookmark rail:** prompts are plain grey; violet and glow stay for questions only (violet means "needs you").
- **Worktrees:** a one-at-a-time pass for Probably done (two keys, n / y; skip was dropped as a third choice that meant the same as keep), removals only at the end.
- **Workstream:** a "Since your last session" box, timeline newest first by day, status changes folded. "Since" counts from my last linked session rather than a stored last visit.
- **Contrast and time:** `--faint` raised to pass 4.5:1 in every theme; past times are ages everywhere.
- Left out on purpose: My tasks' "next moves" view (review item 6).
