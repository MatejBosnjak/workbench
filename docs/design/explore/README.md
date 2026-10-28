# Explorations

Design history: mocks drawn before or while a screen was built, with the variants that were weighed. **Not the current state.** What the app looks like now is `../current/*.png` (run `pnpm snap`) and `docs/SPEC.md`. Build from these only when a variant here has just been picked and isn't built yet.

Each file is a self-contained HTML mock: the markup sits inside `<x-dc>`, and the logic class at the bottom holds sample data. Colours are CSS variables (`../theme-dusk.json`). Live canvas: https://claude.ai/artifact/2KN1pTQZj99QBCqf6RDmMx

| File | Status | Current |
|---|---|---|
| `Focus.dc.html` | Superseded: pre-TUI layout (base C). The tab model survived; the look didn't | `session.png`, `palette.png` |
| `Today.dc.html` | Superseded: pre-TUI Today | `today-*.png` |
| `Task.dc.html` | Superseded: pre-TUI workstream | `workstream.png` |
| `Services.dc.html` | Superseded: pre-TUI Local | `local.png` |
| `TopBar.dc.html` | Superseded: pre-TUI top bar | any screenshot's top bar |
| `StatusBar.dc.html` | Superseded: pre-TUI status bar | any screenshot's status bar, `picker.png` |
| `StyleTui.dc.html` | Chosen: direction 1b, the TUI style. Still the reference for style rules (boxes, counters, type) | all |
| `CaffeinateLid.dc.html` | Superseded by `CaffeinateButton` | `caffeinate.png` |
| `CaffeinateButton.dc.html` | Chosen: the cup button and its popover | `caffeinate.png` |
| `CaffeinateHolds.dc.html` | Chosen: A (holds listed in the cup popover, Auto) with a small cup in the session bar; C (`wb awake`) deferred | `caffeinate.png` |
| `RunPR.dc.html` | Chosen: chip states, ▶ Run app, run panels, dirty guard | `today-prs.png` (▶ Run app) |
| `SessionBookmarks.dc.html` | Chosen: the rail | `session.png`, `session-legend.png` |
| `WorkstreamMine.dc.html` | Chosen: **B** (avatar on every row); NOW and A rejected | `workstream.png` |
| `TaskListClean.dc.html` | Chosen: **A** (quiet rows, tree lines) and the to-do-only rows; NOW rejected | `today-tasks.png` |
| `LinkSuggest.dc.html` | Chosen: all three cards. Built as a card under the session bar, not a popover from the Task button | `session-suggest.png` |
| `LocalTerminal.dc.html` | Chosen: both (service pane as a shell terminal; base-checkout branches in the switcher) | `local.png` |
| `AwsLogin.dc.html` | Chosen: the full-Local version (! on 2 Local with hover, aws chip, crash hint). Needs you item rejected; no amber state | `local.png` |
| `CassetteMuthur.dc.html` | Chosen: built as the MU/TH/UR theme (with status colours and lighter scanlines) | `theme-muthur*.png` |
| `CassetteBeige.dc.html` | Chosen: built as the Brown workstation theme (dark chrome, no bezel; the beige version was rejected) | `theme-brown*.png` |
| `CassetteConsole.dc.html` | Chosen: built as the Ops console theme | `theme-console*.png` |
| `SessionTabsFind.dc.html` | Explored: A–E ways to tell many tabs apart (labels, groups, badges, rail, switcher); led to colour per session | `session.png` |
| `SessionTabsColor.dc.html` | Chosen: **1 · colour bar**, built at 2px; chip and tinted tabs rejected | `session.png`, `theme-*-session.png` |
| `SessionTabsThemes.dc.html` | Chosen: per-theme palettes and MU/TH/UR sigils; the number-in-a-tile shape was not built (the bar was picked) | `theme-*-session.png` |
| `SessionTabsLive.dc.html` | Reference: now vs new, animated, with what we lose and gain | — |
| `SessionBarPrs.dc.html` | Chosen: **B · repo + CI word, worst first**; a segment per PR, numbers in the tooltip | `session.png`, `session-pr-side.png` |
| `TabRunGlyph.dc.html` | Chosen: **C + E3** · titles fade instead of …; running is a dim six-dot ring with a soft highlight going round | `session.png` |
| `NeedsTodos.dc.html` | Chosen: **C** · to-dos as Needs you rows with an add line, plus ⌥⌘T / ⌘K `todo` capture linked to the session on screen; B (own box) rejected | `today-needs.png`, `todo-capture.png` |

When a new exploration is picked: mark its row here (Chosen: X), build it, then `pnpm snap` and update `docs/SPEC.md` in the same commit.
