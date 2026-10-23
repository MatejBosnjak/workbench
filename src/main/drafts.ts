import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, DraftTarget, Pr } from '@shared/git'
import { runHeadless, type HeadlessOptions } from './claude'
import type { GitPoller } from './github/poller'
import type { Linker } from './linker'
import { listWorktrees, readWtrc } from './local/git'
import { commentHtml, htmlText, type JsonApiResource } from './productive/client'
import type { TasksPoller } from './productive/tasks'
import type { Repo } from './store/repo'

const DRAFT_MODEL = 'sonnet'
const READ_ONLY = ['Read', 'Grep', 'Glob']

export type Confirm = (message: string, detail: string) => Promise<boolean>

/**
 * Replies drafted in-app. Claude only ever writes the text. GitHub replies are filled into GitHub's own reply
 * box in the pane and posted with GitHub's button; Workbench never posts them. Productive comments are posted
 * by `send`, after a native confirm that shows the exact text and target.
 */
export class Drafts {
  constructor(
    private repo: Repo,
    private git: GitPoller,
    private tasks: TasksPoller,
    private linker: Linker,
    private confirm: Confirm,
    private changed: () => void,
    private dataDir: string,
  ) {}

  /** Targets with a claude run in flight; a second click waits for the first instead of starting another run. */
  private busy = new Set<string>()

  /** An empty draft to write by hand, or the unsent one already open for the same target. */
  open(target: DraftTarget): number {
    const existing = this.repo.drafts().find((d) => d.target.key === target.key && d.status !== 'sent')
    if (existing) return existing.id
    const id = this.repo.addDraft(target, '', 'ready')
    this.changed()
    return id
  }

  /** Asks Claude for a draft into the target's draft (created if needed). */
  async generate(target: DraftTarget, instruction: string): Promise<void> {
    if (this.busy.has(target.key)) return
    this.busy.add(target.key)
    const id = this.open(target)
    this.repo.updateDraft(id, { status: 'drafting', error: null })
    this.changed()
    try {
      const { prompt, cwd, tools } = target.kind === 'productive' ? await this.productivePrompt(target, instruction) : await this.githubPrompt(target, instruction)
      const body = await runHeadless(prompt, draftRun(cwd, tools))
      this.repo.updateDraft(id, { body, status: 'ready' })
    } catch (e) {
      this.repo.updateDraft(id, { status: 'ready', error: (e as Error).message })
    } finally {
      this.busy.delete(target.key)
    }
    this.changed()
  }

  /** Claude's text for a GitHub conversation, for the pane to fill into its reply box. */
  async compose(target: Extract<DraftTarget, { kind: 'gh-thread' | 'gh-pr' }>, instruction: string): Promise<string> {
    if (this.busy.has(target.key)) throw new Error('Already drafting this reply')
    this.busy.add(target.key)
    try {
      const { prompt, cwd, tools } = await this.githubPrompt(target, instruction)
      return await runHeadless(prompt, draftRun(cwd, tools))
    } finally {
      this.busy.delete(target.key)
    }
  }

  save(id: number, body: string): void {
    this.repo.updateDraft(id, { body })
  }

  discard(id: number): void {
    this.repo.deleteDraft(id)
    this.changed()
  }

  /** Posts the draft after the confirm. Returns false when cancelled. */
  async send(id: number, body: string): Promise<boolean> {
    const d = this.repo.draft(id)
    if (!d || !body.trim()) return false
    // GitHub replies go through GitHub's own Comment button in the pane.
    if (d.target.kind !== 'productive') throw new Error('GitHub replies are posted from the GitHub pane')
    this.repo.updateDraft(id, { body })
    if (!(await this.confirm('Post this Productive comment?', `To: ${describe(d.target)}\n\n${body.trim()}`))) return false
    this.repo.updateDraft(id, { status: 'sending', error: null })
    this.changed()
    try {
      await postComment(d.target, body.trim(), this.tasks)
      this.repo.updateDraft(id, { status: 'sent' })
    } catch (e) {
      this.repo.updateDraft(id, { status: 'failed', error: (e as Error).message })
    }
    this.changed()
    return true
  }

