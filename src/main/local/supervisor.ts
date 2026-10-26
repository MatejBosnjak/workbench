import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import type { WebContents } from 'electron'
import type { Branch, InfraService, LocalSnapshot, ServiceDef, ServiceState, Worktree } from '@shared/local'
import { PtyHost } from '../pty-host'
import { shellEnv } from '../shell-env'
import type { Repo } from '../store/repo'
import { infraStatus, startInfra } from './brew'
import { behindDefault, currentBranch, gitOut, isDirty, listBranches, listWorktrees, readWtrc, removeWorktree } from './git'
import { readMarks, serviceShell } from './shell'
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
  /** Services whose terminal is a shell: the command line it last started, and who waits for it to end. */
  private shells = new Set<string>()
  private lines = new Map<string, string>()
  private ended = new Map<string, () => void>()

  constructor(
    private config: LocalConfig,
    private repo: Repo,
    private wc: () => WebContents | undefined,
    private changed: (s: LocalSnapshot) => void,
    private paneExited: (id: string) => void = () => {},
  ) {
    this.pty = new PtyHost(
      (id, code) => this.onExit(id, code),
      undefined,
      undefined,
      (id, data) => (id.startsWith('svc:') ? this.onShellOutput(id.slice(4), data) : data),
    )
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
      services: [...this.states.values()].map((s) => ({ ...s, terminal: this.pty.has(serviceId(s.name)) })),
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
    this.follow(name, path)
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

  private isUp = (s: ServiceState) => s.status === 'running' || s.status === 'stopping'

  /**
   * Runs the service. Its terminal is a login shell in its folder (spawned if needed) and the command is typed into
   * it, so when the command ends the log stays and there's a prompt to fix things and run it again. Run-alongside
   * copies, and a login shell other than zsh, run the command directly as before.
   */
  async start(name: string, command?: string): Promise<void> {
    const s = this.states.get(name)
    if (!s || this.isUp(s)) return
    const line = command ?? s.def.command
    if (!s.transient && (await this.ensureShell(s))) {
      this.lines.set(name, line)
      this.pty.write(serviceId(name), `\x15${line}\r`)
    } else {
      if (this.pty.has(serviceId(name))) return
      const env = await shellEnv()
      this.pty.spawn(serviceId(name), {
        file: env.SHELL || '/bin/zsh',
        // Not interactive: the login env is already resolved, and an rc file would slow every start.
        args: ['-c', line],
        cwd: s.cwd,
        env: { ...env, ...s.def.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' },
        cols: 120,
        rows: 40,
        historyChars: 400_000,
      })
      const wc = this.wc()
      if (wc) this.pty.attach(serviceId(name), wc)
    }
    this.running_(s)
  }

  private running_(s: ServiceState): void {
    Object.assign(s, { status: 'running', exitCode: null, startedAt: Date.now(), healthy: s.def.port ? false : null })
    this.emit()
  }

  /** The service's shell terminal, spawned in its folder if it isn't there. False when services run without one. */
  private async ensureShell(s: ServiceState, size = { cols: 120, rows: 40 }): Promise<boolean> {
    const id = serviceId(s.name)
    if (this.pty.has(id)) return this.shells.has(s.name)
    const sh = serviceShell(await shellEnv())
    if (!sh) return false
    this.pty.spawn(id, {
      file: sh.file,
      args: ['-l'],
      cwd: s.cwd,
      env: { ...sh.env, ...s.def.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' },
      ...size,
      // Dev servers log constantly; the recent part is what matters on re-attach.
      historyChars: 400_000,
    })
    this.shells.add(s.name)
    const wc = this.wc()
    if (wc) this.pty.attach(id, wc)
    this.emit()
    return true
  }

  /**
   * Stops the service. In its shell: Ctrl-C, as you'd press it, then SIGTERM and SIGKILL to the command's process
   * group if it hangs; the shell stays. Otherwise the whole pty goes.
   */
  async stop(name: string): Promise<void> {
    const s = this.states.get(name)
    if (!s || !this.isUp(s)) return
    s.status = 'stopping'
    this.emit()
    const id = serviceId(name)
    if (!this.shells.has(name)) return void (await this.pty.stopGroup(id))
    const ended = new Promise<void>((r) => this.ended.set(name, r))
    const within = (ms: number) => Promise.race([ended.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
    this.pty.write(id, '\x03')
    if (await within(5000)) return
    const pid = this.pty.processes().find((p) => p.id === id)?.pid
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      for (const child of pid ? await childPids(pid) : []) {
        try {
          process.kill(-child, sig)
        } catch {
          try {
            process.kill(child, sig)
          } catch {
            // already gone
          }
        }
      }
      if (await within(3000)) return
    }
    this.ended.delete(name)
    Object.assign(s, { status: 'stopped', healthy: null })
    this.emit()
  }

  /** Takes the shell's start / exit markers out of a service terminal's output, and follows them. */
  private onShellOutput(name: string, data: string): string {
    const { data: out, marks } = readMarks(data)
    if (!marks.length) return data
    let shown = ''
    let from = 0
    for (const m of marks) {
      shown += out.slice(from, m.at)
      from = m.at
      shown += this.onMark(name, m.kind, m.value)
    }
    return shown + out.slice(from)
  }

  /** A command line started or ended in the service's shell; returns a note to show in the terminal. */
  private onMark(name: string, kind: 'start' | 'exit', value: string): string {
    const s = this.states.get(name)
    if (!s) return ''
    if (kind === 'start') {
      // ↑ ⏎ on the service command (or anything ending in it, like a checkout && the command) runs it again.
      const line = value.trim()
      const cmds = [this.lines.get(name), s.def.command, s.def.repo && readWtrc().commands[s.def.repo]].filter((c): c is string => !!c)
      // A checkout chained before the command changes the branch while the command keeps running.
      setTimeout(() => void this.refreshGit(), 3000)
      if (!this.isUp(s) && cmds.some((c) => line === c || line.endsWith(`&& ${c}`))) {
        this.lines.set(name, line)
        this.running_(s)
      }
      return ''
    }
    void this.refreshGit()
    if (!this.isUp(s)) return ''
    const code = parseInt(value, 10) || 0
    const stopped = s.status === 'stopping' || code === 0 || code === 130
    Object.assign(s, { status: stopped ? 'stopped' : 'crashed', exitCode: code, healthy: null })
    this.ended.get(name)?.()
    this.ended.delete(name)
    this.emit()
    const how = stopped ? 'stopped' : `exited · code ${code}`
    return `\r\n\x1b[2m[${name} ${how} · Start or ↑ ⏎ runs it again]\x1b[0m\r\n`
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
      if (s.def.profiles.includes(profile) && !this.isUp(s)) await this.start(s.name)
    }
  }

  /** Attaches the renderer to a pane: the service's own output, or a shell pane (spawned on first open). */
  async openPane(paneId: string, size: { cols: number; rows: number }, wc: WebContents): Promise<void> {
    if (paneId.startsWith('svc:')) {
      const s = this.states.get(paneId.slice(4))
      // Without a shell, the service pane only exists while the service runs.
      if (s && !s.transient) await this.ensureShell(s, size)
    } else if (!this.pty.has(paneId)) {
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

  /** Service and shell-pane ptys, for the memory overview; services are `svc:<name>`. */
  processes(): { id: string; pid: number; historyChars: number }[] {
    return this.pty.processes()
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

  /** Branches of the service's base checkout that no worktree has checked out, local first, newest first. */
  async branches(name: string): Promise<Branch[]> {
    const s = this.states.get(name)
    if (!s?.def.repo) return []
    const taken = new Set((await listWorktrees(s.def.repo, [s.def.cwd])).map((w) => w.branch))
    return listBranches(s.def.cwd, taken)
  }

  /** Whether the base checkout has uncommitted changes to tracked files (a checkout asks first). */
  baseDirty(name: string): Promise<boolean> {
    const s = this.states.get(name)
    return s ? isDirty(s.def.cwd) : Promise.resolve(false)
  }

  /**
   * Points the service at its base checkout and checks out a branch there, typed into the service terminal so a
   * failure is right there to fix. `stash` first stashes changes; `run` starts the service once the checkout worked.
   */
  async checkoutBranch(name: string, branch: string, opts: { run: boolean; stash: boolean }): Promise<void> {
    const s = this.states.get(name)
    if (!s) return
    await this.stop(name)
    const base = s.def.cwd
    if (s.cwd !== base) await this.setCwd(name, base)
    const cmd = (s.def.repo && readWtrc().commands[s.def.repo]) || s.def.command
    const steps = [...(opts.stash ? [`git stash push -m ${shellQuote(`workbench: before ${branch}`)}`] : []), `git switch ${shellQuote(branch)}`]
    if (await this.ensureShell(s)) {
      // setCwd already moved an open shell to the base checkout; a new one starts there.
      const line = [...steps, ...(opts.run ? [cmd] : [])].join(' && ')
      if (opts.run) this.lines.set(name, line)
      this.pty.write(serviceId(name), `\x15${line}\r`)
      if (opts.run) this.running_(s)
      return
    }
    if (opts.stash) await gitOut(base, ['stash', 'push', '-m', `workbench: before ${branch}`])
    await gitOut(base, ['switch', branch])
    await this.refreshGit()
    if (opts.run) await this.start(name, cmd)
  }

  /** Moves a service to another worktree; with `run`, restarts it there with the repo's wt command. */
  async switchWorktree(name: string, path: string, run: boolean): Promise<void> {
    const s = this.states.get(name)
    if (!s) return
    await this.stop(name)
    s.cwd = path
    this.repo.setSetting(`serviceCwd:${name}`, path)
    this.follow(name, path)
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

  /** Shell panes, and the service's own shell, follow it to another folder. */
  private follow(name: string, path: string): void {
    const ids = [...this.paneIds(name), ...(this.shells.has(name) ? [serviceId(name)] : [])]
    for (const id of ids) this.pty.write(id, `\x15cd ${shellQuote(path)}\r`)
  }

  private paneIds(name: string): string[] {
    return Array.from({ length: 16 }, (_, i) => `pane:${name}:${i}`).filter((id) => this.pty.has(id))
  }

  private onExit(id: string, code: number): void {
    if (!id.startsWith('svc:')) return this.paneExited(id)
    const name = id.slice(4)
    const s = this.states.get(name)
    this.shells.delete(name)
    this.lines.delete(name)
    this.ended.get(name)?.()
    this.ended.delete(name)
    if (!s) return
    // The shell itself ended (exit typed, or stopped with the app) while the service wasn't running.
    if (!this.isUp(s)) return this.emit()
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

/** Direct children of a process: in a job-control shell, each is the leader of its job's process group. */
function childPids(pid: number): Promise<number[]> {
  return new Promise((done) => execFile('pgrep', ['-P', String(pid)], (_e, out) => done(out.split('\n').map(Number).filter(Boolean))))
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
