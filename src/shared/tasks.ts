export interface Task {
  id: string
  number: number | null
  title: string
  milestone: boolean
  projectId: string
  projectName: string
  taskListId: string | null
  taskListName: string | null
  parentId: string | null
  statusName: string
  /** 1 not started, 2 started, 3 closed. */
  statusCategory: number
  statusColorId: string | null
  /** The status's place in its workflow; missing in tasks cached before it was read. */
  statusPosition?: number
  dueDate: string | null
  lastActivityAt: string | null
  placement: number
  url: string
  /** Not assigned to me or filtered out; included only as a parent header. */
  context: boolean
}

export interface TaskLink {
  sessionId: string
  taskId: string
  via: string
  createdBy: 'auto' | 'manual'
  createdAt: number
  session: { title: string; state: string; alive: boolean; open: boolean; lastEventAt: number; firstPrompt: string | null } | null
}

export interface TasksSnapshot {
  tasks: Task[]
  fetchedAt: number | null
  error: string | null
  loading: boolean
  links: TaskLink[]
  /** By session id. */
  summaries: Record<string, { text: string; createdAt: number }>
}

// --- grouping (spec: Today › My tasks) ---

export interface TaskLine {
  task: Task
  depth: number
  /** A parent that's in the tree only for context: a milestone that isn't mine, or a parent hidden by the filter. */
  header?: 'milestone' | 'filtered'
  /** The task list, shown only when it differs from the parent's. */
  list: string | null
}

/** A status in the My tasks strip and its status grouping. */
export interface StatusCount {
  name: string
  /** Text colour as Productive draws the status. */
  color: string
  category: number
  count: number
}

/**
 * The statuses among my tasks, nearest-done first: started before not started, then later in the workflow first.
 * Statuses from different workflows that share a name count as one.
 */
export function statusCounts(tasks: Task[]): StatusCount[] {
  const by = new Map<string, StatusCount & { position: number }>()
  for (const t of tasks) {
    if (t.context) continue
    const name = t.statusName || 'No status'
    const e = by.get(name)
    if (e) e.count++
    else by.set(name, { name, color: statusColors({ colorId: t.statusColorId })[1], category: t.statusCategory, count: 1, position: t.statusPosition ?? 0 })
  }
  return [...by.values()]
    .sort((a, b) => b.category - a.category || b.position - a.position || a.name.localeCompare(b.name))
    .map(({ position: _, ...s }) => s)
}

/** My tasks as one group per status, in statusCounts order; rows are flat and keep their project order. */
export function groupByStatus(tasks: Task[]): ProjectGroup[] {
  const mine = tasks.filter((t) => !t.context)
  const order = new Map(groupTasks(tasks).flatMap((g) => g.lines.map((l) => l.task.id)).map((id, i) => [id, i]))
  return statusCounts(tasks).map((s) => {
    const lines = mine
      .filter((t) => (t.statusName || 'No status') === s.name)
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((task) => ({ task, depth: 0, list: null }))
    return { id: `status:${s.name}`, name: s.name, lines, count: lines.length }
  })
}

export interface ProjectGroup {
  id: string
  name: string
  lines: TaskLine[]
  /** Tasks of mine in the group (headers excluded). */
  count: number
}

const PROJECT_RANK = (name: string) => (/^bugs$/i.test(name) ? 0 : name === 'Product: CRM' ? 1 : 2)

/**
 * Groups tasks by project (Bugs first, then Product: CRM, then A–Z), ordered by placement,
 * with subtasks nested under their parent or milestone. Parents not in my list appear as
 * context headers.
 */
export function groupTasks(tasks: Task[]): ProjectGroup[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const children = new Map<string | null, Task[]>()
  for (const t of tasks) {
    const parent = t.parentId && byId.has(t.parentId) ? t.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), t])
  }
  const byPlacement = (a: Task, b: Task) => a.placement - b.placement || a.title.localeCompare(b.title)

  const projects = new Map<string, ProjectGroup>()
  const walk = (t: Task, depth: number, parent: Task | null) => {
    const g = projects.get(t.projectId) ?? { id: t.projectId, name: t.projectName, lines: [], count: 0 }
    projects.set(t.projectId, g)
    const kids = (children.get(t.id) ?? []).sort(byPlacement)
    // A context parent with no tasks of mine under it isn't worth a header.
    if (t.context && kids.length === 0) return
    g.lines.push({
      task: t,
      depth,
      header: t.context ? (t.milestone ? 'milestone' : 'filtered') : undefined,
      list: parent && parent.taskListId === t.taskListId ? null : t.taskListName,
    })
    if (!t.context) g.count++
    for (const k of kids) walk(k, depth + 1, t)
  }
  for (const t of (children.get(null) ?? []).sort(byPlacement)) walk(t, 0, null)

  return [...projects.values()]
    .filter((g) => g.count > 0)
    .sort((a, b) => PROJECT_RANK(a.name) - PROJECT_RANK(b.name) || a.name.localeCompare(b.name))
}

