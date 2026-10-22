import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HooksStatus } from '@shared/types'

/** Hook events Workbench listens to. PostToolUse moves a tab from "waiting" back to "running" after a permission prompt. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'] as const

// Every command Workbench adds ends with this shell comment, so its entries can be found again.
const MARK = '# workbench'

export interface InstallPaths {
  /** ~/.claude/settings.json */
  settings: string
  /** Where the client scripts are installed; stable across app rebuilds. */
  binDir: string
  /** Holds the pre-install statusLine so Uninstall can restore it. */
  dataDir: string
  socket: string
  /** Bundled script templates. */
  templates: string
}

interface HookCommand {
  type: string
  command?: string
  [k: string]: unknown
}
interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
  [k: string]: unknown
}
export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>
  statusLine?: { type: string; command?: string; [k: string]: unknown }
  [k: string]: unknown
}

const isOurs = (cmd?: string) => !!cmd && cmd.trimEnd().endsWith(MARK)
const command = (script: string) => `"${script}" ${MARK}`

export function status(s: ClaudeSettings): HooksStatus {
  return {
    hooks: HOOK_EVENTS.every((e) => s.hooks?.[e]?.some((g) => g.hooks.some((h) => isOurs(h.command)))),
    statusline: isOurs(s.statusLine?.command),
  }
}

/** Returns the new settings plus the statusLine they replace (null when there was none, undefined when already ours). */
export function planInstall(s: ClaudeSettings, binDir: string): { next: ClaudeSettings; replaced: ClaudeSettings['statusLine'] | null | undefined } {
  const clean = withoutOurHooks(s)
  const hooks = { ...clean.hooks }
  for (const e of HOOK_EVENTS) {
    hooks[e] = [...(hooks[e] ?? []), { hooks: [{ type: 'command', command: command(join(binDir, 'wb-hook')) }] }]
  }
  const ours = isOurs(s.statusLine?.command)
  // Keep padding etc. from the user's statusline; only the command is wrapped.
  const statusLine = { ...s.statusLine, type: 'command', command: command(join(binDir, 'wb-statusline')) }
  return { next: { ...clean, hooks, statusLine }, replaced: ours ? undefined : (s.statusLine ?? null) }
}

export function planUninstall(s: ClaudeSettings, original: ClaudeSettings['statusLine'] | null): ClaudeSettings {
  const next = withoutOurHooks(s)
  if (isOurs(s.statusLine?.command)) {
    if (original) next.statusLine = original
    else delete next.statusLine
  }
  return next
}

function withoutOurHooks(s: ClaudeSettings): ClaudeSettings {
  if (!s.hooks) return { ...s }
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(s.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length > 0)
    if (kept.length) hooks[event] = kept
  }
  const { hooks: _old, ...rest } = s
  return Object.keys(hooks).length ? { ...rest, hooks } : rest
}

// --- file side ---

const ORIGINAL_JSON = 'statusline-original.json'
const ORIGINAL_CMD = 'statusline-command'

export function readSettings(file: string): ClaudeSettings {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ClaudeSettings) : {}
}

export function currentStatus(p: InstallPaths): HooksStatus {
  return status(readSettings(p.settings))
}

/** Backs up settings.json, installs the client scripts, and adds Workbench's entries. Returns the backup path. */
export function install(p: InstallPaths): string | null {
  const settings = readSettings(p.settings)
  const backup = backupSettings(p.settings)
  const { next, replaced } = planInstall(settings, p.binDir)
  mkdirSync(p.dataDir, { recursive: true })
  if (replaced !== undefined) {
    writeFileSync(join(p.dataDir, ORIGINAL_JSON), JSON.stringify(replaced))
    writeFileSync(join(p.dataDir, ORIGINAL_CMD), replaced?.command ?? '')
  }
  writeScripts(p)
  writeJsonAtomic(p.settings, next)
  return backup
}

export function uninstall(p: InstallPaths): string | null {
  const settings = readSettings(p.settings)
  const backup = backupSettings(p.settings)
  const origFile = join(p.dataDir, ORIGINAL_JSON)
  const original = existsSync(origFile) ? (JSON.parse(readFileSync(origFile, 'utf8')) as ClaudeSettings['statusLine'] | null) : null
  writeJsonAtomic(p.settings, planUninstall(settings, original))
  rmSync(origFile, { force: true })
  rmSync(join(p.dataDir, ORIGINAL_CMD), { force: true })
  return backup
}

/** Copies the client scripts into binDir with this machine's paths filled in. */
export function writeScripts(p: InstallPaths): void {
  mkdirSync(p.binDir, { recursive: true })
  for (const name of ['wb-hook', 'wb-statusline']) {
    const body = readFileSync(join(p.templates, name), 'utf8')
      .replaceAll('@@SOCKET@@', p.socket)
      .replaceAll('@@ORIGINAL@@', join(p.dataDir, ORIGINAL_CMD))
    const dest = join(p.binDir, name)
    writeFileSync(dest, body)
    chmodSync(dest, 0o755)
  }
}

function backupSettings(file: string): string | null {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.workbench-backup-${stamp}`
  copyFileSync(file, backup)
  return backup
}

function writeJsonAtomic(path: string, data: unknown): void {
  // Write through a symlinked settings.json (dotfiles repos) instead of replacing the link.
  const file = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.workbench-tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, file)
}
