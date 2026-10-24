import { shortRepo } from '@shared/git'
import { idsInPrompt, taskIdsFromText, type Suggestion, type Task } from '@shared/tasks'
import { PR_URL, prBasics } from './github'
import type { TasksPoller } from './productive/tasks'
import type { Repo } from './store/repo'

const PR_URLS = new RegExp(PR_URL.source, 'g')
/** A PR of mine this new counts as opened by the session that prints it (as does one printed in a turn that ran `gh pr create`). */
const RECENT_MS = 15 * 60_000

interface Deps {
  repo: Repo
  tasks: TasksPoller
  /** The session's linked tasks, latest first. */
  linkedTasks(sessionId: string): string[]
  /** My GitHub login, once the poller knows it. */
  viewer(): string | null
  changed(): void
}

const area = (t: Task) => `${t.projectName}${t.taskListName ? ` › ${t.taskListName}` : ''}`

/**
 * Link suggestions, by rule only (no model): a task id in a prompt, and a PR the session opened. Nothing is linked
 * until you answer; a "no" is remembered for that session.
 */
export class Suggester {
  private queue: Suggestion[] = []
  private n = 0
  /** Per session: when each PR URL was last printed. */
  private printed = new Map<string, Map<string, number>>()
  /** Per session: the current turn's start and the PR URLs its prompt pasted (those aren't new PRs). */
  private turn = new Map<string, { at: number; pasted: Set<string> }>()
  /** Per session: when it last ran `gh pr create`. */
  private ranCreate = new Map<string, number>()
  private basics = new Map<string, ReturnType<typeof prBasics>>()

  constructor(private d: Deps) {}

  /** Waiting suggestions; a task one drops out once that task is linked some other way. */
  list(): Suggestion[] {
    this.queue = this.queue.filter((s) => s.kind !== 'task' || !this.d.linkedTasks(s.sessionId).includes(s.taskId))
    return this.queue
  }

  take(id: string): Suggestion | undefined {
    const s = this.queue.find((x) => x.id === id)
    this.queue = this.queue.filter((x) => x.id !== id)
    return s
  }

  dismiss(id: string): void {
    const s = this.take(id)
    if (s) this.d.repo.dismissSuggestion(s.sessionId, s.kind === 'task' ? `task:${s.taskId}` : `pr:${s.url}`)
    this.d.changed()
  }

  onPrompt(sessionId: string, prompt: string): void {
    this.turn.set(sessionId, { at: Date.now(), pasted: new Set([...prompt.matchAll(PR_URLS)].map((m) => m[0])) })
    for (const id of idsInPrompt(prompt).slice(0, 3)) {
      if (this.d.linkedTasks(sessionId).includes(id) || this.d.repo.isDismissed(sessionId, `task:${id}`)) continue
      if (this.queue.some((s) => s.sessionId === sessionId && s.kind === 'task' && s.taskId === id)) continue
      void this.d.tasks.lookup(id).then((t) => {
        if (!t || this.d.linkedTasks(sessionId).includes(id) || this.queue.some((s) => s.sessionId === sessionId && s.kind === 'task' && s.taskId === id)) return
        this.queue.push({ id: `s${++this.n}`, sessionId, kind: 'task', taskId: id, title: t.title, area: area(t), status: t.statusName, colorId: t.statusColorId })
        this.d.changed()
      })
    }
  }

  /** A Bash command the session ran; `gh pr create` makes the URLs printed this turn candidates. */
  onCommand(sessionId: string, command: string): void {
    if (!/\bgh\s+pr\s+create\b/.test(command)) return
    this.ranCreate.set(sessionId, Date.now())
    const since = this.turn.get(sessionId)?.at ?? 0
    for (const [url, at] of this.printed.get(sessionId) ?? []) if (at >= since) void this.checkPr(sessionId, url)
  }

  /** Terminal output: PR URLs it prints. A new one is checked a moment later, once the command's hook has arrived. */
  onOutput(sessionId: string, data: string): void {
    if (!data.includes('/pull/')) return
    const printed = this.printed.get(sessionId) ?? new Map<string, number>()
    this.printed.set(sessionId, printed)
    for (const m of data.matchAll(PR_URLS)) {
      const fresh = !printed.has(m[0])
      printed.set(m[0], Date.now())
      if (fresh) setTimeout(() => void this.checkPr(sessionId, m[0]), 3000)
    }
  }

  private async checkPr(sessionId: string, url: string): Promise<void> {
    const turn = this.turn.get(sessionId)
    if (turn?.pasted.has(url)) return
    if (this.d.repo.isDismissed(sessionId, `pr:${url}`) || this.d.repo.sessionPrs().some((p) => p.sessionId === sessionId && p.url === url)) return
    if (!this.basics.has(url)) this.basics.set(url, prBasics(url))
    const pr = await this.basics.get(url)!
    if (!pr || this.queue.some((s) => s.kind === 'pr' && s.sessionId === sessionId && s.url === pr.url)) return
    const viewer = this.d.viewer()
    // Opened here: printed during a turn that ran `gh pr create`, or a PR of mine that's only minutes old.
    const since = turn?.at ?? 0
    const created = this.ranCreate.has(sessionId) && this.ranCreate.get(sessionId)! >= since && (this.printed.get(sessionId)?.get(url) ?? 0) >= since && Date.now() - since < RECENT_MS * 4
    const fresh = Date.now() - Date.parse(pr.createdAt) < RECENT_MS && (!viewer || pr.author === viewer)
    if (!created && !fresh) return

    let task: { id: string; title: string; fromPr: boolean } | null = null
    const own = this.d.linkedTasks(sessionId)[0]
    if (own) {
      const t = await this.d.tasks.lookup(own)
      task = { id: own, title: t?.title ?? `Task ${own}`, fromPr: false }
    } else {
      const named = [...new Set([...[...pr.branch.matchAll(/(?:^|\D)(\d{7,9})(?=\D|$)/g)].map((m) => m[1]!), ...taskIdsFromText(pr.body)])]
      for (const id of named) {
        const t = await this.d.tasks.lookup(id)
        if (t) {
          task = { id, title: t.title, fromPr: true }
          break
        }
      }
    }
    this.queue.push({ id: `s${++this.n}`, sessionId, kind: 'pr', url: pr.url, label: `${shortRepo(pr.repo.split('/')[1]!)} #${pr.number}`, title: pr.title, task })
    this.d.changed()
  }
}
