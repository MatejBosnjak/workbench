import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentStatus, HOOK_EVENTS, install, planInstall, planUninstall, readSettings, status, uninstall, type ClaudeSettings } from './hooks-install'

const BIN = '/Users/me/Library/Application Support/Workbench/bin'

const userSettings = (): ClaudeSettings => ({
  model: 'opus',
  statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh', padding: 0 },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay done.aiff' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  },
})

describe('planInstall / planUninstall', () => {
  it('adds one marked hook per event and keeps the user’s own hooks', () => {
    const { next, replaced } = planInstall(userSettings(), BIN)
    for (const e of HOOK_EVENTS) {
      const ours = next.hooks![e]!.flatMap((g) => g.hooks).filter((h) => h.command?.endsWith('# workbench'))
      expect(ours).toHaveLength(1)
      expect(ours[0]!.command).toBe(`"${BIN}/wb-hook" # workbench`)
    }
    expect(next.hooks!.Stop![0]!.hooks[0]!.command).toBe('afplay done.aiff')
    expect(next.hooks!.PreToolUse).toEqual(userSettings().hooks!.PreToolUse)
    expect(next.model).toBe('opus')
    expect(replaced).toEqual(userSettings().statusLine)
    expect(next.statusLine).toEqual({ type: 'command', command: `"${BIN}/wb-statusline" # workbench`, padding: 0 })
    expect(status(next)).toEqual({ hooks: true, statusline: true })
  })

  it('is idempotent', () => {
    const once = planInstall(userSettings(), BIN).next
    const twice = planInstall(once, BIN)
    expect(twice.next).toEqual(once)
    expect(twice.replaced).toBeUndefined()
  })

  it('uninstall restores the original settings exactly', () => {
    const { next, replaced } = planInstall(userSettings(), BIN)
    expect(planUninstall(next, replaced ?? null)).toEqual(userSettings())
  })

  it('uninstall drops the hooks key and statusLine when there were none', () => {
    const { next, replaced } = planInstall({}, BIN)
    expect(replaced).toBeNull()
    expect(planUninstall(next, null)).toEqual({})
  })
})

describe('install / uninstall on disk', () => {
  it('backs up, writes scripts, and round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-install-'))
    const settings = join(dir, 'settings.json')
    const original = JSON.stringify(userSettings(), null, 2) + '\n'
    writeFileSync(settings, original)
    const paths = { settings, binDir: join(dir, 'bin'), dataDir: dir, socket: join(dir, 's.sock'), templates: resolve('resources/bin'), skillsDir: join(dir, 'skills'), skillTemplates: resolve('resources/skills') }

    const backup = install(paths)
    expect(readFileSync(backup!, 'utf8')).toBe(original)
    expect(status(readSettings(settings))).toEqual({ hooks: true, statusline: true })
    const hook = readFileSync(join(dir, 'bin', 'wb-hook'), 'utf8')
    expect(hook).toContain(`SOCK='${join(dir, 's.sock')}'`)
    expect(statSync(join(dir, 'bin', 'wb-hook')).mode & 0o111).toBeTruthy()
    expect(readFileSync(join(dir, 'statusline-command'), 'utf8')).toBe('bash ~/.claude/statusline-command.sh')
    expect(readFileSync(join(dir, 'bin', 'wb'), 'utf8')).toContain(`SOCK='${join(dir, 's.sock')}'`)
    expect(readFileSync(join(dir, 'skills', 'workbench', 'SKILL.md'), 'utf8')).toContain(join(dir, 'bin', 'wb'))
    expect(currentStatus(paths).skill).toBe(true)

    uninstall(paths)
    expect(readFileSync(settings, 'utf8')).toBe(original)
    expect(existsSync(join(dir, 'statusline-command'))).toBe(false)
    expect(existsSync(join(dir, 'skills', 'workbench'))).toBe(false)
    expect(readdirSync(dir).filter((f) => f.includes('workbench-backup'))).toHaveLength(2)
  })
})
