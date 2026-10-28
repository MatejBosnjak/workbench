import type { Conversation, GitSnapshot, Pr } from '@shared/git'
import { changesPending, lastMessage, needsReply, prRepo, verb } from '@shared/git'
import type { Task, TasksSnapshot } from '@shared/tasks'
import { isoDay, type MyTodo } from '@shared/todos'
import { age, dueText } from '@shared/time'

export interface NeedItem {
  /** Changes when the item does (a new message, a new push, a new due date), so a snooze ends when something new happens. */
  key: string
  kind: 'changes requested' | 'reply needed' | 'ci failing' | 'conflicts' | 'overdue' | 'to-do'
  ref: string
  text: string
  /** Who, where it isn't in the text (the reviewer who asked for changes). */
  detail: string
  /** Since when it's been waiting: the push, the request, the message. Shown as an age. */
  at?: string
  /** A reply's last message, on one line. */
  quote?: string
  pr?: Pr
  conversation?: Conversation
  task?: Task
  todo?: MyTodo
}

/** A message on one line, without the lines it quotes ("> …") when it has words of its own. */
export function said(body: string): string {
  const own = body.split('\n').filter((l) => !/^\s*>/.test(l)).join(' ').replace(/\s+/g, ' ').trim()
  return own || body.replace(/\s+/g, ' ').trim()
}

