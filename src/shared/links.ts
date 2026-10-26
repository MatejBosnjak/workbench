import { prRepo, type Ci, type GitSnapshot, type Pr } from './git'
import type { RunPrSnapshot } from './runpr'
import type { Task, TasksSnapshot } from './tasks'
import type { Session } from './types'

/**
 * How tasks, PRs and sessions point at each other, worked out the same way for every view: the task row, the task
 * peek, the session bar, the GitHub pane and the PR lists all read these.
 */

/** A session's mark: the tab's colour while it's open, ↺ once its tab is closed. */
export type Mark = 'running' | 'waiting' | 'failed' | 'idle' | 'closed'

export interface LinkedSession {
  id: string
  title: string
  firstPrompt: string | null
  mark: Mark
  /** Its tab is open (claude may have exited). */
  open: boolean
  at: number
  via: string
}

export const MARK_GLYPH: Record<Mark, string> = { running: '●', waiting: '●', failed: '●', idle: '○', closed: '↺' }
export const MARK_WORD: Record<Mark, string> = { running: 'running', waiting: 'waiting on you', failed: 'failed', idle: 'idle', closed: 'resume' }

/** Running or waiting in a live tab: the one ⏎ continue goes to first. */
export const isLive = (s: Pick<LinkedSession, 'mark'>): boolean => s.mark === 'running' || s.mark === 'waiting'

export function markOf(open: Pick<Session, 'alive' | 'state'> | undefined): Mark {
  if (!open) return 'closed'
  if (!open.alive) return 'idle'
  return open.state === 'running' || open.state === 'waiting' || open.state === 'failed' ? open.state : 'idle'
}

/** Live first, then the most recent. */
export const byLiveThenRecent = (a: LinkedSession, b: LinkedSession): number => Number(isLive(b)) - Number(isLive(a)) || b.at - a.at

/** The sessions linked to any of these tasks, one entry per session. */
export function sessionsOf(taskIds: Iterable<string>, tasks: TasksSnapshot | null, sessions: Session[]): LinkedSession[] {
  const ids = new Set(taskIds)
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const found = new Map<string, LinkedSession>()
  for (const l of tasks?.links ?? []) {
    if (!ids.has(l.taskId) || !l.session || found.has(l.sessionId)) continue
    const s = byId.get(l.sessionId)
    found.set(l.sessionId, {
      id: l.sessionId,
      title: s?.title ?? l.session.title,
      firstPrompt: l.session.firstPrompt,
      mark: markOf(s),
      open: !!s,
      at: s?.lastEventAt ?? l.session.lastEventAt,
      via: l.via,
    })
  }
  return [...found.values()].sort(byLiveThenRecent)
}

export const taskSessions = (taskId: string, tasks: TasksSnapshot | null, sessions: Session[]): LinkedSession[] => sessionsOf([taskId], tasks, sessions)

/** My tasks a PR names in its branch or description; parents shown only for context don't count. */
export function prTasks(pr: Pick<Pr, 'taskRefs'>, tasks: TasksSnapshot | null): Task[] {
  return (tasks?.tasks ?? []).filter((t) => !t.context && pr.taskRefs.includes(t.id))
}

/** The PRs, mine and to review, that name a task. */
export function taskPrs(taskId: string, git: GitSnapshot | null): Pr[] {
  return [...(git?.mine ?? []), ...(git?.reviews ?? [])].filter((p) => p.taskRefs.includes(taskId))
}

/** A session's tasks, latest link first. */
export function sessionTaskIds(tasks: TasksSnapshot | null, sessionId: string): string[] {
  return (tasks?.links ?? [])
    .filter((l) => l.sessionId === sessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => l.taskId)
}

/** The sessions on a PR: those linked to its tasks and those working on it (the frontend PR their branch is on). */
export function prSessions(pr: Pr | undefined, prUrl: string, tasks: TasksSnapshot | null, sessions: Session[], focus: Record<string, { url: string }>): LinkedSession[] {
  const out = pr ? sessionsOf(prTasks(pr, tasks).map((t) => t.id), tasks, sessions) : []
  const seen = new Set(out.map((s) => s.id))
  for (const s of sessions) {
    if (seen.has(s.id) || focus[s.id]?.url !== prUrl) continue
    out.push({ id: s.id, title: s.title, firstPrompt: null, mark: markOf(s), open: true, at: s.lastEventAt, via: 'works on this PR' })
  }
  return out.sort(byLiveThenRecent)
}

/** The session's PRs: ones connected to it by hand, the frontend PR its branch belongs to, and those linked to its tasks; not ones unlinked by hand. */
export function sessionPrs(sessionId: string, tasks: TasksSnapshot | null, git: GitSnapshot | null, runpr: RunPrSnapshot | null): SessionPr[] {
  const ids = new Set(sessionTaskIds(tasks, sessionId))
  const all = [...(git?.mine ?? []), ...(git?.reviews ?? [])]
  const out = new Map<string, SessionPr>()
  // Connected by hand (a link suggestion) first: the PR this session opened.
  for (const l of tasks?.sessionPrs ?? []) {
    if (l.sessionId !== sessionId) continue
    const p = all.find((x) => x.url === l.url)
    out.set(l.url, { url: l.url, label: l.label, title: p?.title ?? l.title, branch: p?.branch ?? '', ci: p?.ci ?? null })
  }
  const focus = runpr?.focus[sessionId]
  if (focus && !out.has(focus.url)) {
    const p = all.find((x) => x.url === focus.url)
    out.set(focus.url, { url: focus.url, label: 'fe', title: focus.title, branch: focus.branch, ci: p?.ci ?? null })
  }
  for (const p of all) if (p.taskRefs.some((t) => ids.has(t)) && !out.has(p.url)) out.set(p.url, { url: p.url, label: prRepo(p), title: p.title, branch: p.branch, ci: p.ci })
  for (const h of tasks?.hiddenPrs ?? []) if (h.sessionId === sessionId) out.delete(h.url)
  return [...out.values()]
}

export interface SessionPr {
  url: string
  label: string
  title: string
  branch: string
  ci: Ci | null
}
