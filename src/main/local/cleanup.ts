import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { classify, pickPr, reviewNumber, sortRows, type CleanupPr, type CleanupRow, type CleanupSnapshot, type WorktreeFacts } from '@shared/cleanup'
import { gh, graphql } from '../github/poller'
import { encodeParams, type Productive } from '../productive/client'
import { gitOut, readWtrc } from './git'

interface Deps {
  /** Productive client, for task status. */
  productive: () => Promise<{ api: Productive }>
  /** cwd and title of each open tab. */
  tabs: () => { cwd: string; title: string }[]
  /** cwd of each Local service. */
  services: () => { name: string; cwd: string }[]
}

const inside = (cwd: string, path: string) => cwd === path || cwd.startsWith(path + sep)

/** Runs `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k]!)
    }
  }))
  return out
}

function run(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => execFile('git', args, { cwd, timeout: 60_000 }, (err, _o, stderr) => done(err ? stderr.trim() || err.message : null)))
}

type Raw = Omit<WorktreeFacts, 'pr' | 'task' | 'tabs' | 'services' | 'inPr'> & { taskIds: string[] }

/** One linked worktree's git state; null for anything that isn't one (a base checkout, a plain folder). */
async function readWorktree(path: string): Promise<Raw | null> {
  if (!existsSync(join(path, '.git')) || !statSync(join(path, '.git')).isFile()) return null
  const common = (await gitOut(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim()
  if (!common) return null
  const root = dirname(common)
  const url = (await gitOut(root, ['config', '--get', 'remote.origin.url']))?.trim() ?? ''
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? ''
  const status = await gitOut(path, ['status', '--porcelain'], 60_000)
  if (status === null) return null
  const changes = status.split('\n').filter(Boolean)
  const head = (await gitOut(path, ['rev-parse', 'HEAD']))?.trim() ?? ''
  const branch = (await gitOut(path, ['branch', '--show-current']))?.trim() || null
  const ts = parseInt((await gitOut(path, ['log', '-1', '--format=%ct']))?.trim() ?? '0', 10) || 0
  const unpushed = parseInt((await gitOut(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']))?.trim() ?? '0', 10) || 0
  const name = path.split(sep).pop()!
  return {
    path,
    name,
    repo,
    root,
    branch,
    head,
    ts,
    changes: changes.slice(0, 20),
    moreChanges: changes.length > 20,
    unpushed,
    reviewOf: reviewNumber(name),
    taskIds: [...new Set([...`${name} ${branch ?? ''}`.matchAll(/(?:^|[^\d])(\d{7,9})(?=[^\d]|$)/g)].map((m) => m[1]!))],
  }
}

interface RawPr {
  number: number
  state: CleanupPr['state']
  url: string
  title: string
  headRefName: string
  headRefOid: string
  mergedAt: string | null
  closedAt: string | null
}
const toPr = (p: RawPr): CleanupPr => ({ ...p, endedAt: p.mergedAt || p.closedAt ? Date.parse((p.mergedAt ?? p.closedAt)!) : null })
const PR_FIELDS = 'number state url title headRefName headRefOid mergedAt closedAt'

/**
 * PRs for the worktrees: my PRs per repo (one `gh pr list` each), then a search by branch for branches not
 * among them (someone else's PR), and the review checkouts' PRs by number. Read-only.
 */
async function findPrs(raws: Raw[]): Promise<Map<string, CleanupPr>> {
  const out = new Map<string, CleanupPr>()
  const byRepo = new Map<string, Raw[]>()
  for (const r of raws) if (r.repo) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r])
  const mine = new Map<string, CleanupPr[]>()
  await pool([...byRepo.keys()], 4, async (repo) => {
    // A repo gh can't read (renamed, no access) just gets no PRs.
    const list = JSON.parse(await gh(['pr', 'list', '-R', repo, '--author', '@me', '--state', 'all', '--limit', '500', '--json', PR_FIELDS.replaceAll(' ', ',')]).catch(() => '[]')) as RawPr[]
    for (const p of list) mine.set(`${repo}#${p.headRefName}`, [...(mine.get(`${repo}#${p.headRefName}`) ?? []), toPr(p)])
  })
  const asks: { key: string; field: string }[] = []
  for (const r of raws) {
    if (r.reviewOf !== null) {
      const [owner, name] = r.repo.split('/')
      asks.push({ key: r.path, field: `repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${r.reviewOf}) { ${PR_FIELDS} } }` })
      continue
    }
    if (!r.branch) continue
    const hit = pickPr(mine.get(`${r.repo}#${r.branch}`) ?? [])
    if (hit) out.set(r.path, hit)
    else asks.push({ key: r.path, field: `search(query: ${JSON.stringify(`repo:${r.repo} is:pr head:${r.branch}`)}, type: ISSUE, first: 5) { nodes { ... on PullRequest { ${PR_FIELDS} } } }` })
  }
  for (let i = 0; i < asks.length; i += 25) {
    const chunk = asks.slice(i, i + 25)
    const data = await graphql<Record<string, { pullRequest?: RawPr | null; nodes?: RawPr[] }>>(`{ ${chunk.map((a, k) => `q${k}: ${a.field}`).join('\n')} }`).catch(() => ({}) as Record<string, never>)
    chunk.forEach((a, k) => {
      const d = data[`q${k}`]
      const raw = raws.find((r) => r.path === a.key)!
      const prs = d?.pullRequest ? [d.pullRequest] : (d?.nodes ?? []).filter((p) => p.headRefName === raw.branch)
      const hit = pickPr(prs.map(toPr))
      if (hit) out.set(a.key, hit)
    })
  }
  return out
}

/** Productive tasks by id: title and closed. Unknown ids are left out. */
async function findTasks(ids: string[], productive: Deps['productive']): Promise<Map<string, { id: string; title: string; closed: boolean }>> {
  const out = new Map<string, { id: string; title: string; closed: boolean }>()
  if (!ids.length) return out
  const { api } = await productive()
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await api.getAll('/tasks', encodeParams('filter', { id: ids.slice(i, i + 100).join(',') }))
    for (const t of data) out.set(t.id, { id: t.id, title: String(t.attributes.title ?? ''), closed: !!t.attributes.closed })
  }
  return out
}

/** Is `head` the PR's head or behind it? Only when git has the PR's commit locally. */
async function inPr(r: Raw, pr: CleanupPr | undefined): Promise<boolean> {
  if (!pr) return false
  if (pr.headRefOid === r.head) return true
  return (await gitOut(r.path, ['merge-base', '--is-ancestor', r.head, pr.headRefOid])) !== null
}

export class WorktreeCleanup {
  private snap: CleanupSnapshot = { rows: [], scannedAt: null, scanning: false, removing: null, failed: {}, error: null, disk: null }
  /** Sizes survive rescans; a worktree's size barely changes once it's done. */
  private sizes = new Map<string, number>()
  private measuring = false

  constructor(private deps: Deps, private changed: (s: CleanupSnapshot) => void) {}

  snapshot(): CleanupSnapshot {
    return this.snap
  }

  private set(patch: Partial<CleanupSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    this.changed(this.snap)
  }

  /** Every linked worktree under the .wtrc worktree folders, classified. */
  async scan(): Promise<void> {
    if (this.snap.scanning || this.snap.removing) return
    this.set({ scanning: true, error: null })
    try {
      const paths = readWtrc().worktreesDirs.filter(existsSync).flatMap((d) => readdirSync(d).map((n) => join(d, n)))
      const raws = (await pool(paths, 8, readWorktree)).filter((r): r is Raw => !!r)
      const [prs, tasks] = await Promise.all([findPrs(raws), findTasks([...new Set(raws.flatMap((r) => r.taskIds))], this.deps.productive).catch(() => new Map())])
      const tabs = this.deps.tabs()
      const services = this.deps.services()
      const now = Math.floor(Date.now() / 1000)
      const rows: CleanupRow[] = await pool(raws, 8, async ({ taskIds, ...r }) => {
        const pr = prs.get(r.path)
        const task = taskIds.map((id) => tasks.get(id)).find(Boolean) ?? null
        return classify(
          {
            ...r,
            pr: pr ?? null,
            task,
            inPr: await inPr({ ...r, taskIds }, pr),
            tabs: tabs.filter((t) => inside(t.cwd, r.path)).map((t) => t.title),
            services: services.filter((s) => inside(s.cwd, r.path)).map((s) => s.name),
          },
          now,
        )
      })
      this.set({ rows: sortRows(rows).map((r) => ({ ...r, bytes: this.sizes.get(r.path) ?? null })), scannedAt: Date.now(), scanning: false, failed: {}, disk: this.disk() })
      void this.measure()
    } catch (e) {
      this.set({ scanning: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Free and total bytes of the disk holding the first worktrees folder. */
  disk(): CleanupSnapshot['disk'] {
    const dir = readWtrc().worktreesDirs.find(existsSync)
    if (!dir) return null
    const s = statfsSync(dir)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  }

  checkDisk(): void {
    const d = this.disk()
    if (d && (!this.snap.disk || Math.abs(d.free - this.snap.disk.free) > 1e9)) this.set({ disk: d })
  }

  /** `du -sk` each worktree not measured yet, done ones first, a few at a time; slow (node_modules), so after the scan. */
  private async measure(): Promise<void> {
    if (this.measuring) return
    this.measuring = true
    try {
      const todo = this.snap.rows.filter((r) => r.bytes === null).map((r) => r.path)
      let n = 0
      await pool(todo, 3, async (path) => {
        const kb = await new Promise<number | null>((done) => execFile('du', ['-sk', path], { timeout: 300_000 }, (_err, out) => done(parseInt(out ?? '', 10) || null)))
        if (kb === null) return
        this.sizes.set(path, kb * 1024)
        // Batched: one renderer update per few worktrees.
        if (++n % 5 === 0 || n === todo.length) this.set({ rows: this.snap.rows.map((r) => ({ ...r, bytes: this.sizes.get(r.path) ?? r.bytes })) })
      })
      this.set({ rows: this.snap.rows.map((r) => ({ ...r, bytes: this.sizes.get(r.path) ?? r.bytes })) })
    } finally {
      this.measuring = false
    }
  }

  /**
   * `git worktree remove` each (with --force only when asked, for one the user confirmed with its changes listed),
   * `git branch -D` where the row says so, then `git worktree prune` once per repo. A failure stays in the list with git's message.
   */
  async remove(paths: string[], force = false): Promise<void> {
    const rows = this.snap.rows.filter((r) => paths.includes(r.path))
    if (!rows.length || this.snap.removing) return
    const failed: Record<string, string> = { ...this.snap.failed }
    const gone = new Set<string>()
    this.set({ removing: { done: 0, total: rows.length } })
    await pool(rows, 4, async (r) => {
      const err = await run(r.root, ['worktree', 'remove', ...(force ? ['--force'] : []), r.path])
      if (err) failed[r.path] = err
      else {
        gone.add(r.path)
        delete failed[r.path]
        if (r.deleteBranch && r.branch) await run(r.root, ['branch', '-D', r.branch])
      }
      this.set({ removing: { done: (this.snap.removing?.done ?? 0) + 1, total: rows.length }, rows: this.snap.rows.filter((x) => !gone.has(x.path)) })
    })
    for (const root of new Set(rows.map((r) => r.root))) await run(root, ['worktree', 'prune'])
    this.set({ removing: null, failed, disk: this.disk() })
  }
}
