import type { Conversation, GitSnapshot, Pr } from '@shared/git'
import { lastMessage, needsReply, prRef, verb } from '@shared/git'
import type { Task, TasksSnapshot } from '@shared/tasks'

export interface NeedItem {
  key: string
  kind: 'changes requested' | 'reply needed' | 'ci failing' | 'conflicts' | 'overdue'
  ref: string
  text: string
  detail: string
  pr?: Pr
  conversation?: Conversation
  task?: Task
}

const short = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return today ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/** Today › Needs you: my PRs with changes requested, red CI or conflicts, threads waiting on me, overdue tasks. */
export function needsYou(git: GitSnapshot | null, tasks: TasksSnapshot | null): NeedItem[] {
  const out: NeedItem[] = []
  for (const p of git?.mine ?? []) {
    if (p.draft) continue
    if (p.reviewDecision === 'CHANGES_REQUESTED')
      out.push({ key: `cr:${p.id}`, kind: 'changes requested', ref: prRef(p), text: p.title, detail: p.changesRequestedBy ? `${p.changesRequestedBy.author} · ${short(p.changesRequestedBy.at)}` : '', pr: p })
    if (p.ci === 'fail') out.push({ key: `ci:${p.id}`, kind: 'ci failing', ref: prRef(p), text: p.title, detail: p.branch, pr: p })
    if (p.conflict) out.push({ key: `cf:${p.id}`, kind: 'conflicts', ref: prRef(p), text: p.title, detail: p.branch, pr: p })
  }
  for (const p of git?.mine ?? []) {
    for (const c of p.conversations) {
      if (!git || !needsReply(c, git.viewer, git.seen)) continue
      const last = lastMessage(c)!
      if (last.state === 'CHANGES_REQUESTED') continue
      out.push({ key: `re:${c.key}`, kind: 'reply needed', ref: prRef(p), text: `${last.author} ${verb(c)}${c.path ? ` ${c.path.split('/').pop()}` : ''}`, detail: short(last.at), pr: p, conversation: c })
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  for (const t of tasks?.tasks ?? []) {
    if (t.context || !t.dueDate || t.dueDate >= today || t.statusCategory === 3) continue
    out.push({ key: `od:${t.id}`, kind: 'overdue', ref: `#${t.number ?? t.id}`, text: t.title, detail: `due ${new Date(`${t.dueDate}T12:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`, task: t })
  }
  return out
}

/** "2 PRs · 1 thread · 1 task" */
export function needsBreakdown(items: NeedItem[]): string {
  const prs = new Set(items.filter((i) => i.pr && i.kind !== 'reply needed').map((i) => i.pr!.id)).size
  const threads = items.filter((i) => i.kind === 'reply needed').length
  const tasks = items.filter((i) => i.kind === 'overdue').length
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  return [prs && n(prs, 'PR', 'PRs'), threads && n(threads, 'thread', 'threads'), tasks && n(tasks, 'task', 'tasks')].filter(Boolean).join(' · ') || 'nothing waiting'
}
