import { existsSync } from 'node:fs'
import { FE_REPO, ghPrCommand, pickFocus, prMentions, prUrls, type FePr, type Signal, type SignalKind } from '@shared/runpr'
import { fePr, fePrForBranch, fromPoller } from './github/fe-pr'
import type { GitPoller } from './github/poller'
import { currentBranch, gitOut } from './local/git'
import type { Sessions } from './sessions'
import type { HookPayload } from './signal-server'
import type { Repo } from './store/repo'

const WORKTREE_MS = 30_000

/** Which frontend PR each session is about, from its worktree, prompts, output, task links and gh commands. */
export class FocusTracker {
  private signals = new Map<string, Signal[]>()
  private focus = new Map<string, FePr>()
  private feRepo = new Map<string, boolean>()
  private timer: NodeJS.Timeout

  constructor(
    private repo: Repo,
    private sessions: Sessions,
    private git: GitPoller,
    private changed: () => void,
  ) {
    this.timer = setInterval(() => void this.checkWorktrees(), WORKTREE_MS)
    void this.checkWorktrees()
  }

  snapshot(): Record<string, FePr> {
    return Object.fromEntries(this.focus)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  onHook(sessionId: string, event: string, p: HookPayload): void {
    if (event === 'UserPromptSubmit' && p.prompt) for (const n of prMentions(p.prompt)) this.add(sessionId, 'mention', n)
    if (event === 'PostToolUse' && p.tool_name === 'Bash') {
      const n = ghPrCommand(String((p.tool_input as { command?: string } | undefined)?.command ?? ''))
      if (n) this.add(sessionId, 'gh', n)
    }
    if (event === 'SessionStart') void this.checkWorktree(sessionId, p.cwd)
  }

  /** Terminal output of a Workbench session. */
  onOutput(sessionId: string, data: string): void {
    if (!data.includes('productiveio/frontend/pull/')) return
    for (const n of prUrls(data)) this.add(sessionId, 'mention', n)
  }

  /** Frontend PRs of the session's linked tasks. */
  refreshTasks(): void {
    for (const s of this.sessions.list()) {
      const tasks = new Set(this.repo.links().filter((l) => l.sessionId === s.id).map((l) => l.taskId))
      const pr = [...this.git.mine, ...this.git.reviews].find((p) => p.repo === FE_REPO && p.taskRefs.some((t) => tasks.has(t)))
      this.replace(s.id, 'task', pr?.number ?? null, 0)
    }
  }

  private async checkWorktrees(): Promise<void> {
    for (const s of this.sessions.list()) await this.checkWorktree(s.id, s.cwd)
    this.refreshTasks()
  }

  private async checkWorktree(sessionId: string, cwd: string): Promise<void> {
    if (!cwd || !existsSync(cwd) || !(await this.isFrontend(cwd))) return this.replace(sessionId, 'worktree', null, 0)
    const branch = await currentBranch(cwd)
    if (!branch) return this.replace(sessionId, 'worktree', null, 0)
    const known = [...this.git.mine, ...this.git.reviews].find((p) => p.repo === FE_REPO && p.branch === branch)
    const n = known?.number ?? (await fePrForBranch(branch))
    // The worktree signal keeps its first time, so a newer mention still wins over it.
    const prev = this.signals.get(sessionId)?.find((x) => x.kind === 'worktree' && x.number === n)
    this.replace(sessionId, 'worktree', n, prev?.at ?? Date.now())
  }

  private async isFrontend(cwd: string): Promise<boolean> {
    const hit = this.feRepo.get(cwd)
    if (hit !== undefined) return hit
    const url = (await gitOut(cwd, ['config', '--get', 'remote.origin.url']))?.trim() ?? ''
    const yes = /productiveio\/frontend(\.git)?$/.test(url)
    this.feRepo.set(cwd, yes)
    return yes
  }

  private add(sessionId: string, kind: SignalKind, n: number): void {
    const list = (this.signals.get(sessionId) ?? []).filter((s) => !(s.kind === kind && s.number === n))
    list.push({ kind, number: n, at: Date.now() })
    this.signals.set(sessionId, list.slice(-20))
    void this.recompute(sessionId)
  }

  private replace(sessionId: string, kind: SignalKind, n: number | null, at: number): void {
    const list = this.signals.get(sessionId) ?? []
    const cur = list.find((s) => s.kind === kind)
    if ((cur?.number ?? null) === n) return
    const next = list.filter((s) => s.kind !== kind)
    if (n !== null) next.push({ kind, number: n, at: at || Date.now() })
    this.signals.set(sessionId, next)
    void this.recompute(sessionId)
  }

  private async recompute(sessionId: string): Promise<void> {
    const best = pickFocus(this.signals.get(sessionId) ?? [])
    const known = best && [...this.git.mine, ...this.git.reviews].find((p) => p.repo === FE_REPO && p.number === best.number)
    const pr = !best ? null : known ? fromPoller(known) : await fePr(best.number)
    const cur = this.focus.get(sessionId)
    if ((cur?.number ?? null) === (pr?.number ?? null)) return
    if (pr) this.focus.set(sessionId, pr)
    else this.focus.delete(sessionId)
    this.changed()
  }
}
