import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { API_REPO, FE_REPO, matchWorktree, type ApiBackInfo, type BackInfo, type DirtyGuard, type FePr, type RunJob, type RunPrSnapshot, type RunStep, type RunTarget, type WorktreeCandidate } from '@shared/runpr'
import type { FocusTracker } from '../focus-pr'
import { fePr, fromPoller } from '../github/fe-pr'
import type { GitPoller } from '../github/poller'
import { shellEnv, which } from '../shell-env'
import type { Repo } from '../store/repo'
import { gitOut, listWorktrees, readWtrc } from './git'
import { API_LOCAL_FILES, apiAnswers, linkTarget, pumaLink, pumaUrl, repoint } from './puma-dev'
import { portOpen, type Supervisor } from './supervisor'

const REPO = 'frontend'
const API = 'api'
const LOG_LINES = 200
const HEALTH_TIMEOUT_MS = 10 * 60_000
/** The read-only reference clones; never checked out or written to. */
const READ_ONLY = /\/work\/repos\/(frontend|api)\/?$/

class Cancelled extends Error {}

/**
 * Puts a frontend PR into the `app` service: its worktree when there is one, otherwise the base checkout
 * (the folder `app` is configured with) after fetch → checkout → install → package build.
 * An api PR goes to the api the same way: puma-dev's link and the `api` service (sidekiq) move to its worktree
 * or the base checkout, after config links → bundle → db:migrate. One job at a time across both.
 */
export class RunPr {
  private job: RunJob | null = null
  private back: BackInfo | null
  private kill: (() => void) | null = null
  private cancelled = false
  private hints: Record<number, string> = {}
  private appPr: number | null = null
  private apiBack: ApiBackInfo | null
  private apiHints: Record<number, string> = {}
  private apiPr: number | null = null
  private apiServed: { path: string; branch: string | null; url: string } | null = null
  private nextId = 1
  private candidates = new Map<string, { at: number; list: Omit<WorktreeCandidate, 'hasHead'>[] }>()

