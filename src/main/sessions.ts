import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { WebContents } from 'electron'
import type { Session } from '@shared/types'
import { PtyHost } from './pty-host'
import { shellEnv, which } from './shell-env'
import type { Repo, SessionRow } from './store/repo'

export const DEFAULT_CWD = join(homedir(), 'Productive/work')

export class Sessions {
  private pty: PtyHost

  constructor(
    private repo: Repo,
    private changed: () => void,
  ) {
    this.pty = new PtyHost((id, code) => {
      this.repo.update(id, { state: code === 0 ? 'idle' : 'failed', lastEventAt: Date.now() })
      this.changed()
    })
  }

  list(): Session[] {
    return this.repo.openTabs().map((r) => this.toSession(r))
  }

  create(cwd = this.repo.getSetting('defaultCwd', DEFAULT_CWD)): Session {
    const now = Date.now()
    const row: SessionRow = {
      id: randomUUID(),
      cwd,
      title: basename(cwd),
      state: 'idle',
      external: false,
      startedAt: now,
      lastEventAt: now,
    }
    this.repo.insertTab(row)
    this.changed()
    return this.toSession(row)
  }

  async open(id: string, size: { cols: number; rows: number }, wc: WebContents): Promise<void> {
    if (!this.pty.has(id)) {
      const row = this.repo.openTabs().find((r) => r.id === id)
      if (!row) return
      const env = await shellEnv()
      const claude = which('claude', env)
      if (!claude) throw new Error('claude not found on the login shell PATH')
      // A session that never got a prompt has no transcript, and --resume would fail on it.
      const args = hasTranscript(id) ? ['--resume', id] : ['--session-id', id]
      args.push('--permission-mode', this.repo.getSetting('permissionMode', 'bypassPermissions'))
      this.pty.spawn(id, {
        file: claude,
        args,
        cwd: existsSync(row.cwd) ? row.cwd : homedir(),
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WORKBENCH_SESSION_ID: id },
        ...size,
      })
      this.repo.update(id, { state: 'idle', lastEventAt: Date.now() })
      this.changed()
    }
    this.pty.attach(id, wc)
  }

  close(id: string): void {
    this.pty.kill(id)
    this.repo.closeTab(id)
    this.changed()
  }

  setTitle(id: string, title: string): void {
    this.repo.update(id, { title })
    this.changed()
  }

  reorder(ids: string[]): void {
    this.repo.reorder(ids)
    this.changed()
  }

  shutdown(): void {
    this.pty.killAll()
  }

  private toSession(r: SessionRow): Session {
    return { ...r, alive: this.pty.has(r.id) }
  }
}

function hasTranscript(id: string): boolean {
  const root = join(homedir(), '.claude', 'projects')
  try {
    return readdirSync(root).some((dir) => existsSync(join(root, dir, `${id}.jsonl`)))
  } catch {
    return false
  }
}
