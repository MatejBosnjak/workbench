/** Worktree cleanup (Local › Worktrees): what each linked worktree under the .wtrc folders is, and whether it can go. */

export type Verdict = 'done' | 'maybe' | 'keep'

export interface CleanupPr {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  url: string
  title: string
  headRefName: string
  headRefOid: string
  /** Merge or close time, ms; null while open. */
  endedAt: number | null
}

/** What the scan finds out about one worktree, before any verdict. */
export interface WorktreeFacts {
  path: string
  /** Folder name, e.g. frontend-20836223-service-discount-null-feed. */
  name: string
  /** owner/name from origin, e.g. productiveio/frontend. */
  repo: string
  /** The main checkout it belongs to. */
  root: string
  branch: string | null
  head: string
  /** Last commit, unix seconds. */
  ts: number
  /** `git status --porcelain` lines (tracked and untracked), at most 20. */
  changes: string[]
  /** More than the 20 listed. */
  moreChanges: boolean
  /** Commits on HEAD that no origin ref has. */
  unpushed: number
  /** HEAD is the PR's head commit or an ancestor of it (so the PR has everything, even when origin's branch is gone). */
  inPr: boolean
  /** The PR number a `review-N` / `prN-review` folder was made for. */
  reviewOf: number | null
  pr: CleanupPr | null
  task: { id: string; title: string; closed: boolean } | null
  /** Open Workbench tabs whose cwd is inside it. */
  tabs: string[]
  /** Local services pointed at it. */
  services: string[]
}

export interface CleanupRow extends WorktreeFacts {
  verdict: Verdict
  /** Why, in a few words; the row's tooltip. */
  reason: string
  /** Removing it also deletes the local branch (merged PR, everything in it). */
  deleteBranch: boolean
  /** Disk use in bytes (`du`, node_modules and all); null until measured, after the scan. */
  bytes: number | null
}

export interface CleanupSnapshot {
  rows: CleanupRow[]
  /** ms; null before the first scan. */
  scannedAt: number | null
  scanning: boolean
  /** Removal in progress: done of total. */
  removing: { done: number; total: number; freed: number; paths: string[] } | null
  /** The last removal, for the line after it ends. */
  removed: { n: number; freed: number } | null
  /** Folder → git's message for removals that failed. */
  failed: Record<string, string>
  error: string | null
  /** The disk the worktrees are on. */
  disk: { free: number; total: number } | null
}

/** Nearly full: under 10% or 30 GB free. */
export const diskLow = (d: { free: number; total: number } | null): boolean => !!d && (d.free < 30e9 || d.free / d.total < 0.1)

export function gb(bytes: number): string {
  return bytes >= 10e9 ? `${Math.round(bytes / 1e9)} GB` : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

const STALE_S = 28 * 24 * 3600

/** The PR number in a review checkout's folder name: `frontend-review-29043`, `review-28481`, `frontend-pr29469-review`. */
export function reviewNumber(name: string): number | null {
  const m = /(?:^|-)review-(\d+)$/.exec(name) ?? /(?:^|-)pr(\d+)-review$/.exec(name)
  return m ? parseInt(m[1]!, 10) : null
}

/** The PR for a branch when there are several: an open one, else the latest merged, else the latest closed. */
export function pickPr(prs: CleanupPr[]): CleanupPr | null {
  const rank = (p: CleanupPr) => (p.state === 'OPEN' ? 2 : p.state === 'MERGED' ? 1 : 0)
  return [...prs].sort((a, b) => rank(b) - rank(a) || (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.number - a.number)[0] ?? null
}

/** Checked top to bottom; the first match wins. `now` in unix seconds. */
export function classify(f: WorktreeFacts, now: number): CleanupRow {
  const row = (verdict: Verdict, reason: string, deleteBranch = false): CleanupRow => ({ ...f, verdict, reason, deleteBranch, bytes: null })
  if (f.tabs.length) return row('keep', `open in ${f.tabs.length === 1 ? 'a tab' : `${f.tabs.length} tabs`}: ${f.tabs.join(', ')}`)
  if (f.services.length) return row('keep', `${f.services.join(', ')} runs from it`)
  if (f.changes.length) return row('keep', `${f.moreChanges ? '20+' : f.changes.length} uncommitted change${f.changes.length === 1 ? '' : 's'}`)
  const pr = f.pr
  if (pr?.state === 'OPEN') return row('keep', `PR #${pr.number} is open`)
  // A detached checkout has no branch to keep its own commits.
  if (!f.branch && f.unpushed && !f.inPr) return row('keep', `detached, ${f.unpushed} commit${f.unpushed === 1 ? '' : 's'} on no branch`)
  if (f.reviewOf !== null && pr) return row('done', `reviewed PR #${pr.number} is ${pr.state === 'MERGED' ? 'merged' : 'closed'}`)
  if (pr?.state === 'MERGED') {
    if (f.inPr || !f.unpushed) return row('done', `PR #${pr.number} merged`, !!f.branch)
    return row('maybe', `PR #${pr.number} merged, but ${f.unpushed} local commit${f.unpushed === 1 ? '' : 's'} not in it (branch kept)`)
  }
  if (pr?.state === 'CLOSED') return row('maybe', `PR #${pr.number} closed without merging (branch kept)`)
  if (f.task && !f.task.closed) return row('keep', `task open: ${f.task.title}`)
  if (f.task?.closed) return row('maybe', `no PR; task closed (branch kept)`)
  if (now - f.ts > STALE_S) return row('maybe', `no PR; no commit for ${Math.floor((now - f.ts) / 86400 / 7)} weeks (branch kept)`)
  return row('keep', 'no PR yet; recent commits')
}

/** Oldest first inside a verdict: those have waited longest. */
export function sortRows(rows: CleanupRow[]): CleanupRow[] {
  const order: Record<Verdict, number> = { done: 0, maybe: 1, keep: 2 }
  return [...rows].sort((a, b) => order[a.verdict] - order[b.verdict] || a.ts - b.ts)
}
