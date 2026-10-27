import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Pr } from '@shared/git'
import { taskIdsFromText } from '@shared/tasks'
import type { SessionMeta, WsActivity, WsPr, WsTask, Workstream } from '@shared/workstream'
import { treeOrder } from '@shared/workstream'
import type { GitPoller } from './github/poller'
import { graphql } from './github/poller'
import type { Linker } from './linker'
import { encodeParams, type JsonApiResource } from './productive/client'
import { taskMapper, type TasksPoller } from './productive/tasks'
import type { Repo } from './store/repo'

/** How deep below the root subtasks are loaded. */
const LEVELS = 3
const GH_ORG = 'productiveio'
/** A PR body mentioning more task ids than this is a release or rollup, not work on the task. */
const MAX_MENTIONS = 6

/** Loads workstreams on demand: Productive tree and history, GitHub PRs, transcript stats. Read-only. */
export class Workstreams {
  private cache = new Map<string, Workstream>()

  constructor(
    private repo: Repo,
    private tasks: TasksPoller,
    private git: GitPoller,
    private linker: Linker,
    private changed: (ws: Workstream) => void,
  ) {}

  /** The cached workstream right away; a fresh load follows through `changed`. */
  open(rootId: string): Workstream {
    const ws = this.cache.get(rootId) ?? empty(rootId, this.repo.note(rootId))
    if (!ws.loading && (!ws.fetchedAt || Date.now() - ws.fetchedAt > 60_000)) void this.refresh(rootId)
    return this.cache.get(rootId) ?? ws
  }

  async refresh(rootId: string): Promise<void> {
    const cur = this.cache.get(rootId) ?? empty(rootId, this.repo.note(rootId))
    if (cur.loading) return
    this.set({ ...cur, loading: true })
    try {
      const tasks = await this.loadTasks(rootId)
      const ids = tasks.map((t) => t.id)
      const [activity, prs] = await Promise.all([this.loadActivity(ids), this.loadPrs(ids)])
      const sessionMeta = await this.loadMeta(new Set(ids))
      const worktrees: Record<string, string> = {}
      for (const t of tasks) {
        const wt = this.linker.worktreeFor(t.id)
        if (wt) worktrees[t.id] = wt
      }
      this.set({ rootId, tasks, prs, activity, sessionMeta, worktrees, note: this.repo.note(rootId), fetchedAt: Date.now(), loading: false, error: null })
    } catch (e) {
      this.set({ ...(this.cache.get(rootId) ?? cur), loading: false, error: (e as Error).message })
    }
  }

  /** A task's Productive URL from any loaded workstream. */
  url(taskId: string): string | undefined {
    for (const ws of this.cache.values()) {
      const t = ws.tasks.find((x) => x.id === taskId)
      if (t) return t.url
    }
    return undefined
  }

  /** A task's title from any loaded workstream. */
  title(taskId: string): string | undefined {
    for (const ws of this.cache.values()) {
      const t = ws.tasks.find((x) => x.id === taskId)
      if (t) return t.title
    }
    return this.tasks.tasks.find((t) => t.id === taskId)?.title
  }

  setNote(rootId: string, body: string): void {
    this.repo.setNote(rootId, body)
    const ws = this.cache.get(rootId)
    if (ws) this.cache.set(rootId, { ...ws, note: body })
  }

  private set(ws: Workstream): void {
    this.cache.set(ws.rootId, ws)
    this.changed(ws)
  }

  private async loadTasks(rootId: string): Promise<WsTask[]> {
    const { api, personId, orgSlug } = await this.tasks.client()
    const include = 'include=project,task_list,workflow_status,assignee,parent_task'
    const root = await api.getOne(`/tasks/${rootId}`, [include])
    const all: { r: JsonApiResource; included: JsonApiResource[] }[] = [{ r: root.data, included: root.included }]
    let level = [rootId]
    for (let depth = 0; depth < LEVELS && level.length; depth++) {
      const next: string[] = []
      for (let i = 0; i < level.length; i += 50) {
        const { data, included } = await api.getAll('/tasks', [...encodeParams('filter', { parent_task_id: level.slice(i, i + 50) }), include])
        for (const r of data) all.push({ r, included })
        next.push(...data.filter((r) => Number(r.attributes.subtask_count ?? 1) > 0).map((r) => r.id))
      }
      level = next
    }
    const out = all.map(({ r, included }) => {
      const t = taskMapper(included, orgSlug)(r, false)
      const assignee = included.find((i) => i.type === 'people' && i.id === r.relationships?.assignee?.data?.id)
      return {
        ...t,
        assignee: assignee ? `${assignee.attributes.first_name ?? ''} ${assignee.attributes.last_name ?? ''}`.trim() : null,
        assigneeAvatar: (assignee?.attributes.avatar_url as string | null | undefined) ?? null,
        mine: r.relationships?.assignee?.data?.id === personId,
        closed: r.attributes.closed === true || t.statusCategory === 3,
        createdAt: (r.attributes.created_at as string) ?? null,
      }
    })
    const unique = [...new Map(out.map((t) => [t.id, t])).values()]
    return treeOrder(rootId, await this.tasks.withDesign(unique))
  }