/** Today › Needs you: my PRs with changes requested, red CI or conflicts, threads waiting on me, overdue tasks, my open to-dos. */
export function needsYou(git: GitSnapshot | null, tasks: TasksSnapshot | null, todos: MyTodo[] = []): NeedItem[] {
  const out: NeedItem[] = []
  for (const p of git?.mine ?? []) {
    if (p.draft) continue
    if (changesPending(p))
      out.push({ key: `cr:${p.changesRequestedBy?.id ?? p.id}`, kind: 'changes requested', ref: prRepo(p), text: p.title, detail: p.changesRequestedBy?.author ?? '', at: p.changesRequestedBy?.at, pr: p })
    if (p.ci === 'fail') out.push({ key: `ci:${p.id}:${p.headSha}`, kind: 'ci failing', ref: prRepo(p), text: p.title, detail: '', at: p.updatedAt, pr: p })
    if (p.conflict) out.push({ key: `cf:${p.id}:${p.headSha}`, kind: 'conflicts', ref: prRepo(p), text: p.title, detail: '', at: p.updatedAt, pr: p })
  }
  for (const p of git?.mine ?? []) {
    for (const c of p.conversations) {
      if (!git || !needsReply(c, git.viewer, git.seen)) continue
      const last = lastMessage(c)!
      if (last.state === 'CHANGES_REQUESTED') continue
      out.push({ key: `re:${c.key}:${last.id}`, kind: 'reply needed', ref: prRepo(p), text: `${last.author} ${verb(c)}${c.path ? ` ${c.path.split('/').pop()}` : ''}`, detail: '', at: last.at, quote: said(last.body), pr: p, conversation: c })
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  for (const t of tasks?.tasks ?? []) {
    if (t.context || !t.dueDate || t.dueDate >= today || t.statusCategory === 3) continue
    out.push({ key: `od:${t.id}:${t.dueDate}`, kind: 'overdue', ref: 'task', text: t.title, detail: '', task: t })
  }
  // Dated ones by day, then undated newest first.
  const open = todos.filter((t) => !t.doneAt).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9') || b.createdAt - a.createdAt)
  for (const t of open) out.push({ key: `td:${t.id}:${t.due ?? ''}`, kind: 'to-do', ref: t.sessionTitle ?? 'me', text: t.text, detail: '', todo: t })
  return out
}

/** "due today", "late · 2d", "Fri · in 2d", or how long ago it was added. */
export function todoDetail(t: MyTodo, now = new Date()): string {
  if (!t.due) return `added ${age(t.createdAt, now.getTime())}`
  return t.due === isoDay(now) ? 'due today' : dueText(t.due, now)
}

/** The row's when: an age for PRs and threads, the due day for tasks and to-dos. */
export function needWhen(n: NeedItem, now = new Date()): string {
  if (n.todo) return todoDetail(n.todo, now)
  if (n.task?.dueDate) return dueText(n.task.dueDate, now)
  return n.at ? age(n.at, now.getTime()) : ''
}

/** Late or due today: a to-do or an overdue task. */
const dueNow = (n: NeedItem, today: string) => (n.kind === 'overdue' ? true : !!n.todo?.due && n.todo.due <= today)

/**
 * The one row to start with, and why. What unblocks a merge or a person comes first: an approved PR held up only by
 * red CI or a conflict, then changes asked of me, then the reply that has waited longest, then what's due today,
 * then my other red PRs. Nothing that fits: the first row, without a reason.
 */
export function nextNeed(items: NeedItem[], now = new Date()): { key: string; why: string } | null {
  if (!items.length) return null
  const today = isoDay(now)
  const t = now.getTime()
  const blocked = items.find((n) => (n.kind === 'ci failing' || n.kind === 'conflicts') && n.pr?.reviewDecision === 'APPROVED')
  if (blocked) {
    const by = blocked.pr!.reviewers?.filter((r) => r.state === 'approved').map((r) => r.login).join(', ')
    return { key: blocked.key, why: `approved${by ? ` by ${by}` : ''}; only ${blocked.kind === 'ci failing' ? 'CI' : 'the conflict'} stands between it and merge` }
  }
  const changes = items.find((n) => n.kind === 'changes requested')
  if (changes) return { key: changes.key, why: `${changes.detail || 'a reviewer'} asked for changes${changes.at ? ` ${age(changes.at, t)} ago` : ''}` }
  const replies = items.filter((n) => n.kind === 'reply needed' && n.at).sort((a, b) => a.at!.localeCompare(b.at!))
  if (replies[0]) return { key: replies[0].key, why: `waiting on your reply for ${age(replies[0].at!, t)}` }
  const due = items.find((n) => dueNow(n, today))
  if (due) return { key: due.key, why: needWhen(due, now) }
  const red = items.find((n) => n.kind === 'ci failing' || n.kind === 'conflicts')
  if (red) return { key: red.key, why: red.kind === 'ci failing' ? 'CI is red' : 'it has conflicts with its base' }
  return { key: items[0]!.key, why: '' }
}

/** The rows with the next one moved to the top; the rest keep their order. */
export function withNext(items: NeedItem[], now = new Date()): { items: NeedItem[]; next: { key: string; why: string } | null } {
  const next = nextNeed(items, now)
  if (!next) return { items, next }
  const i = items.findIndex((n) => n.key === next.key)
  return { items: [items[i]!, ...items.slice(0, i), ...items.slice(i + 1)], next }
}

/** A to-do dated after today waits in Sleeping until its day. */
export const todoLater = (n: NeedItem, now = new Date()) => !!n.todo?.due && n.todo.due > isoDay(now)

/** "2 PRs · 1 thread · 1 task" */
export function needsBreakdown(items: NeedItem[]): string {
  const prs = new Set(items.filter((i) => i.pr && i.kind !== 'reply needed').map((i) => i.pr!.id)).size
  const threads = items.filter((i) => i.kind === 'reply needed').length
  const tasks = items.filter((i) => i.kind === 'overdue').length
  const todos = items.filter((i) => i.kind === 'to-do').length
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  return [prs && n(prs, 'PR', 'PRs'), threads && n(threads, 'thread', 'threads'), tasks && n(tasks, 'task', 'tasks'), todos && n(todos, 'to-do', 'to-dos')].filter(Boolean).join(' · ') || 'nothing waiting'
}

/** A snooze with no end: the item sleeps until it changes (its key does). */
export const UNTIL_CHANGED = 8.64e15

/** Snoozes end at 08:00 the next morning. */
export function tomorrowMorning(now = new Date()): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}
