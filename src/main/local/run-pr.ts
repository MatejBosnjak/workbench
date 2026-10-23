import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { FE_REPO, matchWorktree, type BackInfo, type DirtyGuard, type FePr, type RunJob, type RunPrSnapshot, type RunStep, type WorktreeCandidate } from '@shared/runpr'
import type { FocusTracker } from '../focus-pr'
import { fePr, fromPoller } from '../github/fe-pr'
import type { GitPoller } from '../github/poller'
import { shellEnv, which } from '../shell-env'
import type { Repo } from '../store/repo'
import { gitOut, listWorktrees, readWtrc } from './git'
import { portOpen, type Supervisor } from './supervisor'

const REPO = 'frontend'
const LOG_LINES = 200
const HEALTH_TIMEOUT_MS = 10 * 60_000
/** The read-only reference clone; never checked out or written to. */
const READ_ONLY = /\/work\/repos\/frontend\/?$/

class Cancelled extends Error {}

/**
 * Puts a frontend PR into the `app` service: its worktree when there is one, otherwise the base checkout
 * (the folder `app` is configured with) after fetch → checkout → install → package build. One job at a time.
 */
export class RunPr {
  private job: RunJob | null = null
  private back: BackInfo | null
  private kill: (() => void) | null = null
  private cancelled = false
  private hints: Record<number, string> = {}
  private appPr: number | null = null
  private nextId = 1
  private candidates: { at: number; list: Omit<WorktreeCandidate, 'hasHead'>[] } | null = null

  constructor(
    private repo: Repo,
    private local: Supervisor,
    private git: GitPoller,
    private focus: FocusTracker,
    private changed: () => void,
  ) {
    this.back = repo.getSetting<BackInfo | null>('runpr:back', null)
  }

  snapshot(): RunPrSnapshot {
    const app = this.app()
    return {
      job: this.job,
      back: this.back,
      app: {
        path: app?.cwd ?? '',
        branch: app?.branch ?? null,
        running: app?.status === 'running',
        port: app?.def.port ?? null,
        url: app?.def.url ?? (app?.def.port ? `http://localhost:${app.def.port}` : null),
      },
      appPr: this.appPr,
      focus: this.focus.snapshot(),
      hints: this.hints,
    }
  }

  /** Recomputes row hints and which PR the app runs. Called after git polls and local changes. */
  async refresh(): Promise<void> {
    const app = this.app()
    const fe = [...this.git.mine, ...this.git.reviews].filter((p) => p.repo === FE_REPO)
    const list = await this.worktrees()
    const hints: Record<number, string> = {}
    for (const p of fe) {
      const m = matchWorktree(p, list.map((w) => ({ ...w, hasHead: false })))
      hints[p.number] = m ? `worktree · ${basename(m.path).replace(/^frontend-/, '')}` : 'base checkout · fetch first'
    }
    const appPr = app?.branch ? (fe.find((p) => p.branch === app.branch)?.number ?? null) : null
    const same = JSON.stringify(hints) === JSON.stringify(this.hints) && appPr === this.appPr
    this.hints = hints
    this.appPr = appPr
    if (!same) this.changed()
  }

  /** Dirty files in the base checkout that a base run would have to deal with, or null when it's clean or not needed. */
  async guard(n: number): Promise<DirtyGuard | null> {
    const pr = await this.pr(n)
    if (!pr || (await this.findWorktree(pr))) return null
    const base = this.base()
    const files = ((await gitOut(base, ['status', '--porcelain'])) ?? '').split('\n').filter(Boolean)
    return files.length ? { dirty: true, path: base, files: files.map((f) => f.trim()) } : null
  }

