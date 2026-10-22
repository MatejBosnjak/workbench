import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Pr } from '@shared/git'
import type { Task, TaskLink, TasksSnapshot } from '@shared/tasks'
import { taskIdsFromName, taskIdsFromText } from '@shared/tasks'
import { runHeadless } from './claude'
import { PR_URL } from './github'
import type { GitPoller } from './github/poller'
import { currentBranch, readWtrc } from './local/git'
import type { TasksPoller } from './productive/tasks'
import type { Sessions } from './sessions'
import type { HookPayload } from './signal-server'
import type { Repo } from './store/repo'

/** Prompts after this many are not scanned for task URLs: the first ones say what the session is for. */
const PROMPTS_SCANNED = 3
const SUMMARY_MODEL = 'haiku'

/** Session ↔ task links: explicit ones, and inference from strong signals only. */
export class Linker {
  private prompts = new Map<string, number>()
  private summarizing = new Set<string>()

  constructor(
    private repo: Repo,
    private tasks: TasksPoller,
    private git: GitPoller,
    private sessions: Sessions,
    private changed: () => void,
    private dataDir: string,
  ) {}

  snapshot(): TasksSnapshot {
    const sessions = new Map(this.sessions.list().map((s) => [s.id, s]))
    const links: TaskLink[] = this.repo.links().map((l) => ({
      ...l,
      session: l.session
        ? {
            title: l.session.title,
            state: l.session.state,
            alive: sessions.get(l.sessionId)?.alive ?? false,
            open: l.session.open,
            lastEventAt: l.session.lastEventAt,
            firstPrompt: l.session.firstPrompt,
          }
        : null,
    }))
    return {
      tasks: this.tasks.tasks,
      fetchedAt: this.tasks.fetchedAt,
      error: this.tasks.error,
      loading: this.tasks.loading,
      links,
      summaries: this.repo.summaries(),
    }
  }

  /** Called for every hook event applied to a Workbench tab. */
  async onHook(sessionId: string, event: string, p: HookPayload): Promise<void> {
    if (event === 'UserPromptSubmit' && p.prompt) {
      this.repo.notePrompt(sessionId, p.prompt)
      const n = (this.prompts.get(sessionId) ?? 0) + 1
      this.prompts.set(sessionId, n)
      if (n <= PROMPTS_SCANNED) for (const id of taskIdsFromText(p.prompt)) this.link(sessionId, id, 'task URL in prompt')
      for (const m of p.prompt.matchAll(new RegExp(PR_URL.source, 'g'))) {
        const pr = this.prs().find((x) => x.url === m[0])
        if (pr) this.linkPr(sessionId, pr)
      }
    }
    if (event === 'SessionStart') await this.inferFromPlace(sessionId, p.cwd)
  }

  /** Re-checks open sessions' cwd and branch, e.g. once the task list has loaded. */
  async inferAll(): Promise<void> {
    for (const s of this.sessions.list()) await this.inferFromPlace(s.id, s.cwd)
  }

  link(sessionId: string, taskId: string, via: string, by: 'auto' | 'manual' = 'auto'): void {
    if (this.repo.addLink(sessionId, taskId, via, by)) this.changed()
  }

  unlink(sessionId: string, taskId: string): void {
    this.repo.removeLink(sessionId, taskId)
    this.changed()
  }

  /** Where a session for this task should start: a worktree named after the task, if there is one. */
  worktreeFor(taskId: string): string | null {
    const hits: { path: string; mtime: number }[] = []
    for (const dir of readWtrc().worktreesDirs) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!taskIdsFromName(name, new Set([taskId])).length) continue
        const path = join(dir, name)
        hits.push({ path, mtime: statSync(path).mtimeMs })
      }
    }
    return hits.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
  }

  /** Summarizes the latest linked session's transcript tail with a headless claude. */
  async summarize(taskId: string): Promise<string> {
    const latest = this.repo
      .links()
      .filter((l) => l.taskId === taskId && l.session)
      .sort((a, b) => b.session!.lastEventAt - a.session!.lastEventAt)
      .find((l) => transcriptOf(l.session!.transcriptPath, l.session!.claudeId ?? l.sessionId))
    if (!latest) throw new Error('No linked session has a transcript yet')
    const sessionId = latest.sessionId
    if (this.summarizing.has(sessionId)) throw new Error('Already summarizing')
    this.summarizing.add(sessionId)
    try {
      const file = transcriptOf(latest.session!.transcriptPath, latest.session!.claudeId ?? sessionId)!
      const text = await runSummary(transcriptTail(readFileSync(file, 'utf8')), this.dataDir)
      this.repo.setSummary(sessionId, text, SUMMARY_MODEL)
      this.changed()
      return text
    } finally {
      this.summarizing.delete(sessionId)
    }
  }

  private async inferFromPlace(sessionId: string, cwd: string): Promise<void> {
    const known = new Set(this.tasks.tasks.map((t: Task) => t.id))
    if (!known.size) return
    for (const id of taskIdsFromName(cwd, known)) this.link(sessionId, id, 'task id in worktree')
    const branch = existsSync(cwd) ? await currentBranch(cwd) : null
    if (branch) for (const id of taskIdsFromName(branch, known)) this.link(sessionId, id, `task id in branch ${branch}`)
    // The session works on a PR's branch: the PR's tasks.
    if (branch) for (const pr of this.git.mine.filter((x) => x.branch === branch)) this.linkPr(sessionId, pr)
  }

  private prs(): Pr[] {
    return [...this.git.mine, ...this.git.reviews]
  }

  private linkPr(sessionId: string, pr: Pr): void {
    const known = new Set(this.tasks.tasks.map((t: Task) => t.id))
    for (const id of pr.taskRefs.filter((r) => known.has(r))) this.link(sessionId, id, `PR #${pr.number}`)
  }
}

function transcriptOf(path: string | null, claudeId: string): string | null {
  if (path && existsSync(path)) return path
  const root = join(process.env.HOME ?? '', '.claude', 'projects')
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, `${claudeId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // no projects dir
  }
  return null
}

interface Entry {
  type?: string
  message?: { role?: string; content?: string | { type: string; text?: string }[] }
}

/** The last user and assistant text turns of a transcript, newest kept, capped in size. */
export function transcriptTail(jsonl: string, maxChars = 24_000): string {
  const turns: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let e: Entry
    try {
      e = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const c = e.message?.content
    const text = typeof c === 'string' ? c : (c ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
    if (text.trim()) turns.push(`${e.type === 'user' ? 'User' : 'Claude'}: ${text.trim()}`)
  }
  let out = ''
  for (let i = turns.length - 1; i >= 0 && out.length < maxChars; i--) out = `${turns[i]}\n\n${out}`
  return out.slice(-maxChars)
}

function runSummary(tail: string, cwd: string): Promise<string> {
  const prompt = `Below is the end of a Claude Code session transcript. In 2–4 short sentences, say where the work left off: what was done, what is unfinished, and the obvious next step. No preamble.\n\n${tail}`
  return runHeadless(prompt, { model: SUMMARY_MODEL, cwd, timeoutMs: 120_000 })
}
