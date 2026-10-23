import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import type { WebContents } from 'electron'
import type { InfraService, LocalSnapshot, ServiceDef, ServiceState, Worktree } from '@shared/local'
import { PtyHost } from '../pty-host'
import { shellEnv } from '../shell-env'
import type { Repo } from '../store/repo'
import { infraStatus, startInfra } from './brew'
import { behindDefault, currentBranch, isDirty, listWorktrees, readWtrc, removeWorktree } from './git'
import type { LocalConfig } from './config'

const serviceId = (name: string) => `svc:${name}`
const HEALTH_MS = 5_000
const GIT_MS = 30_000

/** Runs the local stack: one pty per service plus shell panes, with health and git info. */
export class Supervisor {
  private pty: PtyHost
  private states = new Map<string, ServiceState>()
  private infra: InfraService[] = []
  private timers: NodeJS.Timeout[] = []

  constructor(
    private config: LocalConfig,
    private repo: Repo,
    private wc: () => WebContents | undefined,
    private changed: (s: LocalSnapshot) => void,
    private paneExited: (id: string) => void = () => {},
  ) {
    this.pty = new PtyHost((id, code) => this.onExit(id, code))
    for (const def of config.services) this.states.set(def.name, this.initial(def, false))
    // brew is slow to answer; show the chips straight away.
    this.infra = config.infra.map((name) => ({ name, status: 'unknown' }))
    this.timers.push(setInterval(() => void this.checkHealth(), HEALTH_MS))
    this.timers.push(setInterval(() => void this.refreshGit(), GIT_MS))
    void this.refreshGit()
    void this.refreshInfra()
  }

  snapshot(): LocalSnapshot {
    return {
      services: [...this.states.values()],
      profiles: this.config.profiles,
      profile: this.repo.getSetting('localProfile', this.config.profiles[0]?.id ?? 'full'),
      infra: this.infra,
    }
  }

  state(name: string): ServiceState | undefined {
    return this.states.get(name)
  }

  /** The service that runs this repo (e.g. `app` for frontend). */
  serviceForRepo(repo: string): ServiceState | undefined {
    return [...this.states.values()].find((s) => s.def.repo === repo && !s.transient)
  }

  /** Points a stopped service at another folder (no restart). */
  async setCwd(name: string, path: string): Promise<void> {
    const s = this.states.get(name)
    if (!s) return
    s.cwd = path
    this.repo.setSetting(`serviceCwd:${name}`, path)
    for (const id of this.paneIds(name)) this.pty.write(id, `\x15cd ${shellQuote(path)}\r`)
    await this.refreshGit()
  }

  async refreshNow(): Promise<void> {
    await this.refreshGit()
  }

  setProfile(id: string): void {
    this.repo.setSetting('localProfile', id)
    this.emit()
  }

  running(): ServiceState[] {
    return [...this.states.values()].filter((s) => s.status === 'running' || s.status === 'stopping')
  }

  async start(name: string, command?: string): Promise<void> {
    const s = this.states.get(name)
    if (!s || this.pty.has(serviceId(name))) return
    const env = await shellEnv()
    const shell = env.SHELL || '/bin/zsh'
    this.pty.spawn(serviceId(name), {
      file: shell,
      // Not interactive: the login env is already resolved, and an rc file would slow every start.
      args: ['-c', command ?? s.def.command],
      cwd: s.cwd,
      env: { ...env, ...s.def.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' },
      cols: 120,
      rows: 40,
      // Dev servers log constantly; the recent part is what matters on re-attach.
      historyChars: 400_000,
    })
    Object.assign(s, { status: 'running', exitCode: null, startedAt: Date.now(), healthy: s.def.port ? false : null })
    const wc = this.wc()
    if (wc) this.pty.attach(serviceId(name), wc)
    this.emit()
  }

  async stop(name: string): Promise<void> {
    const s = this.states.get(name)
    if (!s || !this.pty.has(serviceId(name))) return
    s.status = 'stopping'
    this.emit()
    await this.pty.stopGroup(serviceId(name))
  }

  async restart(name: string): Promise<void> {
    await this.stop(name)
    await this.start(name)
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.running().map((s) => this.stop(s.name)))
  }

  /** Starts every service in the profile that isn't running. */
  async startMissing(profile: string): Promise<void> {
    for (const s of this.states.values()) {
      if (s.def.profiles.includes(profile) && !this.pty.has(serviceId(s.name))) await this.start(s.name)
    }
  }

