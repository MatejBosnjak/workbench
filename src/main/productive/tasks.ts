import { mentionToken, readMentions, type Person, type Task, type TaskDetail, type WorkflowStatus } from '@shared/tasks'
import type { Repo } from '../store/repo'
import { commentHtml, encodeParams, htmlText, Productive, type JsonApiResource } from './client'

interface Account {
  orgId: string
  orgSlug: string
  personId: string
  /** The saved "List view" filter's params, captured once. */
  filter: Record<string, unknown>
}

const POLL_MS = 2 * 60_000

/** Polls my tasks with the saved List view filter. */
export class TasksPoller {
  private api = new Productive()
  private timer: NodeJS.Timeout | null = null
  tasks: Task[]
  fetchedAt: number | null
  error: string | null = null
  loading = false

  constructor(
    private repo: Repo,
    private changed: () => void,
  ) {
    // Last good result, so Today has something before the first fetch.
    const cached = repo.getSetting<{ tasks: Task[]; at: number } | null>('tasks:cache', null)
    this.tasks = cached?.tasks ?? []
    this.fetchedAt = cached?.at ?? null
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async refresh(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.changed()
    try {
      const account = await this.account()
      this.api.setOrg(account.orgId)
      const filter = JSON.parse(JSON.stringify(account.filter).replaceAll('{me}', account.personId)) as Record<string, unknown>
      const { data, included } = await this.api.getAll('/tasks', [
        ...encodeParams('filter', filter),
        'include=project,task_list,workflow_status,parent_task',
      ])
      this.tasks = normalize(data, included, account.orgSlug)
      this.fetchedAt = Date.now()
      this.error = null
      this.repo.setSetting('tasks:cache', { tasks: this.tasks, at: this.fetchedAt })
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      this.loading = false
      this.changed()
    }
  }

  /** The client with the org set, for callers outside the poll (drafts). */
  async client(): Promise<{ api: Productive; personId: string; orgSlug: string }> {
    const account = await this.account()
    this.api.setOrg(account.orgId)
    return { api: this.api, personId: account.personId, orgSlug: account.orgSlug }
  }

  /** By workflow id; statuses rarely change, so once per run is enough. */
  private statuses = new Map<string, WorkflowStatus[]>()

  async detail(taskId: string): Promise<TaskDetail> {
    const { api, orgSlug } = await this.client()
    const [{ data, included }, comments] = await Promise.all([
      api.getOne(`/tasks/${taskId}`, ['include=project,task_list,workflow_status.workflow,parent_task,todos,todos.assignee']),
      api.getAll('/comments', [`filter%5Btask_id%5D=${taskId}`, 'sort=created_at', 'include=creator']),
    ])
    const names = new Map(comments.included.filter((i) => i.type === 'people').map((p) => [p.id, personName(p)]))
    const status = included.find((i) => i.type === 'workflow_statuses')
    const workflowId = status?.relationships?.workflow?.data?.id
    if (workflowId && !this.statuses.has(workflowId)) {
      const all = await api.getAll('/workflow_statuses', encodeParams('filter', { workflow_id: workflowId }))
      this.statuses.set(
        workflowId,
        all.data
          .map((w) => ({ id: w.id, name: String(w.attributes.name ?? ''), categoryId: Number(w.attributes.category_id ?? 1), colorId: (w.attributes.color_id as string | null) ?? null, position: Number(w.attributes.position ?? 0) }))
          .sort((a, b) => a.position - b.position),
      )
    }
    return {
      task: taskMapper(included, orgSlug)(data, false),
      description: readMentions(htmlText(String(data.attributes.description ?? ''))).body,
      statusId: status?.id ?? '',
      statuses: (workflowId && this.statuses.get(workflowId)) || [],
      todos: included
        .filter((i) => i.type === 'todos')
        .sort((a, b) => Number(a.attributes.position ?? 0) - Number(b.attributes.position ?? 0))
        .map((t) => {
          const who = included.find((i) => i.type === 'people' && i.id === t.relationships?.assignee?.data?.id)
          return { id: t.id, text: readMentions(String(t.attributes.description ?? '')).body, closed: !!t.attributes.closed, assignee: who ? personName(who) : null }
        }),
      comments: comments.data
        .filter((c) => String(c.attributes.body ?? '').trim())
        .map((c) => ({
          id: c.id,
          author: names.get(c.relationships?.creator?.data?.id ?? '') ?? 'Someone',
          at: String(c.attributes.created_at ?? ''),
          ...readMentions(htmlText(String(c.attributes.body ?? ''))),
        })),
    }
  }

  private peopleCache: Person[] | null = null

  /** Active users in the org, for tagging; loaded once per run. */
  async people(): Promise<Person[]> {
    if (this.peopleCache) return this.peopleCache
    const { api } = await this.client()
    const { data } = await api.getAll('/people', encodeParams('filter', { status: 1, person_type: 1 }))
    this.peopleCache = data.map((p) => ({ id: p.id, name: personName(p), avatarUrl: (p.attributes.avatar_url as string | null) ?? null })).sort((a, b) => a.name.localeCompare(b.name))
    return this.peopleCache
  }

  /** Posts a comment; each tagged person's @Name becomes Productive's tag token, which notifies them. */
  async comment(taskId: string, text: string, tagged: Person[]): Promise<void> {
    const { api } = await this.client()
    let body = commentHtml(text)
    for (const p of tagged) body = body.replaceAll(`@${escapeHtml(p.name)}`, mentionToken(p))
    await api.post('/comments', { data: { type: 'comments', attributes: { body }, relationships: { task: { data: { type: 'tasks', id: taskId } } } } })
  }

  async setStatus(taskId: string, statusId: string): Promise<void> {
    const { api } = await this.client()
    await api.patch(`/tasks/${taskId}`, { data: { type: 'tasks', id: taskId, relationships: { workflow_status: { data: { type: 'workflow_statuses', id: statusId } } } } })
    void this.refresh()
  }

  /** Adds a to-do at the end of the task's list, optionally assigned. */
  async addTodo(taskId: string, text: string, assigneeId: string | null): Promise<void> {
    const { api } = await this.client()
    const relationships: Record<string, unknown> = { task: { data: { type: 'tasks', id: taskId } } }
    if (assigneeId) relationships.assignee = { data: { type: 'people', id: assigneeId } }
    await api.post('/todos', { data: { type: 'todos', attributes: { description: text }, relationships } })
  }

  async setTodo(todoId: string, closed: boolean): Promise<void> {
    const { api } = await this.client()
    await api.patch(`/todos/${todoId}`, { data: { type: 'todos', id: todoId, attributes: { closed } } })
  }

  /** Org, person and filter: discovered on first use and stored in settings. */
  private async account(): Promise<Account> {
    const stored = this.repo.getSetting<Account | null>('productive:account', null)
    if (stored) return stored
    const { data, included } = await this.api.getAll('/organization_memberships', ['include=organization'])
    const orgs = included.filter((i) => i.type === 'organizations')
    const org = orgs.find((o) => o.attributes.name === 'Productive') ?? orgs[0]
    const membership = data.find((m) => m.relationships?.organization?.data?.id === org?.id)
    if (!org || !membership) throw new Error('No Productive organization found for this token')
    const personId = membership.relationships?.person?.data?.id ?? membership.id
    this.api.setOrg(org.id)
    const filters = await this.api.getAll('/filters', encodeParams('filter', { creator_id: personId }))
    const listView = filters.data.find((f) => f.attributes.name === 'List view' && f.id.endsWith('-tasks'))
    const account: Account = {
      orgId: org.id,
      orgSlug: `${org.id}-${String(org.attributes.name ?? 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      personId,
      filter: (listView?.attributes.params as Record<string, unknown>) ?? { assignee_id: { eq: personId }, workflow_status_category_id: { eq: ['1', '2'] } },
    }
    this.repo.setSetting('productive:account', account)
    return account
  }
}

const personName = (p: JsonApiResource) => `${String(p.attributes.first_name ?? '').trim()} ${String(p.attributes.last_name ?? '').trim()}`.trim()
const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Maps a JSON:API task (with its included project, list and status) to a Task. */
export function taskMapper(included: JsonApiResource[], orgSlug: string): (t: JsonApiResource, context: boolean) => Task {
  const inc = new Map(included.map((i) => [`${i.type}:${i.id}`, i]))
  const rel = (r: JsonApiResource, name: string) => r.relationships?.[name]?.data ?? null
  const attr = <T>(r: JsonApiResource | undefined, k: string) => r?.attributes[k] as T | undefined
  return (t, context) => {
    const project = inc.get(`projects:${rel(t, 'project')?.id}`)
    const list = inc.get(`task_lists:${rel(t, 'task_list')?.id}`)
    const status = inc.get(`workflow_statuses:${rel(t, 'workflow_status')?.id}`)
    return {
      id: t.id,
      number: attr<number>(t, 'task_number') ?? null,
      title: attr<string>(t, 'title') ?? '(untitled)',
      milestone: attr<number>(t, 'type_id') === 3,
      projectId: rel(t, 'project')?.id ?? 'none',
      projectName: attr<string>(project, 'name') ?? 'No project',
      taskListId: rel(t, 'task_list')?.id ?? null,
      taskListName: attr<string>(list, 'name') ?? null,
      parentId: rel(t, 'parent_task')?.id ?? null,
      statusName: attr<string>(status, 'name') ?? '',
      statusCategory: attr<number>(status, 'category_id') ?? 1,
      statusColorId: attr<string>(status, 'color_id') ?? null,
      statusPosition: attr<number>(status, 'position') ?? 0,
      dueDate: attr<string>(t, 'due_date') ?? null,
      lastActivityAt: attr<string>(t, 'last_activity_at') ?? null,
      placement: attr<number>(t, 'placement') ?? 0,
      url: `https://app.productive.io/${orgSlug}/tasks/${t.id}`,
      context,
    }
  }
}

export function normalize(data: JsonApiResource[], included: JsonApiResource[], orgSlug: string): Task[] {
  const toTask = taskMapper(included, orgSlug)
  const mine = data.map((t) => toTask(t, false))
  const ids = new Set(mine.map((t) => t.id))
  // Parents outside the filter come back as included tasks; keep them as context headers.
  // Their own relationships aren't loaded, so they take project and list from a child.
  const parents = included
    .filter((i) => i.type === 'tasks' && !ids.has(i.id))
    .map((t) => {
      const parent = toTask(t, true)
      const child = mine.find((c) => c.parentId === parent.id)
      return child ? { ...parent, projectId: child.projectId, projectName: child.projectName, taskListId: child.taskListId, taskListName: child.taskListName } : parent
    })
  return [...mine, ...parents]
}
