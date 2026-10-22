import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, Draft, DraftTarget, Pr } from '@shared/git'
import { runHeadless } from './claude'
import type { GitPoller } from './github/poller'
import { gh, graphql } from './github/poller'
import type { Linker } from './linker'
import { listWorktrees, readWtrc } from './local/git'
import { commentHtml, htmlText, type JsonApiResource } from './productive/client'
import type { TasksPoller } from './productive/tasks'
import type { Repo } from './store/repo'

const DRAFT_MODEL = 'sonnet'
const READ_ONLY = ['Read', 'Grep', 'Glob']

export type Confirm = (message: string, detail: string) => Promise<boolean>

/**
 * Replies drafted in-app. Claude only ever writes the text; posting happens in `send`, after a
 * native confirm that shows the exact text and target.
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
    const id = this.open(target)
    this.repo.updateDraft(id, { status: 'drafting', error: null })
    this.changed()
    try {
      const { prompt, cwd } = target.kind === 'productive' ? await this.productivePrompt(target, instruction) : await this.githubPrompt(target, instruction)
      const body = await runHeadless(prompt, { model: DRAFT_MODEL, cwd, tools: READ_ONLY })
      this.repo.updateDraft(id, { body, status: 'ready' })
    } catch (e) {
      this.repo.updateDraft(id, { status: 'ready', error: (e as Error).message })
    }
    this.changed()
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
    this.repo.updateDraft(id, { body })
    if (!(await this.confirm(`Post this ${d.target.kind === 'productive' ? 'Productive comment' : 'GitHub reply'}?`, `To: ${describe(d.target)}\n\n${body.trim()}`))) return false
    this.repo.updateDraft(id, { status: 'sending', error: null })
    this.changed()
    try {
      await post(d, body.trim(), this.tasks)
      this.repo.updateDraft(id, { status: 'sent' })
      if (d.target.kind !== 'productive') void this.git.refresh()
    } catch (e) {
      this.repo.updateDraft(id, { status: 'failed', error: (e as Error).message })
    }
    this.changed()
    return true
  }

  private async githubPrompt(t: Extract<DraftTarget, { kind: 'gh-thread' | 'gh-pr' }>, instruction: string): Promise<{ prompt: string; cwd: string }> {
    const pr = this.git.mine.find((p) => p.repo === t.repo && p.number === t.number)
    const c = pr?.conversations.find((x) => x.key === t.key)
    if (!pr || !c) throw new Error('That conversation is no longer in My git; refresh and try again')
    const checkout = await checkoutFor(pr)
    const prompt = [
      `Draft a reply for me (GitHub user ${this.git.viewer}) on my pull request ${pr.repo}#${pr.number} "${pr.title}" (branch ${pr.branch}).`,
      c.kind === 'thread' ? `It's a review thread on ${c.path}.${c.diffHunk ? `\n\nDiff hunk:\n${c.diffHunk}` : ''}` : `It's the PR's main conversation.`,
      `Conversation, oldest first:\n${transcript(c)}`,
      instruction.trim() ? `What I want to say: ${instruction.trim()}` : '',
      checkout.onBranch
        ? 'The current directory is a checkout of that branch; read the code if it helps you get facts right.'
        : 'The current directory may not be on that branch; only use it for general context.',
      'Write only the reply text, in the language the conversation uses, short and direct, in my voice. No preamble, no sign-off, no quoting the reviewer back.',
    ]
      .filter(Boolean)
      .join('\n\n')
    return { prompt, cwd: checkout.path ?? this.dataDir }
  }

  private async productivePrompt(t: Extract<DraftTarget, { kind: 'productive' }>, instruction: string): Promise<{ prompt: string; cwd: string }> {
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
    return { prompt, cwd: this.linker.worktreeFor(t.taskId) ?? this.dataDir }
  }
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

async function post(d: Draft, body: string, tasks: TasksPoller): Promise<void> {
  const t = d.target
  if (t.kind === 'gh-thread') {
    await graphql('mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }', {
      id: t.threadId,
      body,
    })
  } else if (t.kind === 'gh-pr') {
    await gh(['pr', 'comment', String(t.number), '--repo', t.repo, '--body-file', '-'], body)
  } else {
    const { api } = await tasks.client()
    await api.post('/comments', {
      data: { type: 'comments', attributes: { body: commentHtml(body) }, relationships: { task: { data: { type: 'tasks', id: t.taskId } } } },
    })
  }
}