  private async githubPrompt(t: Extract<DraftTarget, { kind: 'gh-thread' | 'gh-pr' }>, instruction: string): Promise<{ prompt: string; cwd: string; tools: string[] }> {
    const pr = this.git.mine.find((p) => p.repo === t.repo && p.number === t.number)
    const c = pr?.conversations.find((x) => x.key === t.key)
    if (!pr || !c) throw new Error('That conversation is no longer in My git; refresh and try again')
    const checkout = await checkoutFor(pr)
    const prompt = [
      `Draft a reply for me (GitHub user ${this.git.viewer}) on my pull request ${pr.repo}#${pr.number} "${pr.title}" (branch ${pr.branch}).`,
      c.kind === 'thread' ? `It's a review thread on ${c.path}.${c.diffHunk ? `\n\nDiff hunk:\n${c.diffHunk}` : ''}` : `It's the PR's main conversation.`,
      `Conversation, oldest first:\n${transcript(c)}`,
      instruction.trim() ? `What I want to say: ${instruction.trim()}` : '',
      checkout.onBranch ? 'The current directory is a checkout of that branch; read the code if it helps you get facts right.' : '',
      'Write only the reply text, in the language the conversation uses, short and direct, in my voice. No preamble, no sign-off, no quoting the reviewer back.',
    ]
      .filter(Boolean)
      .join('\n\n')
    // Reading code only helps on the PR's own branch; elsewhere it's tokens spent on the wrong version.
    return { prompt, cwd: checkout.path ?? this.dataDir, tools: checkout.onBranch ? READ_ONLY : [] }
  }

  private async productivePrompt(t: Extract<DraftTarget, { kind: 'productive' }>, instruction: string): Promise<{ prompt: string; cwd: string; tools: string[] }> {
    const { api } = await this.tasks.client()
    const task = await api.getOne(`/tasks/${t.taskId}`)
    const comments = await api.getAll('/comments', [`filter%5Btask_id%5D=${t.taskId}`, 'sort=-created_at', 'include=creator'])
    const people = new Map(comments.included.filter((i) => i.type === 'people').map((p) => [p.id, `${p.attributes.first_name ?? ''} ${p.attributes.last_name ?? ''}`.trim()]))
    const recent = comments.data
      .slice(0, 8)
      .reverse()
      .map((c: JsonApiResource) => `${people.get(c.relationships?.creator?.data?.id ?? '') ?? 'Someone'} (${String(c.attributes.created_at).slice(0, 10)}): ${htmlText(String(c.attributes.body ?? ''))}`)
    const summary = this.linker.snapshot().summaries
    const linked = this.repo.links().filter((l) => l.taskId === t.taskId && summary[l.sessionId])
    const prompt = [
      `Draft a comment for me on my Productive task "${t.title}".`,
      `Task description:\n${htmlText(String(task.data.attributes.description ?? '')) || '(none)'}`,
      recent.length ? `Recent comments, oldest first:\n${recent.join('\n\n')}` : 'There are no comments yet.',
      linked.length ? `Where my latest Claude session left off: ${summary[linked.at(-1)!.sessionId]!.text}` : '',
      instruction.trim() ? `What I want to say: ${instruction.trim()}` : '',
      'Write only the comment text, in the language the task uses, short and concrete. Light Markdown only: **bold**, `code`, "- " lists. No headings, no preamble.',
    ]
      .filter(Boolean)
      .join('\n\n')
    // Everything it needs is in the prompt.
    return { prompt, cwd: this.linker.worktreeFor(t.taskId) ?? this.dataDir, tools: [] }
  }
}

/** Draft runs: a few turns of reading when it has tools, a plain writer's prompt when it has none. */
function draftRun(cwd: string, tools: string[]): HeadlessOptions {
  return tools.length
    ? { model: DRAFT_MODEL, cwd, tools, maxTurns: 6 }
    : { model: DRAFT_MODEL, cwd, tools, systemPrompt: 'You draft short replies in the user\'s voice. Output only the reply text.' }
}

export function describe(t: DraftTarget): string {
  if (t.kind === 'productive') return `Productive task "${t.title}" (comment)`
  if (t.kind === 'gh-thread') return `${t.repo}#${t.number}, review thread on ${t.path ?? 'a file'}`
  return `${t.repo}#${t.number}, PR conversation`
}

function transcript(c: Conversation): string {
  return c.messages.map((m) => `@${m.author} (${m.at.slice(0, 16).replace('T', ' ')})${m.state && m.state !== 'COMMENTED' ? ` [${m.state.toLowerCase().replace('_', ' ')}]` : ''}:\n${m.body.trim() || '(no text)'}`).join('\n\n')
}

/** The local worktree on the PR's branch, else the repo's main checkout. */
async function checkoutFor(pr: Pr): Promise<{ path: string | null; onBranch: boolean }> {
  const trees = await listWorktrees(pr.repoName)
  const hit = trees.find((w) => w.branch === pr.branch)
  if (hit) return { path: hit.path, onBranch: true }
  const root = readWtrc().reposDirs.map((d) => join(d, pr.repoName)).find((p) => existsSync(p))
  return { path: root ?? null, onBranch: false }
}

async function postComment(t: Extract<DraftTarget, { kind: 'productive' }>, body: string, tasks: TasksPoller): Promise<void> {
  const { api } = await tasks.client()
  await api.post('/comments', {
    data: { type: 'comments', attributes: { body: commentHtml(body) }, relationships: { task: { data: { type: 'tasks', id: t.taskId } } } },
  })
}