  private async loadActivity(ids: string[]): Promise<WsActivity[]> {
    const { api } = await this.tasks.client()
    const out: WsActivity[] = []
    for (let i = 0; i < ids.length; i += 50) {
      const { data } = await api.getAll('/activities', encodeParams('filter', { task_id: ids.slice(i, i + 50), item_type: 'Task' }))
      for (const a of data) {
        const at = a.attributes.created_at as string
        const taskId = String(a.attributes.item_id ?? a.attributes.task_id)
        if (a.attributes.event === 'create') out.push({ at, taskId, kind: 'created' })
        const changes = (a.attributes.changeset as Record<string, [{ value?: string } | null, { value?: string } | null]>[] | null) ?? []
        for (const c of changes) {
          const st = c.workflow_status_id
          if (st && a.attributes.event === 'update') out.push({ at, taskId, kind: 'status', from: st[0]?.value, to: st[1]?.value })
        }
      }
    }
    return out
  }

  /** PRs in the org that mention any task of the stream, plus open ones the poller already linked by branch. */
  private async loadPrs(ids: string[]): Promise<WsPr[]> {
    const known = new Set(ids)
    const found = new Map<string, WsPr>()
    // GitHub search allows at most five OR operators per query.
    for (let i = 0; i < ids.length && i < 60; i += 6) {
      const q = `org:${GH_ORG} is:pr ${ids.slice(i, i + 6).join(' OR ')}`
      const r = await graphql<{ search: { nodes: RawSearchPr[] } }>(SEARCH, { q })
      for (const p of r.search.nodes) {
        if (!p.url) continue
        const mentioned = new Set([...taskIdsFromText(p.body ?? ''), ...[...`${p.title} ${p.body ?? ''}`.matchAll(/\b(\d{7,9})\b/g)].map((m) => m[1]!)])
        // Release and rollup PRs list many tasks; they aren't work on this one.
        if (mentioned.size > MAX_MENTIONS && !branchIds(p.headRefName).some((id) => known.has(id))) continue
        const refs = [...new Set([...branchIds(p.headRefName), ...mentioned])]
        const taskIds = refs.filter((id) => known.has(id))
        if (taskIds.length) found.set(p.url, fromSearch(p, taskIds))
      }
    }
    for (const p of [...this.git.mine, ...this.git.reviews] as Pr[]) {
      const taskIds = p.taskRefs.filter((id) => known.has(id))
      if (taskIds.length && !found.has(p.url))
        found.set(p.url, { url: p.url, repo: p.repo, repoName: p.repoName, number: p.number, title: p.title, state: 'OPEN', draft: p.draft, branch: p.branch, createdAt: p.createdAt, mergedAt: null, closedAt: null, taskIds })
    }
    return [...found.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private async loadMeta(ids: Set<string>): Promise<Record<string, SessionMeta>> {
    const out: Record<string, SessionMeta> = {}
    for (const l of this.repo.links()) {
      if (!ids.has(l.taskId) || !l.session || out[l.sessionId]) continue
      const file = this.linker.transcriptFor(l.sessionId)
      if (file) out[l.sessionId] = await transcriptMeta(file)
    }
    return out
  }
}

const empty = (rootId: string, note: string): Workstream => ({
  rootId,
  tasks: [],
  prs: [],
  activity: [],
  sessionMeta: {},
  worktrees: {},
  note,
  fetchedAt: null,
  loading: false,
  error: null,
})

const SEARCH = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
  url number title state isDraft createdAt mergedAt closedAt headRefName body repository { nameWithOwner name }
} } } }`

interface RawSearchPr {
  url: string
  number: number
  title: string
  state: WsPr['state']
  isDraft: boolean
  createdAt: string
  mergedAt: string | null
  closedAt: string | null
  headRefName: string
  body: string | null
  repository: { nameWithOwner: string; name: string }
}

const branchIds = (branch: string) => [...branch.matchAll(/(?:^|\D)(\d{7,9})(?=\D|$)/g)].map((m) => m[1]!)

const fromSearch = (p: RawSearchPr, taskIds: string[]): WsPr => ({
  url: p.url,
  repo: p.repository.nameWithOwner,
  repoName: p.repository.name,
  number: p.number,
  title: p.title,
  state: p.state,
  draft: p.isDraft,
  branch: p.headRefName,
  createdAt: p.createdAt,
  mergedAt: p.mergedAt,
  closedAt: p.closedAt,
  taskIds,
})

/** Line count and first/last timestamp of a transcript, read as a stream. */
export async function transcriptMeta(file: string): Promise<SessionMeta> {
  if (!existsSync(file)) return { lines: 0, startedAt: null, endedAt: null }
  let lines = 0
  let first: string | null = null
  let last: string | null = null
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    lines++
    const m = /"timestamp":"([^"]+)"/.exec(line)
    if (m) {
      first ??= m[1]!
      last = m[1]!
    }
  }
  return { lines, startedAt: first, endedAt: last }
}
