# Workbench

Personal Electron desktop app for working with Claude Code.

## Current state: read before any change

- `docs/SPEC.md` — **the app as built now**, one section per screen: behaviour, its screenshot, its code files. Trust it over memory or older mocks.
- `docs/design/current/*.png` — screenshots of every screen, taken from the real app by `pnpm snap` (scratch profile, live data). This is what the app looks like; match it.
- `docs/decisions.md` — why things are the way they are; don't relitigate.
- `docs/design/explore/` and the canvas (https://claude.ai/artifact/2KN1pTQZj99QBCqf6RDmMx) — **history and variants, not the current state**. `explore/README.md` says which variant was chosen. Never build from a mock unless I've just picked it. `explore/StyleTui.dc.html` is still the reference for style rules; colours are in `docs/design/theme-dusk.json`.

## A change is done when

1. It works in the app (drive it; don't stop at tests).
2. The screen's section in `docs/SPEC.md` describes it as built (behaviour, not history; the why goes in `decisions.md`).
3. Its screenshots are retaken: `pnpm snap <shot…>` (names are the files in `docs/design/current/`), or `pnpm snap` for all. Then refresh the canvas's CURRENT board: publish the new PNGs as `project/current/<name>.png` (re-read the live `project/canvas.json` first; other sessions add boards).
4. All three land in the same commit. The commit-msg hook (`scripts/docs-check.mjs`) rejects a `src/` change unless the SPEC sections whose `Code:` line lists those files are updated too (screenshots alone don't count); it names the sections. A new file goes on the `Code:` line of the section it belongs to. Put `[no-docs]` in the message only when nothing visible or behavioural changed.

Other sessions may be working in this repo at the same time: pull before starting, re-read the screen's SPEC section and screenshot before designing, and don't revert docs another session updated.

## Working rules

- For a UI change, show the design on the canvas first (starting from the current screenshot), and wait for a pick. For a bigger change, propose the approach: structure, libraries, trade-offs. Wait for a go-ahead.
- Stack: Electron, TypeScript, React 19 + Zustand, node-pty, xterm.js 6, SQLite (better-sqlite3, append-only migrations).
- Check: `pnpm typecheck`, `pnpm test`; ship: `pnpm install-app` (quit Workbench first, reopen after).
- Never post to GitHub, Productive or Slack without an explicit confirm from me.
- Global changes to `~/.claude/settings.json` (hooks, statusline) go only through the app's Install hooks / Uninstall flow, always with a backup. Don't edit that file by hand during development.
- Secrets: the Productive token lives in the macOS keychain (env `PRODUCTIVE_AUTH_TOKEN` in my shell, loaded by `~/.zprofile`); GitHub access goes through `gh`. Never hardcode either.
- Keep replies terse; no trailing summaries.
