import type { Task, TaskDetail, WorkflowStatus } from '@shared/tasks'
import type { Repo } from '../store/repo'
import { encodeParams, htmlText, Productive, type JsonApiResource } from './client'

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
    const { data, included } = await api.getOne(`/tasks/${taskId}`, ['include=project,task_list,workflow_status.workflow,parent_task,todos'])
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
      description: htmlText(String(data.attributes.description ?? '')),
      statusId: status?.id ?? '',
      statuses: (workflowId && this.statuses.get(workflowId)) || [],
      todos: included
        .filter((i) => i.type === 'todos')
        .sort((a, b) => Number(a.attributes.position ?? 0) - Number(b.attributes.position ?? 0))
        .map((t) => ({ id: t.id, text: String(t.attributes.description ?? ''), closed: !!t.attributes.closed })),
    }
  }

  async setStatus(taskId: string, statusId: string): Promise<void> {
    const { api } = await this.client()
    await api.patch(`/tasks/${taskId}`, { data: { type: 'tasks', id: taskId, relationships: { workflow_status: { data: { type: 'workflow_statuses', id: statusId } } } } })
    void this.refresh()
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