// --- link inference (spec: Session ↔ task linking, strong signals only) ---

const TASK_URL = /app\.productive\.io\/\d+-[\w-]+\/(?:go\/)?(?:projects\/\d+\/)?tasks?\/(?:task\/)?(\d+)/g

/** Task ids from Productive task URLs in a prompt. */
export function taskIdsFromText(text: string): string[] {
  return [...new Set([...text.matchAll(TASK_URL)].map((m) => m[1]!))]
}

/** Task ids in a path or branch name (`frontend-21071362-markup`, `feature/20794624-jira`), limited to known tasks. */
export function taskIdsFromName(name: string, known: Set<string>): string[] {
  return [...new Set([...name.matchAll(/(?:^|[^\d])(\d{7,9})(?=[^\d]|$)/g)].map((m) => m[1]!))].filter((id) => known.has(id))
}

// --- task detail (the Productive section of the task sidebar) ---

export interface WorkflowStatus {
  id: string
  name: string
  /** 1 not started, 2 started, 3 closed. */
  categoryId: number
  colorId: string | null
  position: number
}

export interface Todo {
  id: string
  text: string
  closed: boolean
}

export interface Person {
  id: string
  name: string
  avatarUrl: string | null
}

export interface TaskComment {
  id: string
  author: string
  at: string
  /** Plain text; a tag reads as @Name and its name is in `mentions`. */
  body: string
  mentions: string[]
}

export interface TaskDetail {
  task: Task
  /** Plain text; Productive stores HTML. */
  description: string
  statusId: string
  /** The task's workflow, in board order. */
  statuses: WorkflowStatus[]
  todos: Todo[]
  /** Oldest first. */
  comments: TaskComment[]
}

const MENTION = /@\[(\{[^\]]*?\})\]/g

/** Productive's stored text → plain text with @Name for each tag (and the tagged names); an attached file reads as its URL. */
export function readMentions(text: string): { body: string; mentions: string[] } {
  const mentions: string[] = []
  const body = text.replace(MENTION, (m, json: string) => {
    try {
      const t = JSON.parse(json) as { type?: string; label?: string; attachment_url?: string | null }
      if (t.type === 'attachment') return t.attachment_url ?? `[${t.label ?? 'file'}]`
      const label = String(t.label ?? '')
      mentions.push(label)
      return `@${label}`
    } catch {
      return m
    }
  })
  return { body, mentions }
}

/** The inline token Productive stores for a tag. */
export function mentionToken(p: Person): string {
  return `@[${JSON.stringify({ type: 'person', id: p.id, label: p.name, avatar_url: p.avatarUrl, attachment_url: null, is_done: false })}]`
}

/**
 * Productive's tag colours in dark mode, [background, text], indexed like its colorIndexToNameMap
 * (frontend: utils/custom-colors.ts, ui/components/tag.module.scss, ui/sass/colors).
 */
export const PRODUCTIVE_COLORS: [string, string][] = [
  ['#403a05', '#c6be75'], // canary
  ['#531c0a', '#d9b0a2'], // orange
  ['#66112d', '#d9a2b4'], // fuchsia
  ['#244005', '#a0c675'], // lime-green
  ['#0a3d53', '#a2c8d9'], // blue
  ['#3e1979', '#b7a2d9'], // electric
  ['#66113a', '#d9a2bd'], // burgundy
  ['#192979', '#a2abd9'], // celtic-blue
  ['#05403c', '#75c6c0'], // turquoise
  ['#363636', '#b3b3b3'], // concrete
  ['#2c3266', '#b4b7d9'], // logan
  ['#403505', '#c6b375'], // yellow
  ['#113466', '#a2b9d9'], // azure
  ['#530a0a', '#eaa8a8'], // red
  ['#0a5338', '#a2d9c5'], // green
  ['#0a4853', '#a2d1d9'], // cyan
  ['#e6e6e6', '#1f1f1f'], // white
]

/** A status's colours the way Productive picks them: its color_id, else its id. */
export function statusColors(s: { id?: string; colorId: string | null }): [string, string] {
  const ok = s.colorId != null && Number(s.colorId) >= 0 && Number(s.colorId) < PRODUCTIVE_COLORS.length
  const i = ok ? Number(s.colorId) : (parseInt(s.id ?? '0') || 0) % PRODUCTIVE_COLORS.length
  return PRODUCTIVE_COLORS[i]!
}
