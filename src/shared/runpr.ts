// Run PR in app: which frontend PR a session is about, and the job that puts it in the `app` service.

export const FE_REPO = 'productiveio/frontend'

export interface FePr {
  number: number
  title: string
  url: string
  branch: string
  headSha: string
  /** From a fork: fetched as pull/<n>/head. */
  fork: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
}

/** Strongest first. */
export type SignalKind = 'worktree' | 'mention' | 'task' | 'gh'
const RANK: Record<SignalKind, number> = { worktree: 0, mention: 0, task: 1, gh: 1 }

export interface Signal {
  kind: SignalKind
  number: number
  at: number
}

/** The newest strong signal (worktree branch, a mention in a prompt or the output); task and gh commands only as fallback. */
export function pickFocus(signals: Signal[]): Signal | null {
  let best: Signal | null = null
  for (const s of signals) {
    if (!best || RANK[s.kind] < RANK[best.kind] || (RANK[s.kind] === RANK[best.kind] && s.at >= best.at)) best = s
  }
  return best
}

const PR_URL = /github\.com\/productiveio\/frontend\/pull\/(\d+)/g

/** Frontend PR numbers in a prompt: URLs, "fe #123", or a bare "#12345". */
export function prMentions(text: string): number[] {
  const out = [...text.matchAll(PR_URL)].map((m) => Number(m[1]))
  for (const m of text.matchAll(/(?:^|[\s(])(?:fe\s*)?#(\d{4,6})\b/gi)) out.push(Number(m[1]))
  return [...new Set(out)]
}

/** Frontend PR URLs in terminal output. */
export function prUrls(text: string): number[] {
  return [...new Set([...text.matchAll(PR_URL)].map((m) => Number(m[1])))]
}

/** `gh pr view|checkout|diff <n>` in a Bash command. */
export function ghPrCommand(command: string): number | null {
  const m = /\bgh\s+pr\s+(?:view|checkout|diff)\s+(?:[^\n|;&]*?\s)?#?(\d{3,6})\b/.exec(command)
  return m ? Number(m[1]) : null
}

export interface WorktreeCandidate {
  path: string
  branch: string | null
  /** e.g. origin/feature/x */
  upstream: string | null
  /** HEAD contains the PR head commit. */
  hasHead: boolean
}

/** A local worktree for the PR: by branch name, then upstream, then head commit. */
export function matchWorktree(pr: Pick<FePr, 'branch'>, wts: WorktreeCandidate[]): { path: string; by: 'branch' | 'upstream' | 'commit' } | null {
  const byBranch = wts.find((w) => w.branch === pr.branch)
  if (byBranch) return { path: byBranch.path, by: 'branch' }
  const byUpstream = wts.find((w) => w.upstream === `origin/${pr.branch}`)
  if (byUpstream) return { path: byUpstream.path, by: 'upstream' }
  const byCommit = wts.find((w) => w.hasHead)
  return byCommit ? { path: byCommit.path, by: 'commit' } : null
}

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface RunStep {
  id: string
  label: string
  detail: string | null
  state: StepState
  ms: number | null
}

export interface RunJob {
  id: number
  pr: Pick<FePr, 'number' | 'title' | 'url' | 'branch'>
  mode: 'worktree' | 'base'
  alongside: boolean
  path: string
  matchedBy: 'branch' | 'upstream' | 'commit' | null
  steps: RunStep[]
  /** Last lines of output. */
  log: string[]
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  /** Where the result is served. */
  url: string | null
}

/** What ↩ Back restores after a base-checkout run. */
export interface BackInfo {
  pr: number
  path: string
  /** Branch name, or a commit when it was detached. */
  previous: string
  detached: boolean
  stash: string | null
  /** Where `app` ran before the run. */
  appPath: string
}

export interface RunPrSnapshot {
  job: RunJob | null
  back: BackInfo | null
  app: { path: string; branch: string | null; running: boolean; port: number | null; url: string | null }
  /** The frontend PR `app` runs, when its branch belongs to one. */
  appPr: number | null
  /** Focus PR per session id. */
  focus: Record<string, FePr>
  /** Where each known PR would run, for row hints. */
  hints: Record<number, string>
}

export interface DirtyGuard {
  dirty: true
  path: string
  files: string[]
}
