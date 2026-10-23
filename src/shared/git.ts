// Today › My git and My reviews: the PR model and the pure rules on top of it.

export type Ci = 'pass' | 'fail' | 'pending' | 'none'

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
  draft: boolean
  reviewDecision: string | null
  ci: Ci
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
export const prRef = (p: Pick<Pr, 'repoName' | 'number'>) => `${shortRepo(p.repoName)} #${p.number}`

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

export function prNeedsYou(p: Pr, viewer: string | null, seen: Record<string, string>): boolean {
  return !p.draft && (changesPending(p) || p.ci === 'fail' || p.conflict || p.conversations.some((c) => needsReply(c, viewer, seen)))
}

export type GroupTone = 'bad' | 'ok' | 'accent' | 'faint'
export interface PrGroup {
  title: string
  tone: GroupTone
  prs: Pr[]
}

const byUpdated = (a: Pr, b: Pr) => b.updatedAt.localeCompare(a.updatedAt)

/** My git: Needs you, Ready to merge, Waiting on reviewers, Drafts. */
export function groupMine(prs: Pr[], viewer: string | null, seen: Record<string, string>): PrGroup[] {
  const needs = (p: Pr) => prNeedsYou(p, viewer, seen)
  return [
    { title: 'Needs you', tone: 'bad' as const, prs: prs.filter(needs) },
    { title: 'Ready to merge', tone: 'ok' as const, prs: prs.filter((p) => !needs(p) && !p.draft && p.reviewDecision === 'APPROVED') },
    { title: 'Waiting on reviewers', tone: 'accent' as const, prs: prs.filter((p) => !needs(p) && !p.draft && p.reviewDecision !== 'APPROVED') },
    { title: 'Drafts', tone: 'faint' as const, prs: prs.filter((p) => p.draft) },
  ]
    .map((g) => ({ ...g, prs: [...g.prs].sort(byUpdated) }))
    .filter((g) => g.prs.length)
}

export const ageDays = (iso: string, now = Date.now()) => Math.floor((now - new Date(iso).getTime()) / 86_400_000)

/** My reviews: Changes requested, New this week, Waiting longer. */
export function groupReviews(prs: Pr[], now = Date.now()): PrGroup[] {
  const cr = (p: Pr) => p.reviewDecision === 'CHANGES_REQUESTED'
  const oldestFirst = (a: Pr, b: Pr) => a.createdAt.localeCompare(b.createdAt)
  return [
    { title: 'Changes requested', tone: 'bad' as const, prs: prs.filter(cr) },
    { title: 'New this week', tone: 'accent' as const, prs: prs.filter((p) => !cr(p) && ageDays(p.createdAt, now) < 7) },
    { title: 'Waiting longer', tone: 'faint' as const, prs: prs.filter((p) => !cr(p) && ageDays(p.createdAt, now) >= 7).sort(oldestFirst) },
  ].filter((g) => g.prs.length)
}

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
      out.push({ key: `msg:${last.id}`, title: `${last.author} ${verb(c)} ${prRef(p)}`, body: excerpt(last.body || p.title), target: at })
    }
    if (p.changesRequestedBy && changesPending(p))
      out.push({ key: `cr:${p.changesRequestedBy.id}`, title: `Changes requested on ${prRef(p)}`, body: `${p.changesRequestedBy.author} · ${p.title}`, target: at })
    if (p.ci === 'fail' && !p.draft) out.push({ key: `ci:${p.id}:${p.headSha}`, title: `CI failed on ${prRef(p)}`, body: p.title, target: at })
  }
  for (const p of s.reviews) {
    if (p.requested && !p.authorBot) out.push({ key: `rr:${p.id}`, title: `Review requested: ${prRef(p)}`, body: `${p.author} · ${p.title}`, target: { tab: 'reviews', prId: p.id } })
  }
  return out
}
