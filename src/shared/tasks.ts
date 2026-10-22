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
