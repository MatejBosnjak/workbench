# Workbench

Personal Electron desktop app for working with Claude Code. Read these first:

- `docs/SPEC.md` — what we're building, the architecture, and the phases
- `docs/decisions.md` — decisions already made; don't relitigate them
- `docs/design/*.dc.html` — the reference design. Each file is a self-contained HTML mock: the markup sits inside `<x-dc>`, and the logic class at the bottom holds the sample data and computed styles. Colours are CSS variables; the v1 theme's values are in `docs/design/theme-dusk.json`. The live canvas is https://claude.ai/artifact/2KN1pTQZj99QBCqf6RDmMx

| File | Shows |
|---|---|
| `TopBar.dc.html` | top bar |
| `StatusBar.dc.html` | status bar: usage, caffeinate, picker |
| `Today.dc.html` | My tasks / My git / My reviews and the task preview |
| `Services.dc.html` | Local services: split panes and the worktree switcher |
| `Focus.dc.html` | session view and ⌘K |
| `Task.dc.html` | Task workstream screen (v1.1) |
| `CaffeinateLid.dc.html` | caffeinate icon options; variant 4h is chosen |

## Working rules

- Build phase by phase as listed in the spec. Phase 1 is Shell + sessions. Each phase has to be usable daily before the next one starts.
- Before writing code for a phase, propose the approach: structure, libraries, trade-offs. Wait for a go-ahead.
- Stack: Electron, TypeScript, node-pty, xterm.js, SQLite (better-sqlite3). Renderer framework is not decided yet; propose one.
- Never post to GitHub, Productive or Slack without an explicit confirm from me.
- Global changes to `~/.claude/settings.json` (hooks, statusline) go only through the app's Install hooks / Uninstall flow, always with a backup. Don't edit that file by hand during development.
- Secrets: the Productive token lives in the macOS keychain (env `PRODUCTIVE_AUTH_TOKEN` in my shell, loaded by `~/.zprofile`); GitHub access goes through `gh`. Never hardcode either.
- Keep replies terse; no trailing summaries.
