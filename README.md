# Workbench

Personal desktop app for working with Claude Code: session tabs, local dev services, and a Today view of Productive tasks, PRs and review requests.

- Spec: [docs/SPEC.md](docs/SPEC.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- Design: https://claude.ai/artifact/2KN1pTQZj99QBCqf6RDmMx

## Develop

```sh
pnpm install
pnpm dev        # electron-vite with hot reload
pnpm test
pnpm typecheck
```

## Install the app

```sh
pnpm install-app   # builds dist/mac-arm64/Workbench.app and copies it to /Applications
```

The build is unsigned. If macOS blocks the first launch, right-click the app and choose Open.

Then use **Workbench › Install Hooks…** once. It backs up `~/.claude/settings.json`, adds hook
entries marked `# workbench`, and wraps your statusline (your command still runs). **Uninstall
Hooks…** removes exactly those entries and restores the statusline.

## Developing without touching your global settings

```sh
WORKBENCH_CLAUDE_SETTINGS=/tmp/wb-settings.json WORKBENCH_SOCKET=/tmp/wb-dev.sock pnpm dev
```

Install Hooks then writes to that file instead, and sessions started by this instance load it
with `claude --settings`.

`WORKBENCH_BACKGROUND=1` opens the window behind whatever has focus and keeps the app out of the
Dock and ⌘-Tab. Automated test runs use it.
