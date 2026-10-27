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
  /** Missing in tasks cached before it was read. */
  assignedTo?: { id: string; name: string; avatarUrl: string | null } | null
  /** Open to-dos assigned to me on a task assigned to someone else: why it's in my list. */
  myTodos?: number
  /** Its Figma design: its own link, or the nearest ancestor's (`from` names that ancestor). */
  design?: Design | null
}

export interface Design {
  url: string
  /** The ancestor's title when inherited; null when the task has its own. */
  from: string | null
}

const FIGMA_URL = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/[^\s"'<>)\]]+/

/** A task's own Figma link: a custom field holding one (Productive's Figma field), else the first in its description. */
export function figmaOf(customFields: unknown, description: unknown): string | null {
  const values = customFields && typeof customFields === 'object' ? Object.values(customFields as Record<string, unknown>) : []
  for (const v of [...values, description]) {
    const m = typeof v === 'string' ? FIGMA_URL.exec(v.replaceAll('&amp;', '&')) : null
    if (m) return m[0]
  }
  return null
}

/** The file's name from a Figma URL: `…/design/<key>/Contacts?node-id=…` → "Contacts". */
export function figmaName(url: string): string {
  const seg = /figma\.com\/[a-z]+\/[^/]+\/([^/?#]+)/.exec(url)?.[1]
  return seg ? decodeURIComponent(seg).replaceAll('-', ' ') : 'Figma'
}

/**
 * Fills `design` from the nearest ancestor that has one. `nodes` covers the tasks and every ancestor
 * known (id → title, parent, own link); a task's own link always wins.
 */
export function inheritDesign<T extends Pick<Task, 'id' | 'parentId' | 'design'>>(tasks: T[], nodes: Map<string, { title: string; parentId: string | null; own: string | null }>): T[] {
  return tasks.map((t) => {
    if (t.design) return t
    let id = nodes.get(t.id)?.parentId ?? t.parentId
    for (let depth = 0; id && depth < 8; depth++) {
      const n = nodes.get(id)
      if (!n) break
      if (n.own) return { ...t, design: { url: n.own, from: n.title } }
      id = n.parentId
    }
    return t
  })
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
  /** PRs connected to sessions by hand (a link suggestion); missing in snapshots from before they existed. */
  sessionPrs?: SessionPrLink[]
  /** PRs unlinked from a session by hand: never shown for it again, whatever links them. */
  hiddenPrs?: { sessionId: string; url: string }[]
  /** Link suggestions waiting for an answer, oldest first. */
  suggestions?: Suggestion[]
}

export interface SessionPrLink {
  sessionId: string
  url: string
  /** "fe #30301" */
  label: string
  title: string
}

/** A connection Workbench noticed but won't make without you: a task id in a prompt, or a PR the session opened. */
export type Suggestion =
  | { id: string; sessionId: string; kind: 'task'; taskId: string; title: string; area: string; status: string; colorId: string | null }
  | {
      id: string
      sessionId: string
      kind: 'pr'
      url: string
      label: string
      title: string
      /** The task to connect it to: the session's own task, else one the PR names. */
      task: { id: string; title: string; fromPr: boolean } | null
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
  /** The status's bright colour (VIVID_COLORS). */
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
    else by.set(name, { name, color: statusVivid({ colorId: t.statusColorId }), category: t.statusCategory, count: 1, position: t.statusPosition ?? 0 })
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

/** Bare 7–9 digit numbers in a prompt that might be task ids; numbers inside URLs and paths don't count. */
export function idsInPrompt(text: string): string[] {
  const bare = text.replace(/\bhttps?:\/\/\S+/g, ' ').replace(/\S*[/\\]\S*/g, ' ')
  return [...new Set([...bare.matchAll(/(?:^|[^\w.#-])(\d{7,9})(?![\w.-]*\d)(?=[^\w]|$)/g)].map((m) => m[1]!))]
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
  /** Assignee's name; null when unassigned. Missing in details cached before it was read. */
  assignee?: string | null
  assigneeId?: string | null
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
  /** My Productive person id, so my to-dos can be told apart. */
  me: string
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

/**
 * Bright stand-ins for PRODUCTIVE_COLORS, same order, for status rails, labels and chips on the dark theme
 * (design: the "1b · Task status colours" board, option C). Productive's own pairs stay for tag-style badges.
 */
export const VIVID_COLORS = [
  '#E8D44D', // canary
  '#FF9A5C', // orange
  '#FF6FB5', // fuchsia
  '#8FE36B', // lime-green
  '#4FC3F7', // blue
  '#B18CFF', // electric
  '#E8628F', // burgundy
  '#6C8CFF', // celtic-blue
  '#3FD8C8', // turquoise
  '#9E9AAE', // concrete
  '#9BA3E8', // logan
  '#F5C04A', // yellow
  '#5AA8FF', // azure
  '#FF5C72', // red
  '#4FD69C', // green
  '#38D9E8', // cyan
  '#ECE8F2', // white
]

/** Index into the colour tables the way Productive picks a status colour: its color_id, else its id. */
function colorIndex(s: { id?: string; colorId: string | null }): number {
  const ok = s.colorId != null && Number(s.colorId) >= 0 && Number(s.colorId) < PRODUCTIVE_COLORS.length
  return ok ? Number(s.colorId) : (parseInt(s.id ?? '0') || 0) % PRODUCTIVE_COLORS.length
}

/** A status's [background, text] colours as Productive draws its tag. */
export function statusColors(s: { id?: string; colorId: string | null }): [string, string] {
  return PRODUCTIVE_COLORS[colorIndex(s)]!
}

/** A status's bright colour for rails, labels and chips. */
export function statusVivid(s: { id?: string; colorId: string | null }): string {
  return VIVID_COLORS[colorIndex(s)]!
}

/** How a line hangs in its group's tree: a line per ancestor level that goes on below it, its own joint, its child count. */
export interface TreeShape {
  /** Levels 1..depth-1: true where that ancestor's branch continues past this line. */
  through: boolean[]
  /** ├ when a sibling follows, └ when this is the last child; null at the top level. */
  joint: 'mid' | 'end' | null
  kids: number
}

/** Tree lines for a group's lines (as groupTasks orders them: each parent followed by its subtree). */
export function treeShapes(lines: { depth: number }[]): TreeShape[] {
  // Whether another line at `level` comes after i before the tree climbs above that level.
  const continues = (i: number, level: number) => {
    for (let j = i + 1; j < lines.length; j++) {
      const d = lines[j]!.depth
      if (d < level) return false
      if (d === level) return true
    }
    return false
  }
  return lines.map((l, i) => {
    let kids = 0
    for (let j = i + 1; j < lines.length && lines[j]!.depth > l.depth; j++) if (lines[j]!.depth === l.depth + 1) kids++
    return {
      through: Array.from({ length: Math.max(0, l.depth - 1) }, (_, k) => continues(i, k + 1)),
      joint: l.depth === 0 ? null : continues(i, l.depth) ? 'mid' : 'end',
      kids,
    }
  })
}
