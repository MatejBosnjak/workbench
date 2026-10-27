// Today › My git and My reviews: the PR model and the pure rules on top of it.

export type Ci = 'pass' | 'fail' | 'pending' | 'none'

/** Where a CI word links when the PR's checks name no Semaphore run. */
export const SEMAPHORE_URL = 'https://productive.semaphoreci.com/'

/** The Semaphore run behind a PR's checks: a failing one first, then one still running, then any; null when none is Semaphore's. */
export function semaphoreRun(checks: { state?: string | null; url?: string | null }[]): string | null {
  const runs = checks.filter((c) => c.url && /semaphoreci\.com\//.test(c.url))
  const pick = runs.find((c) => /FAIL|ERROR/i.test(c.state ?? '')) ?? runs.find((c) => /PENDING|EXPECTED/i.test(c.state ?? '')) ?? runs[0]
  return pick?.url ?? null
}

export interface GhMessage {
  id: string
  author: string
  at: string
  body: string
  url: string
  /** For review bodies: APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state?: string
  /** I reacted to it with an emoji, which counts as an answer. */
  reacted?: boolean
}

/** Something that can need a reply: a review thread, or the PR's own conversation (comments and review bodies). */
export interface Conversation {
  key: string
  kind: 'thread' | 'pr'
  /** The review thread's node id, or the PR's. */
  targetId: string
  path: string | null
  diffHunk: string | null
  /** Oldest first; bots left out. */
  messages: GhMessage[]
}

export interface Pr {
  id: string
  /** owner/name */
  repo: string
  repoName: string
  number: number
  title: string
  url: string
  author: string
  authorBot: boolean
  authorAvatar?: string
  draft: boolean
  reviewDecision: string | null
  ci: Ci
  /** The Semaphore run behind `ci`, when its checks name one. */
  ciUrl: string | null
  conflict: boolean
  branch: string
  headSha: string
  createdAt: string
  updatedAt: string
  /** 7–9 digit ids from the branch and Productive task URLs in the body; matched against my tasks later. */
  taskRefs: string[]
  /** Mine only. */
  conversations: Conversation[]
  /** Mine only: the latest review that requested changes. */
  changesRequestedBy: { id: string; author: string; at: string } | null
  /** Changes were requested, but I've pushed since or re-requested the review: waiting on the reviewer. */
  changesAddressed?: boolean
  /** Review list only: a review is requested from me (vs. one I already asked changes on). */
  requested?: boolean
  /** Who's asked to review and where each one stands, requested first; never me. */
  reviewers?: Reviewer[]
}

export interface Reviewer {
  login: string
  avatar: string
  /** waiting: requested (or re-requested after a review) and not answered yet. */
  state: 'waiting' | 'approved' | 'changes' | 'commented'
}

export interface Draft {
  id: number
  target: DraftTarget
  body: string
  status: 'drafting' | 'ready' | 'sending' | 'sent' | 'failed'
  error: string | null
  createdAt: number
}

export type DraftTarget =
  | { kind: 'gh-thread'; key: string; repo: string; number: number; threadId: string; path: string | null }
  | { kind: 'gh-pr'; key: string; repo: string; number: number }
  | { kind: 'productive'; key: string; taskId: string; title: string }

export interface GitSnapshot {
  viewer: string | null
  mine: Pr[]
  reviews: Pr[]
  fetchedAt: number | null
  error: string | null
  loading: boolean
  /** Conversation key → id of the last message marked seen. */
  seen: Record<string, string>
  drafts: Draft[]
}

export const isBot = (login: string, typename?: string) => typename === 'Bot' || login.endsWith('[bot]') || login === 'claude'

const SHORT: Record<string, string> = { frontend: 'fe', 'ai-agent': 'ai', 'e2e-tests': 'e2e' }
export const shortRepo = (name: string) => SHORT[name] ?? name

/** A GitHub PR URL, from a paste that may carry a tab (/files) or query: owner, repo, number, and the clean URL. */
export function parsePrUrl(text: string): { owner: string; repo: string; number: number; url: string } | null {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(text)
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null
}

/** "fe #30278": for tooltips, prompts and anything a machine reads. On screen a PR is its repo and title (prRepo). */
export const prRef = (p: Pick<Pr, 'repoName' | 'number'>) => `${shortRepo(p.repoName)} #${p.number}`
/** A PR's repo as it reads on screen ("fe", "api"), next to its title; numbers stay out of sight. */
export const prRepo = (p: Pick<Pr, 'repoName'>) => shortRepo(p.repoName)

export function lastMessage(c: Conversation): GhMessage | null {
  return c.messages.at(-1) ?? null
}

/** The last message isn't mine, I haven't reacted to it, and it hasn't been marked seen. */
export function needsReply(c: Conversation, viewer: string | null, seen: Record<string, string>): boolean {
  const last = lastMessage(c)
  return !!last && !!viewer && last.author !== viewer && !last.reacted && seen[c.key] !== last.id
}

/** "opened a thread on", "replied on", "requested changes" … for a conversation's last message. */
export function verb(c: Conversation): string {
  const last = lastMessage(c)
  if (c.kind === 'thread') return c.messages.length > 1 ? 'replied on' : 'opened a thread on'
  if (last?.state === 'CHANGES_REQUESTED') return 'requested changes'
  if (last?.state === 'APPROVED') return 'approved'
  return 'commented'
}

/** Changes requested and not yet answered with a push or a re-review request. */
export const changesPending = (p: Pick<Pr, 'reviewDecision' | 'changesAddressed'>) => p.reviewDecision === 'CHANGES_REQUESTED' && !p.changesAddressed

export type GroupTone = 'bad' | 'ok' | 'accent' | 'info' | 'faint'
export interface PrGroup {
  title: string
  tone: GroupTone
  prs: Pr[]
}

const byUpdated = (a: Pr, b: Pr) => b.updatedAt.localeCompare(a.updatedAt)


/** One of the four things between a PR and merging. */
export interface MergeCheck {
  key: 'ci' | 'reviews' | 'conflicts' | 'threads'
  state: 'ok' | 'bad' | 'wait'
  label: string
}

/** CI, reviews, conflicts and unresolved review threads, each ok / blocking / still pending. */
export function mergeChecks(p: Pr): MergeCheck[] {
  const threads = p.conversations.filter((c) => c.kind === 'thread').length
  const changes = p.reviewDecision === 'CHANGES_REQUESTED'
  return [
    // A repo without CI has nothing to wait for.
    { key: 'ci', state: p.ci === 'pass' || p.ci === 'none' ? 'ok' : p.ci === 'fail' ? 'bad' : 'wait', label: p.ci === 'none' ? 'no CI' : p.ci === 'pending' ? 'CI running' : 'CI' },
    {
      key: 'reviews',
      state: p.reviewDecision === 'APPROVED' || p.reviewDecision === null ? 'ok' : changesPending(p) ? 'bad' : 'wait',
      label: p.reviewDecision === 'APPROVED' ? 'approved' : changes ? (p.changesAddressed ? 'changes addressed' : 'changes requested') : p.reviewDecision === null ? 'no review needed' : 'review required',
    },
    { key: 'conflicts', state: p.conflict ? 'bad' : 'ok', label: p.conflict ? 'conflict' : 'no conflicts' },
    { key: 'threads', state: threads ? 'wait' : 'ok', label: threads ? `${threads} open thread${threads > 1 ? 's' : ''}` : 'threads resolved' },
  ]
}

export const mergeScore = (p: Pr) => mergeChecks(p).filter((c) => c.state === 'ok').length

/**
 * My PRs by stage, nearest to merge first: Ready to merge, In review, Changes requested, Draft. Inside a stage the
 * PRs with the most checks passing come first, then the most recently updated.
 */
export function groupByStage(prs: Pr[], by: 'progress' | 'opened' = 'progress'): PrGroup[] {
  const stage = (p: Pr) =>
    p.draft ? 'draft' : changesPending(p) ? 'changes' : p.reviewDecision === 'APPROVED' ? 'ready' : 'review'
  const order = (a: Pr, b: Pr) => (by === 'opened' ? b.createdAt.localeCompare(a.createdAt) : mergeScore(b) - mergeScore(a) || byUpdated(a, b))
  return [
    { title: 'Ready to merge', tone: 'ok' as const, prs: prs.filter((p) => stage(p) === 'ready') },
    { title: 'In review', tone: 'info' as const, prs: prs.filter((p) => stage(p) === 'review') },
    { title: 'Changes requested', tone: 'bad' as const, prs: prs.filter((p) => stage(p) === 'changes') },
    { title: 'Draft', tone: 'faint' as const, prs: prs.filter((p) => stage(p) === 'draft') },
  ]
    .map((g) => ({ ...g, prs: [...g.prs].sort(order) }))
    .filter((g) => g.prs.length)
}

export const ageDays = (iso: string, now = Date.now()) => Math.floor((now - new Date(iso).getTime()) / 86_400_000)

/**
 * Reviews waiting on me (requested from me, or re-requested after I asked for changes): New this week, then
 * Waiting longer, oldest first. PRs where I asked for changes and the author hasn't come back are listed apart.
 */
export function groupReviews(prs: Pr[], now = Date.now()): PrGroup[] {
  const waiting = prs.filter((p) => p.requested !== false)
  const oldestFirst = (a: Pr, b: Pr) => a.createdAt.localeCompare(b.createdAt)
  return [
    { title: 'New this week', tone: 'accent' as const, prs: waiting.filter((p) => ageDays(p.createdAt, now) < 7) },
    { title: 'Waiting longer', tone: 'faint' as const, prs: waiting.filter((p) => ageDays(p.createdAt, now) >= 7).sort(oldestFirst) },
  ].filter((g) => g.prs.length)
}

/** PRs where my latest review asked for changes and nothing's back for me yet: the author's move. Latest first. */
export const askedForChanges = (prs: Pr[]): Pr[] => prs.filter((p) => p.requested === false).sort(byUpdated)

export interface GitEvent {
  key: string
  title: string
  body: string
  /** What a click opens. */
  target: { tab: 'git' | 'reviews'; prId: string }
}

const excerpt = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Everything in the snapshot worth a notification, each with a stable key. The caller
 * remembers which keys it already announced, so this stays stateless.
 */
export function gitEvents(s: Pick<GitSnapshot, 'viewer' | 'mine' | 'reviews' | 'seen'>): GitEvent[] {
  const out: GitEvent[] = []
  for (const p of s.mine) {
    const at = { tab: 'git' as const, prId: p.id }
    for (const c of p.conversations) {
      if (!needsReply(c, s.viewer, s.seen)) continue
      const last = lastMessage(c)!
      // The changes-requested event below covers that review.
      if (last.state === 'CHANGES_REQUESTED') continue
      out.push({ key: `msg:${last.id}`, title: `${last.author} ${verb(c)}: ${p.title}`, body: excerpt(last.body || p.title), target: at })
    }
    if (p.changesRequestedBy && changesPending(p))
      out.push({ key: `cr:${p.changesRequestedBy.id}`, title: `Changes requested: ${p.title}`, body: p.changesRequestedBy.author, target: at })
    if (p.ci === 'fail' && !p.draft) out.push({ key: `ci:${p.id}:${p.headSha}`, title: `CI failed: ${p.title}`, body: prRepo(p), target: at })
  }
  for (const p of s.reviews) {
    if (p.requested && !p.authorBot) out.push({ key: `rr:${p.id}`, title: `Review requested: ${p.title}`, body: p.author, target: { tab: 'reviews', prId: p.id } })
  }
  return out
}
