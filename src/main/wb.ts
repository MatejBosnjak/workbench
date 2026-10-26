import { parsePrUrl, prRepo, type GitSnapshot, type Pr } from '@shared/git'
import { sessionPrs, sessionTaskIds } from '@shared/links'
import type { RunPrSnapshot } from '@shared/runpr'
import { taskIdsFromText, type Task, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'

/**
 * `wb`: what a session running inside Workbench can ask Workbench, and the links it can make. Answers are plain text
 * for Claude to read. Nothing here writes to GitHub or Productive; links live in Workbench only.
 */
export interface WbDeps {
  session(id: string): Session | undefined
  tasks(): TasksSnapshot
  git(): GitSnapshot
  runpr(): RunPrSnapshot | null
  branch(cwd: string): Promise<string | null>
  linkPr(sessionId: string, url: string): void
  unlinkPr(sessionId: string, url: string): void
  linkTask(sessionId: string, taskId: string): void
  unlinkTask(sessionId: string, taskId: string): void
}

export const WB_HELP = `wb: this Workbench session's task and PRs, and links between them (Workbench only; nothing is posted anywhere).
  wb status              this session: its task(s), PRs (CI, review, reviewers), cwd and branch
  wb tasks [filter]      my Productive tasks, with ids, for link-task
  wb prs [filter]        my open PRs and review requests, with URLs, for link-pr
  wb link-pr <url>       put a PR on this session (any GitHub PR URL)
  wb unlink-pr <url>     take a PR off this session
  wb link-task <id|url>  link one of my tasks to this session
  wb unlink-task <id>    unlink a task from this session`

const REVIEW: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }
const CI: Record<string, string> = { pass: 'CI passing', fail: 'CI failing', pending: 'CI running', none: 'no CI' }

const taskLine = (t: Task) => `${t.title}\n    id ${t.id} · ${t.statusName} · ${t.projectName}${t.taskListName ? ` › ${t.taskListName}` : ''}${t.dueDate ? ` · due ${t.dueDate}` : ''}\n    ${t.url}`

function prLine(p: Pr, mine: boolean): string {
  const state = [p.draft ? 'draft' : null, CI[p.ci], p.reviewDecision ? REVIEW[p.reviewDecision] ?? p.reviewDecision.toLowerCase() : null, p.conflict ? 'conflict' : null].filter(Boolean).join(' · ')
  const who = (p.reviewers ?? []).map((r) => `${r.login} ${r.state}`).join(', ')
  return `${prRepo(p)} #${p.number} ${p.title}\n    ${mine ? 'mine' : `by ${p.author}`} · ${state}${who ? ` · reviewers: ${who}` : ''} · branch ${p.branch}\n    ${p.url}`
}

const matches = (text: string, filter: string) => !filter || text.toLowerCase().includes(filter.toLowerCase())

export async function runWb(d: WbDeps, sessionId: string, name: string, args: string[]): Promise<string> {
  const s = d.session(sessionId)
  if (!s) return 'error: this tab is not a Workbench session'
  const snap = d.tasks()
  const git = d.git()
  const all = [...git.mine, ...git.reviews]
  const arg = args.join(' ')

  switch (name) {
    case 'help':
      return WB_HELP
    case 'status': {
      const ids = sessionTaskIds(snap, sessionId)
      const tasks = ids.map((id) => snap.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t)
      const prs = sessionPrs(sessionId, snap, git, d.runpr())
      const branch = await d.branch(s.cwd)
      const out = [`Workbench session "${s.title}" (tab ${s.id})`, `cwd ${s.cwd}${branch ? ` · branch ${branch}` : ''}`, '']
      out.push(tasks.length ? `task${tasks.length > 1 ? 's' : ''}:` : 'task: none linked (wb tasks, then wb link-task <id>)')
      for (const t of tasks) out.push(`  ${taskLine(t)}`)
      out.push('', prs.length ? 'PRs:' : 'PRs: none (wb prs, then wb link-pr <url>)')
      for (const p of prs) {
        const full = all.find((x) => x.url === p.url)
        out.push(`  ${full ? prLine(full, git.mine.includes(full)) : `${p.label} ${p.title}\n    ${p.url}`}`)
      }
      return out.join('\n')
    }
    case 'tasks': {
      const list = snap.tasks.filter((t) => !t.context && matches(`${t.title} ${t.projectName} ${t.id}`, arg))
      return list.length ? list.map(taskLine).join('\n') : 'no tasks match'
    }
    case 'prs': {
      const list = all.filter((p) => matches(`${prRepo(p)} ${p.title} ${p.number} ${p.branch}`, arg))
      return list.length ? list.map((p) => prLine(p, git.mine.includes(p))).join('\n') : 'no PRs match'
    }
    case 'link-pr':
    case 'unlink-pr': {
      const u = parsePrUrl(arg)
      if (!u) return `error: give a GitHub PR URL, like wb ${name} https://github.com/owner/repo/pull/123`
      if (name === 'link-pr') d.linkPr(sessionId, u.url)
      else d.unlinkPr(sessionId, u.url)
      return `${name === 'link-pr' ? 'linked' : 'unlinked'} ${u.url}`
    }
    case 'link-task':
    case 'unlink-task': {
      const id = /^\d{6,10}$/.test(arg) ? arg : taskIdsFromText(arg)[0]
      const t = id ? snap.tasks.find((x) => x.id === id) : undefined
      if (!id) return `error: give a task id or Productive task URL (wb tasks lists mine)`
      if (name === 'link-task') {
        if (!t) return `error: task ${id} is not one of my tasks (wb tasks lists them)`
        d.linkTask(sessionId, id)
        return `linked task ${id}: ${t.title}`
      }
      d.unlinkTask(sessionId, id)
      return `unlinked task ${id}${t ? `: ${t.title}` : ''}`
    }
    default:
      return `error: unknown command "${name}"\n${WB_HELP}`
  }
}