  /**
   * Starts the run. `dirty` answers the guard: stash the base checkout's changes, or run alongside in a
   * review worktree instead. Without an answer a dirty base checkout returns the guard.
   */
  async run(n: number, opts: { alongside?: boolean; dirty?: 'stash' | 'alongside' } = {}): Promise<DirtyGuard | null> {
    if (this.job?.state === 'running') throw new Error('Another run is in progress')
    const pr = await this.pr(n)
    if (!pr) throw new Error(`Couldn't read fe #${n} from GitHub`)
    const app = this.app()
    if (!app) throw new Error('No service runs the frontend repo (services.json)')
    const wt = await this.findWorktree(pr)
    let alongside = !!opts.alongside || opts.dirty === 'alongside'
    if (!wt && !alongside && !opts.dirty) {
      const g = await this.guard(n)
      if (g) return g
    }
    // The base checkout is where `app` runs; a second copy can't share it, so it gets a review worktree.
    const reviewPath = !wt && alongside ? join(this.worktreesDir(), `frontend-review-${pr.number}`) : null
    const path = wt?.path ?? reviewPath ?? this.base()
    if (READ_ONLY.test(path)) throw new Error('Refusing to use the read-only reference clone work/repos/frontend')
    const mode = wt || reviewPath ? 'worktree' : 'base'
    const step = (id: string, label: string, detail: string | null = null): RunStep => ({ id, label, detail, state: 'pending', ms: null })
    const steps: RunStep[] =
      mode === 'worktree'
        ? [
            ...(reviewPath ? [step('fetch', `git fetch ${pr.fork ? `pull/${pr.number}/head` : pr.branch}`), step('worktree', 'add review worktree', basename(reviewPath))] : []),
            ...(alongside ? [] : [step('stop', 'stop app', app.branch)]),
            step('install', 'pnpm i'),
            ...(reviewPath ? [step('build', 'build workspace packages')] : []),
            step('start', alongside ? 'start a second app' : 'pnpm start'),
            step('wait', 'wait for the app to answer'),
          ]
        : [
            ...(opts.dirty === 'stash' ? [step('stash', 'stash changes', `workbench: before fe #${pr.number}`)] : []),
            step('fetch', `git fetch ${pr.fork ? `pull/${pr.number}/head` : pr.branch}`),
            step('stop', 'stop app', app.branch),
            step('checkout', `git checkout ${pr.fork ? `pr-${pr.number}` : pr.branch}`, app.branch ? `was: ${app.branch}` : null),
            step('install', 'pnpm i'),
            step('build', 'build workspace packages', 'lib · ui · form · prosemirror'),
            step('start', 'restart app'),
            step('wait', 'wait for the app to answer'),
          ]
    this.job = { id: this.nextId++, pr: { number: pr.number, title: pr.title, url: pr.url, branch: pr.branch }, mode, alongside, path, matchedBy: wt?.by ?? null, steps, log: [], state: 'running', error: null, url: null }
    this.cancelled = false
    this.changed()
    void this.execute(pr, mode, path, alongside, reviewPath !== null)
    return null
  }

  cancel(): void {
    if (this.job?.state !== 'running') return
    this.cancelled = true
    this.kill?.()
  }

  /** Puts the base checkout and the app back where they were before the last base run. */
  async goBack(): Promise<void> {
    const b = this.back
    const app = this.app()
    if (!b || !app) return
    if (this.job?.state === 'running') throw new Error('Another run is in progress')
    const step = (id: string, label: string, detail: string | null = null): RunStep => ({ id, label, detail, state: 'pending', ms: null })
    this.job = {
      id: this.nextId++,
      pr: { number: b.pr, title: `Back to ${b.previous}`, url: '', branch: b.previous },
      mode: 'base',
      alongside: false,
      path: b.path,
      matchedBy: null,
      steps: [step('stop', 'stop app'), step('checkout', `git checkout ${b.detached ? b.previous.slice(0, 10) : b.previous}`), ...(b.stash ? [step('unstash', 'restore stashed changes', b.stash)] : []), step('install', 'pnpm i'), step('start', 'restart app'), step('wait', 'wait for the app to answer')],
      log: [],
      state: 'running',
      error: null,
      url: null,
    }
    this.cancelled = false
    this.changed()
    try {
      await this.step('stop', () => this.local.stop(app.name))
      await this.step('checkout', () => this.sh('git', ['checkout', b.previous], b.path))
      if (b.stash) await this.step('unstash', () => this.popStash(b.path, b.stash!))
      await this.step('install', () => this.install(b.appPath))
      await this.step('start', async () => {
        await this.local.setCwd(app.name, b.appPath)
        await this.startApp(app.name, false)
      })
      await this.step('wait', () => this.waitHealthy(app.name))
      this.back = null
      this.repo.setSetting('runpr:back', null)
      this.finish('done')
    } catch (e) {
      this.finish(e instanceof Cancelled ? 'cancelled' : 'failed', (e as Error).message)
    }
  }

  // --- the run ---