  constructor(
    private repo: Repo,
    private local: Supervisor,
    private git: GitPoller,
    private focus: FocusTracker,
    private changed: () => void,
  ) {
    this.back = repo.getSetting<BackInfo | null>('runpr:back', null)
    this.apiBack = repo.getSetting<ApiBackInfo | null>('runapi:back', null)
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
      api: this.apiServed,
      apiPr: this.apiPr,
      apiBack: this.apiBack,
      apiHints: this.apiHints,
    }
  }

  /** Recomputes row hints and which PR the app runs. Called after git polls and local changes. */
  async refresh(): Promise<void> {
    const app = this.app()
    const fe = [...this.git.mine, ...this.git.reviews].filter((p) => p.repo === FE_REPO)
    const hints = await this.rowHints(fe, REPO)
    const appPr = app?.branch ? (fe.find((p) => p.branch === app.branch)?.number ?? null) : null

    const api = [...this.git.mine, ...this.git.reviews].filter((p) => p.repo === API_REPO)
    const apiHints = this.apiSvc() ? await this.rowHints(api, API) : {}
    const link = this.apiSvc() ? pumaLink(this.apiBase()) : null
    const served = link ? linkTarget(link) : null
    const apiServed = link && served ? { path: served, branch: (await gitOut(served, ['branch', '--show-current']))?.trim() || null, url: pumaUrl(link) } : null
    const apiPr = apiServed?.branch ? (api.find((p) => p.branch === apiServed.branch)?.number ?? null) : null

    const next = { hints, appPr, apiHints, apiPr, apiServed }
    const same = JSON.stringify(next) === JSON.stringify({ hints: this.hints, appPr: this.appPr, apiHints: this.apiHints, apiPr: this.apiPr, apiServed: this.apiServed })
    Object.assign(this, next)
    if (!same) this.changed()
  }

  private async rowHints(prs: { number: number; branch: string }[], repo: string): Promise<Record<number, string>> {
    const list = await this.worktrees(repo)
    const hints: Record<number, string> = {}
    for (const p of prs) {
      const m = matchWorktree(p, list.map((w) => ({ ...w, hasHead: false })))
      hints[p.number] = m ? `worktree · ${basename(m.path).replace(new RegExp(`^${repo}-`), '')}` : 'base checkout · fetch first'
    }
    return hints
  }

  /** Dirty files in the base checkout that a base run would have to deal with, or null when it's clean or not needed. */
  async guard(n: number, target: RunTarget = 'app'): Promise<DirtyGuard | null> {
    const repo = target === 'api' ? API : REPO
    const pr = await this.pr(n, repo)
    if (!pr || (await this.findWorktree(pr, repo))) return null
    const base = target === 'api' ? this.apiBase() : this.base()
    const files = ((await gitOut(base, ['status', '--porcelain'])) ?? '').split('\n').filter(Boolean)
    return files.length ? { dirty: true, path: base, files: files.map((f) => f.trim()) } : null
  }

  /**
   * Starts the run. `dirty` answers the guard: stash the base checkout's changes, or run alongside in a
   * review worktree instead. Without an answer a dirty base checkout returns the guard.
   */
  async run(n: number, opts: { alongside?: boolean; dirty?: 'stash' | 'alongside'; target?: RunTarget } = {}): Promise<DirtyGuard | null> {
    if (this.job?.state === 'running') throw new Error('Another run is in progress')
    if (opts.target === 'api') return this.runApi(n, opts.dirty === 'stash')
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
    this.job = { id: this.nextId++, target: 'app', pr: { number: pr.number, title: pr.title, url: pr.url, branch: pr.branch }, mode, alongside, path, matchedBy: wt?.by ?? null, steps, log: [], state: 'running', error: null, url: null }
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
  async goBack(target: RunTarget = 'app'): Promise<void> {
    if (target === 'api') return this.goBackApi()
    const b = this.back
    const app = this.app()
    if (!b || !app) return
    if (this.job?.state === 'running') throw new Error('Another run is in progress')
    const step = (id: string, label: string, detail: string | null = null): RunStep => ({ id, label, detail, state: 'pending', ms: null })
    this.job = {
      id: this.nextId++,
      target: 'app',
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

  // --- the api ---

  /** Puts api #n behind puma-dev and sidekiq: its worktree, else the base checkout (`stash` answers the dirty guard). */
  private async runApi(n: number, stashFirst: boolean): Promise<DirtyGuard | null> {
    const pr = await this.pr(n, API)
    if (!pr) throw new Error(`Couldn't read api #${n} from GitHub`)
    const svc = this.apiSvc()
    if (!svc) throw new Error('No service runs the api repo (services.json)')
    const base = this.apiBase()
    const link = pumaLink(base)
    if (!link) throw new Error(`No puma-dev link for the api in ~/.puma-dev (expected api.productive.io -> ${base})`)
    const wt = await this.findWorktree(pr, API)
    if (!wt && !stashFirst) {
      const g = await this.guard(n, 'api')
      if (g) return g
    }
    const path = wt?.path ?? base
    if (READ_ONLY.test(path)) throw new Error('Refusing to use the read-only reference clone work/repos/api')
    const ref = pr.fork ? `pr-${pr.number}` : pr.branch
    const step = (id: string, label: string, detail: string | null = null): RunStep => ({ id, label, detail, state: 'pending', ms: null })
    const steps: RunStep[] = [
      ...(wt
        ? [step('links', 'link local config', API_LOCAL_FILES.join(' · '))]
        : [
            ...(stashFirst ? [step('stash', 'stash changes', `workbench: before api #${pr.number}`)] : []),
            step('fetch', `git fetch ${pr.fork ? `pull/${pr.number}/head` : pr.branch}`),
          ]),
      step('stop', 'stop sidekiq', svc.branch),
      ...(wt ? [] : [step('checkout', `git checkout ${ref}`, svc.branch ? `was: ${svc.branch}` : null)]),
      step('bundle', 'bundle install'),
      step('migrate', 'rails db:migrate', 'shared dev database'),
      step('puma', 'point puma-dev here', basename(link)),
      step('start', 'start sidekiq'),
      step('wait', 'wait for the api to answer'),
    ]
    this.job = { id: this.nextId++, target: 'api', pr: { number: pr.number, title: pr.title, url: pr.url, branch: pr.branch }, mode: wt ? 'worktree' : 'base', alongside: false, path, matchedBy: wt?.by ?? null, steps, log: [], state: 'running', error: null, url: null }
    this.cancelled = false
    this.changed()
    void this.executeApi(pr, path, link, !wt)
    return null
  }

  private async executeApi(pr: FePr, path: string, link: string, onBase: boolean): Promise<void> {
    const svc = this.apiSvc()!
    const has = (id: string) => this.job!.steps.some((s) => s.id === id)
    const ref = pr.fork ? `pr-${pr.number}` : pr.branch
    // The state before the first api run is what ↩ Back restores, however many runs follow.
    const back: ApiBackInfo = this.apiBack ?? { pr: pr.number, link: linkTarget(link), sidekiq: svc.cwd, checkout: null }
    back.pr = pr.number
    try {
      if (has('links')) await this.step('links', () => this.linkLocalFiles(path))
      if (onBase) {
        const before = (await gitOut(path, ['branch', '--show-current']))?.trim() || null
        const head = (await gitOut(path, ['rev-parse', 'HEAD']))?.trim() ?? ''
        let stash: string | null = null
        if (has('stash')) {
          await this.step('stash', async () => {
            stash = `workbench: before api #${pr.number}`
            await this.sh('git', ['stash', 'push', '--include-untracked', '-m', stash], path)
          })
        }
        await this.step('fetch', () => this.fetch(pr, path))
        await this.step('stop', () => this.local.stop(svc.name))
        await this.step('checkout', async () => {
          if (pr.fork || (await gitOut(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])) !== null) {
            await this.sh('git', ['checkout', ref], path)
            if (!pr.fork) await this.sh('git', ['merge', '--ff-only', `origin/${pr.branch}`], path)
          } else await this.sh('git', ['checkout', '-b', ref, '--track', `origin/${pr.branch}`], path)
        })
        back.checkout ??= { path, previous: before ?? head, detached: !before, stash }
      } else await this.step('stop', () => this.local.stop(svc.name))
      this.apiBack = back
      this.repo.setSetting('runapi:back', back)
      await this.step('bundle', () => this.bundle(path))
      await this.step('migrate', () => this.migrate(path))
      await this.step('puma', () => this.pointPuma(link, path))
      await this.step('start', async () => {
        await this.local.setCwd(svc.name, path)
        await this.local.start(svc.name, svc.def.command)
      })
      await this.step('wait', () => this.waitApi(svc.name, pumaUrl(link)))
      this.job!.url = pumaUrl(link)
      this.finish('done')
    } catch (e) {
      this.finish(e instanceof Cancelled ? 'cancelled' : 'failed', (e as Error).message)
    }
    void this.refresh()
  }

  /** Puts puma-dev, sidekiq and the base checkout back where they were before the first api run. */
  private async goBackApi(): Promise<void> {
    const b = this.apiBack
    const svc = this.apiSvc()
    const link = pumaLink(this.apiBase())
    if (!b || !svc || !link) return
    if (this.job?.state === 'running') throw new Error('Another run is in progress')
    const c = b.checkout
    const to = c ? (c.detached ? c.previous.slice(0, 10) : c.previous) : null
    const step = (id: string, label: string, detail: string | null = null): RunStep => ({ id, label, detail, state: 'pending', ms: null })
    this.job = {
      id: this.nextId++,
      target: 'api',
      pr: { number: b.pr, title: `Back to ${to ?? basename(b.link)}`, url: '', branch: to ?? '' },
      mode: c ? 'base' : 'worktree',
      alongside: false,
      path: b.link,
      matchedBy: null,
      steps: [
        step('stop', 'stop sidekiq'),
        ...(c ? [step('checkout', `git checkout ${to}`), ...(c.stash ? [step('unstash', 'restore stashed changes', c.stash)] : [])] : []),
        step('bundle', 'bundle install'),
        step('puma', 'point puma-dev back', basename(b.link)),
        step('start', 'start sidekiq', basename(b.sidekiq)),
        step('wait', 'wait for the api to answer'),
      ],
      log: [],
      state: 'running',
      error: null,
      url: null,
    }
    this.cancelled = false
    this.changed()
    try {
      await this.step('stop', () => this.local.stop(svc.name))
      if (c) {
        await this.step('checkout', () => this.sh('git', ['checkout', c.previous], c.path))
        if (c.stash) await this.step('unstash', () => this.popStash(c.path, c.stash!))
      }
      await this.step('bundle', () => this.bundle(b.link))
      await this.step('puma', () => this.pointPuma(link, b.link))
      await this.step('start', async () => {
        await this.local.setCwd(svc.name, b.sidekiq)
        await this.local.start(svc.name, svc.def.command)
      })
      await this.step('wait', () => this.waitApi(svc.name, pumaUrl(link)))
      this.apiBack = null
      this.repo.setSetting('runapi:back', null)
      this.finish('done')
    } catch (e) {
      this.finish(e instanceof Cancelled ? 'cancelled' : 'failed', (e as Error).message)
    }
    void this.refresh()
  }

  /** Symlinks the base checkout's gitignored config into a worktree, where it's missing. */
  private async linkLocalFiles(path: string): Promise<'skipped' | void> {
    const base = this.apiBase()
    let linked = 0
    for (const f of API_LOCAL_FILES) {
      const from = join(base, f)
      const to = join(path, f)
      if (!existsSync(from) || existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      symlinkSync(from, to)
      this.log(`linked ${f}`)
      linked++
    }
    if (!linked) return 'skipped'
  }

  private async bundle(cwd: string): Promise<'skipped' | void> {
    try {
      await this.sh('bundle', ['check'], cwd)
      return 'skipped'
    } catch (e) {
      if (e instanceof Cancelled) throw e
    }
    await this.sh('bundle', ['install'], cwd)
  }

  /** db:migrate on the shared dev database, without annotaterb rewriting models; its schema.rb dump is dropped when the file was clean before. */
  private async migrate(cwd: string): Promise<void> {
    const clean = !(await gitOut(cwd, ['status', '--porcelain', 'db/schema.rb']))?.trim()
    await this.sh('bundle', ['exec', 'rails', 'db:migrate'], cwd, { ANNOTATERB_SKIP_ON_DB_TASKS: '1' })
    if (clean && (await gitOut(cwd, ['status', '--porcelain', 'db/schema.rb']))?.trim()) await this.sh('git', ['checkout', '--', 'db/schema.rb'], cwd)
  }

  /** Repoints the link and stops puma-dev's apps, so the next request boots from the new folder. */
  private async pointPuma(link: string, to: string): Promise<void> {
    if (linkTarget(link) !== to) {
      repoint(link, to)
      this.log(`${basename(link)} -> ${to}`)
    }
    await this.sh('puma-dev', ['-stop'], to)
  }

  private async waitApi(name: string, url: string): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
      if (this.cancelled) throw new Cancelled('Cancelled')
      const s = this.local.state(name)
      if (!s || s.status === 'crashed') throw new Error(`sidekiq exited${s?.exitCode != null ? ` with code ${s.exitCode}` : ''}; see its pane in Local`)
      if (await apiAnswers(url)) return
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error('The api did not answer within 10 minutes')
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
  private async sh(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const env = await shellEnv()
    // WORKBENCH_PNPM lets tests swap in a fake pnpm.
    const bin = (cmd === 'pnpm' && process.env.WORKBENCH_PNPM) || which(cmd, env) || cmd
    this.log(`$ ${cmd} ${args.join(' ')}`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: { ...env, FORCE_COLOR: '0', CI: '1', ...extraEnv }, detached: true })
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

  private apiSvc() {
    return this.local.serviceForRepo(API)
  }

  private apiBase(): string {
    return this.apiSvc()?.def.cwd ?? ''
  }

  private worktreesDir(): string {
    const dirs = readWtrc().worktreesDirs
    return dirs.find((d) => existsSync(join(d))) ?? dirs[0] ?? join(this.base(), '..', 'worktrees')
  }

  private async pr(n: number, repo = REPO): Promise<FePr | null> {
    const full = repo === API ? API_REPO : FE_REPO
    const known = [...this.git.mine, ...this.git.reviews].find((p) => p.repo === full && p.number === n)
    if (known) return { ...fromPoller(known), fork: (await fePr(n, full))?.fork ?? false }
    return fePr(n, full)
  }

  /** The repo's worktrees inside the .wtrc worktree folders, with their upstreams (cached two minutes). */
  private async worktrees(repo = REPO): Promise<Omit<WorktreeCandidate, 'hasHead'>[]> {
    const hit = this.candidates.get(repo)
    if (hit && Date.now() - hit.at < 120_000) return hit.list
    const dirs = readWtrc().worktreesDirs
    const base = repo === API ? this.apiBase() : this.base()
    const all = (await listWorktrees(repo, base ? [base] : [])).filter((w) => dirs.some((d) => w.path.startsWith(`${d}/`)))
    const list = await Promise.all(
      all.map(async (w) => ({ path: w.path, branch: w.branch, upstream: (await gitOut(w.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim() || null })),
    )
    this.candidates.set(repo, { at: Date.now(), list })
    return list
  }

  private async findWorktree(pr: FePr, repo = REPO): Promise<{ path: string; by: 'branch' | 'upstream' | 'commit' } | null> {
    const list = await this.worktrees(repo)
    const quick = matchWorktree(pr, list.map((w) => ({ ...w, hasHead: false })))
    if (quick) return quick
    // Last resort: a worktree whose HEAD already contains the PR's head commit (renamed branches).
    for (const w of list) {
      if ((await gitOut(w.path, ['merge-base', '--is-ancestor', pr.headSha, 'HEAD'])) !== null) return { path: w.path, by: 'commit' }
    }
    return null
  }
}
