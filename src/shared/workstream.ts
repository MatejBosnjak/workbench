// The task workstream screen: a milestone or parent task with its subtasks, and everything around them.
import type { Task } from './tasks'

export interface WsTask extends Task {
  depth: number
  assignee: string | null
  /** The assignee's Productive photo; missing in workstreams cached before it was read. */
  assigneeAvatar?: string | null
  mine: boolean
  closed: boolean
  createdAt: string | null
}

export interface WsPr {
  url: string
  /** owner/name */
  repo: string
  repoName: string
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  branch: string
  createdAt: string
  mergedAt: string | null
  closedAt: string | null
  /** Tasks of this workstream the PR refers to. */
  taskIds: string[]
}

export interface WsActivity {
  at: string
  taskId: string
  kind: 'created' | 'status'
  from?: string
  to?: string
}

export interface SessionMeta {
  lines: number
  startedAt: string | null
  endedAt: string | null
}

export interface Workstream {
  rootId: string
  /** Tree order: the root, then subtasks depth-first by placement. */
  tasks: WsTask[]
  prs: WsPr[]
  activity: WsActivity[]
  /** By session id, for sessions linked to tasks in the tree. */
  sessionMeta: Record<string, SessionMeta>
  /** Local worktree per task id, where one exists. */
  worktrees: Record<string, string>
  note: string
  fetchedAt: number | null
  loading: boolean
  error: string | null
}

/** The topmost ancestor of a task that's known locally (my tasks plus their context parents). */
export function rootOf(taskId: string, tasks: Pick<Task, 'id' | 'parentId'>[]): string {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  let id = taskId
  const seen = new Set<string>()
  while (!seen.has(id)) {
    seen.add(id)
    const parent = byId.get(id)?.parentId
    if (!parent || !byId.has(parent)) break
    id = parent
  }
  return id
}

/** Orders tasks as a tree from the root: children by placement, depth set. Tasks not under the root are dropped. */
export function treeOrder<T extends Omit<WsTask, 'depth'>>(rootId: string, tasks: T[]): (T & { depth: number })[] {
  const kids = new Map<string, T[]>()
  for (const t of tasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t])
  const out: (T & { depth: number })[] = []
  const walk = (t: T, depth: number) => {
    out.push({ ...t, depth })
    for (const k of (kids.get(t.id) ?? []).sort((a, b) => a.placement - b.placement)) walk(k, depth + 1)
  }
  const root = tasks.find((t) => t.id === rootId)
  if (root) walk(root, 0)
  return out
}

/** A task and everything below it. */
export function subtree(ws: Pick<Workstream, 'tasks'>, taskId: string): Set<string> {
  const ids = new Set([taskId])
  for (const t of ws.tasks) if (t.parentId && ids.has(t.parentId)) ids.add(t.id)
  return ids
}

export interface WsLink {
  sessionId: string
  taskId: string
  startedAt: number
}

export type TimelineItem =
  | { kind: 'session'; at: number; taskId: string; sessionId: string }
  | { kind: 'pr'; at: number; taskId: string; pr: WsPr; what: 'opened' | 'merged' | 'closed' }
  | { kind: 'task'; at: number; taskId: string; text: string; chip: 'TASK' | 'STATUS' }

/**
 * Sessions, PR events and task events in time order. Closed subtasks that aren't mine and have no
 * sessions or PRs are left out, so a large milestone doesn't drown the timeline in other people's history.
 */
export function timeline(ws: Pick<Workstream, 'rootId' | 'tasks' | 'prs' | 'activity'>, links: WsLink[]): TimelineItem[] {
  const byId = new Map(ws.tasks.map((t) => [t.id, t]))
  const withWork = new Set([...links.map((l) => l.taskId), ...ws.prs.flatMap((p) => p.taskIds)])
  const relevant = (id: string) => {
    const t = byId.get(id)
    return !!t && (id === ws.rootId || !t.closed || t.mine || withWork.has(id))
  }
  const items: TimelineItem[] = []
  // A session linked to several tasks of the stream shows once, under the deepest one.
  const bySession = new Map<string, WsLink>()
  for (const l of links) {
    if (!byId.has(l.taskId)) continue
    const cur = bySession.get(l.sessionId)
    if (!cur || byId.get(l.taskId)!.depth > byId.get(cur.taskId)!.depth) bySession.set(l.sessionId, l)
  }
  for (const l of bySession.values()) items.push({ kind: 'session', at: l.startedAt, taskId: l.taskId, sessionId: l.sessionId })
  for (const p of ws.prs) {
    const taskId = p.taskIds.find((id) => byId.has(id)) ?? ws.rootId
    items.push({ kind: 'pr', at: Date.parse(p.createdAt), taskId, pr: p, what: 'opened' })
    if (p.mergedAt) items.push({ kind: 'pr', at: Date.parse(p.mergedAt), taskId, pr: p, what: 'merged' })
    else if (p.closedAt) items.push({ kind: 'pr', at: Date.parse(p.closedAt), taskId, pr: p, what: 'closed' })
  }
  for (const a of ws.activity) {
    if (!relevant(a.taskId)) continue
    const t = byId.get(a.taskId)!
    if (a.kind === 'created') items.push({ kind: 'task', at: Date.parse(a.at), taskId: a.taskId, text: `${t.title} created`, chip: 'TASK' })
    else items.push({ kind: 'task', at: Date.parse(a.at), taskId: a.taskId, text: `${t.title}: ${a.from ?? '—'} → ${a.to ?? '—'}`, chip: 'STATUS' })
  }
  return items.sort((a, b) => a.at - b.at)
}

/** Lowercase ascii words for a branch or folder name. */
const STOP = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'for', 'and', 'to', 'from', 'with', 'u', 'i', 'za', 'na'])

export function slug(title: string, words = 6): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(fe|be|ai|pm|de|e|dev)\s*:\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .slice(0, words)
    .join('-')
}