  private async execute(pr: FePr, mode: 'worktree' | 'base', path: string, alongside: boolean, review: boolean): Promise<void> {
    const app = this.app()!
    const has = (id: string) => this.job!.steps.some((s) => s.id === id)
    const ref = pr.fork ? `pr-${pr.number}` : pr.branch
    try {
      if (mode === 'worktree') {
        if (review) {
          const root = this.base()
          await this.step('fetch', () => this.fetch(pr, root))
          await this.step('worktree', async () => {
            if (existsSync(path)) await this.sh('git', ['checkout', '--detach', pr.fork ? `pr-${pr.number}` : `origin/${pr.branch}`], path)
            else await this.sh('git', ['worktree', 'add', '--detach', path, pr.fork ? `pr-${pr.number}` : `origin/${pr.branch}`], root)
          })
        }
        if (has('stop')) await this.step('stop', () => this.local.stop(app.name))
        await this.step('install', () => this.install(path))
        if (has('build')) await this.step('build', () => this.build(path))
        let name = app.name
        await this.step('start', async () => {
          if (alongside) name = (await this.local.runAlongside(app.name, path, app.def.command)) ?? app.name
          else {
            await this.local.setCwd(app.name, path)
            await this.startApp(app.name, false)
          }
        })
        await this.step('wait', () => this.waitHealthy(name))
        const port = this.local.state(name)?.def.port
        this.job!.url = port ? `http://localhost:${port}` : null
        return this.finish('done')
      }

      // Base checkout.
      const base = path
      const before = (await gitOut(base, ['branch', '--show-current']))?.trim() || null
      const head = (await gitOut(base, ['rev-parse', 'HEAD']))?.trim() ?? ''
      let stash: string | null = null
      if (has('stash')) {
        await this.step('stash', async () => {
          stash = `workbench: before fe #${pr.number}`
          await this.sh('git', ['stash', 'push', '--include-untracked', '-m', stash], base)
        })
      }
      await this.step('fetch', () => this.fetch(pr, base))
      const appPath = app.cwd
      await this.step('stop', () => this.local.stop(app.name))
      await this.step('checkout', async () => {
        if (pr.fork || (await gitOut(base, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])) !== null) {
          await this.sh('git', ['checkout', ref], base)
          if (!pr.fork) await this.sh('git', ['merge', '--ff-only', `origin/${pr.branch}`], base)
        } else await this.sh('git', ['checkout', '-b', ref, '--track', `origin/${pr.branch}`], base)
      })
      this.back = { pr: pr.number, path: base, previous: before ?? head, detached: !before, stash, appPath }
      this.repo.setSetting('runpr:back', this.back)
      await this.step('install', () => this.install(base))
      await this.step('build', () => this.build(base))
      await this.step('start', async () => {
        await this.local.setCwd(app.name, base)
        await this.startApp(app.name, false)
      })
      await this.step('wait', () => this.waitHealthy(app.name))
      this.job!.url = app.def.port ? `http://localhost:${app.def.port}` : null
      this.finish('done')
    } catch (e) {
      this.finish(e instanceof Cancelled ? 'cancelled' : 'failed', (e as Error).message)
    }
    void this.refresh()
  }

  private async step(id: string, fn: () => Promise<unknown>): Promise<void> {
    const s = this.job?.steps.find((x) => x.id === id)
    if (!s) return
    if (this.cancelled) throw new Cancelled('Cancelled')
    s.state = 'running'
    this.changed()
    const t0 = Date.now()
    try {
      const r = await fn()
      s.state = r === 'skipped' ? 'skipped' : 'done'
      if (r === 'skipped' && !s.detail) s.detail = 'unchanged'
    } catch (e) {
      s.state = 'failed'
      throw this.cancelled ? new Cancelled('Cancelled') : e
    } finally {
      s.ms = Date.now() - t0
      this.changed()
    }
  }

  private finish(state: RunJob['state'], error: string | null = null): void {
    if (!this.job) return
    this.job.state = state
    this.job.error = error
    for (const s of this.job.steps) if (s.state === 'running') s.state = 'failed'
    this.kill = null
    this.changed()
    void this.local.refreshNow()
  }

  private async fetch(pr: FePr, cwd: string): Promise<void> {
    if (pr.fork) await this.sh('git', ['fetch', 'origin', `pull/${pr.number}/head:pr-${pr.number}`], cwd)
    else await this.sh('git', ['fetch', 'origin', pr.branch], cwd)
  }

  /** `pnpm i`, skipped when pnpm-lock.yaml hasn't changed since the last install in this folder. */
  private async install(cwd: string): Promise<'skipped' | void> {
    const lock = join(cwd, 'pnpm-lock.yaml')
    const hash = existsSync(lock) ? createHash('sha1').update(readFileSync(lock)).digest('hex') : null
    const key = `runpr:lock:${cwd}`
    if (hash && existsSync(join(cwd, 'node_modules')) && this.repo.getSetting<string | null>(key, null) === hash) return 'skipped'
    await this.sh('pnpm', ['i'], cwd)
    if (hash) this.repo.setSetting(key, hash)
  }

  /** The app's workspace dependencies; turbo's cache skips the ones that didn't change. */
  private build(cwd: string): Promise<void> {
    return this.sh('pnpm', ['turbo', 'run', 'build', '--filter=productive^...'], cwd)
  }

  private async startApp(name: string, alongside: boolean): Promise<void> {
    const s = this.local.state(name)!
    if (!alongside && s.def.port && s.status !== 'running' && (await portOpen(s.def.port)))
      throw new Error(`Port ${s.def.port} is used by a process Workbench didn't start (e.g. the prd tmux session). Stop it there, or use Run alongside.`)
    await this.local.start(name, s.def.command)
  }

  private async waitHealthy(name: string): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
      if (this.cancelled) throw new Cancelled('Cancelled')
      const s = this.local.state(name)
      if (!s || s.status === 'crashed' || s.status === 'stopped') throw new Error(`app exited${s?.exitCode != null ? ` with code ${s.exitCode}` : ''}; see its pane in Local`)
      if (!s.def.port || (await portOpen(s.def.port))) return
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error('The app did not answer within 10 minutes')
  }

  private async popStash(cwd: string, message: string): Promise<void> {
    const list = (await gitOut(cwd, ['stash', 'list', '--format=%gd %s'])) ?? ''
    const ref = list
      .split('\n')
      .find((l) => l.endsWith(message))
      ?.split(' ')[0]
    if (!ref) throw new Error(`Stash "${message}" not found; check git stash list`)
    await this.sh('git', ['stash', 'pop', ref], cwd)
  }

  /** Runs a command, streaming its output into the job log; Cancel kills its process group. */
  private async sh(cmd: string, args: string[], cwd: string): Promise<void> {
    const env = await shellEnv()
    // WORKBENCH_PNPM lets tests swap in a fake pnpm.
    const bin = (cmd === 'pnpm' && process.env.WORKBENCH_PNPM) || which(cmd, env) || cmd
    this.log(`$ ${cmd} ${args.join(' ')}`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: { ...env, FORCE_COLOR: '0', CI: '1' }, detached: true })
      this.kill = () => {
        try {
          process.kill(-child.pid!, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      let tail = ''
      const onData = (b: Buffer) => {
        const lines = (tail + b.toString()).split(/\r?\n|\r/)
        tail = lines.pop() ?? ''
        for (const l of lines) if (l.trim()) this.log(l)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', reject)
      child.on('close', (code) => {
        if (tail.trim()) this.log(tail)
        this.kill = null
        if (this.cancelled) reject(new Cancelled('Cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(`${cmd} ${args[0] ?? ''} exited with code ${code}`))
      })
    })
  }

  private log(line: string): void {
    if (!this.job) return
    // eslint-disable-next-line no-control-regex
    this.job.log.push(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400))
    if (this.job.log.length > LOG_LINES) this.job.log.splice(0, this.job.log.length - LOG_LINES)
    this.changed()
  }

  // --- lookup ---

  private app() {
    return this.local.serviceForRepo(REPO)
  }

  /** Where base runs happen: the folder `app` is configured with (not where it runs right now). */
  private base(): string {
    return this.app()?.def.cwd ?? ''
  }

  private worktreesDir(): string {
    const dirs = readWtrc().worktreesDirs
    return dirs.find((d) => existsSync(join(d))) ?? dirs[0] ?? join(this.base(), '..', 'worktrees')
  }

  private async pr(n: number): Promise<FePr | null> {
    const known = [...this.git.mine, ...this.git.reviews].find((p) => p.repo === FE_REPO && p.number === n)
    if (known) return { ...fromPoller(known), fork: (await fePr(n))?.fork ?? false }
    return fePr(n)
  }

  /** Frontend worktrees inside the .wtrc worktree folders, with their upstreams (cached two minutes). */
  private async worktrees(): Promise<Omit<WorktreeCandidate, 'hasHead'>[]> {
    if (this.candidates && Date.now() - this.candidates.at < 120_000) return this.candidates.list
    const dirs = readWtrc().worktreesDirs
    const all = (await listWorktrees(REPO, this.app() ? [this.app()!.def.cwd] : [])).filter((w) => dirs.some((d) => w.path.startsWith(`${d}/`)))
    const list = await Promise.all(
      all.map(async (w) => ({ path: w.path, branch: w.branch, upstream: (await gitOut(w.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim() || null })),
    )
    this.candidates = { at: Date.now(), list }
    return list
  }

  private async findWorktree(pr: FePr): Promise<{ path: string; by: 'branch' | 'upstream' | 'commit' } | null> {
    const list = await this.worktrees()
    const quick = matchWorktree(pr, list.map((w) => ({ ...w, hasHead: false })))
    if (quick) return quick
    // Last resort: a worktree whose HEAD already contains the PR's head commit (renamed branches).
    for (const w of list) {
      if ((await gitOut(w.path, ['merge-base', '--is-ancestor', pr.headSha, 'HEAD'])) !== null) return { path: w.path, by: 'commit' }
    }
    return null
  }
}