  /** Attaches the renderer to a pane: the service's own output, or a shell pane (spawned on first open). */
  async openPane(paneId: string, size: { cols: number; rows: number }, wc: WebContents): Promise<void> {
    if (!this.pty.has(paneId)) {
      if (paneId.startsWith('svc:')) return // the service pane only exists while the service runs
      const name = paneId.split(':')[1] ?? ''
      const s = this.states.get(name)
      const env = await shellEnv()
      this.pty.spawn(paneId, {
        file: env.SHELL || '/bin/zsh',
        args: ['-l'],
        cwd: s?.cwd ?? homedir(),
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        ...size,
        historyChars: 200_000,
      })
    }
    this.pty.attach(paneId, wc)
  }

  closePane(paneId: string): void {
    void this.pty.killAndWait(paneId)
  }

  isAlive(paneId: string): boolean {
    return this.pty.has(paneId)
  }

  // --- worktrees ---

  async worktrees(name: string): Promise<Worktree[]> {
    const s = this.states.get(name)
    if (!s?.def.repo) return []
    const list = await listWorktrees(s.def.repo, [s.def.cwd])
    // Dirty is the slow part; checked in parallel, eight at a time.
    let next = 0
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < list.length) {
          const w = list[next++]!
          w.dirty = await isDirty(w.path)
        }
      }),
    )
    return list
  }

  /** Moves a service to another worktree; with `run`, restarts it there with the repo's wt command. */
  async switchWorktree(name: string, path: string, run: boolean): Promise<void> {
    const s = this.states.get(name)
    if (!s) return
    await this.stop(name)
    s.cwd = path
    this.repo.setSetting(`serviceCwd:${name}`, path)
    // Shell panes follow along.
    for (const id of this.paneIds(name)) this.pty.write(id, `\x15cd ${shellQuote(path)}\r`)
    await this.refreshGit()
    if (run) await this.start(name, (s.def.repo && readWtrc().commands[s.def.repo]) || s.def.command)
    this.emit()
  }

  /** Starts a second copy of the service on the next free port, in the given worktree. */
  async runAlongside(name: string, path: string, command?: string): Promise<string | null> {
    const s = this.states.get(name)
    if (!s?.def.port) return null
    let port = s.def.port + 1
    const taken = new Set([...this.states.values()].map((x) => x.def.port))
    while (taken.has(port) || (await portOpen(port))) port++
    const copy: ServiceDef = {
      ...s.def,
      name: `${name}:${port}`,
      cwd: path,
      port,
      url: s.def.url?.replace(`:${s.def.port}`, `:${port}`),
      env: { ...s.def.env, DEV_APP_PORT: String(port) },
      panes: 0,
    }
    this.states.set(copy.name, { ...this.initial(copy, true), cwd: path })
    await this.refreshGit()
    await this.start(copy.name, command ?? ((s.def.repo && readWtrc().commands[s.def.repo]) || s.def.command))
    return copy.name
  }

  removeWorktree(path: string): Promise<string | null> {
    return removeWorktree(path)
  }

  // --- infra ---

  async refreshInfra(): Promise<void> {
    this.infra = await infraStatus(this.config.infra)
    this.emit()
  }

  async startInfra(name: string): Promise<void> {
    await startInfra(name)
    await this.refreshInfra()
  }

  dispose(): void {
    this.timers.forEach(clearInterval)
    this.pty.killAll()
  }

  private initial(def: ServiceDef, transient: boolean): ServiceState {
    return {
      name: def.name,
      def,
      status: 'stopped',
      exitCode: null,
      startedAt: null,
      healthy: null,
      cwd: transient ? def.cwd : this.repo.getSetting(`serviceCwd:${def.name}`, def.cwd),
      branch: null,
      base: null,
      behind: null,
      transient,
    }
  }

  private paneIds(name: string): string[] {
    return Array.from({ length: 16 }, (_, i) => `pane:${name}:${i}`).filter((id) => this.pty.has(id))
  }

  private onExit(id: string, code: number): void {
    if (!id.startsWith('svc:')) return this.paneExited(id)
    const name = id.slice(4)
    const s = this.states.get(name)
    if (!s) return
    const stopped = s.status === 'stopping'
    Object.assign(s, { status: stopped || code === 0 ? 'stopped' : 'crashed', exitCode: code, healthy: null })
    if (s.transient && (stopped || code === 0)) this.states.delete(name)
    this.emit()
  }

  private async checkHealth(): Promise<void> {
    let changed = false
    for (const s of this.states.values()) {
      if (s.status !== 'running' || !s.def.port) continue
      const ok = await portOpen(s.def.port)
      if (ok !== s.healthy) {
        s.healthy = ok
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private async refreshGit(): Promise<void> {
    await Promise.all(
      [...this.states.values()].map(async (s) => {
        s.branch = await currentBranch(s.cwd)
        Object.assign(s, s.branch ? await behindDefault(s.cwd) : { behind: null })
      }),
    )
    this.emit()
  }

  private emit(): void {
    this.changed(this.snapshot())
  }
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(1000, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
