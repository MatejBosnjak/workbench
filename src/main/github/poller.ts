import { execFile } from 'node:child_process'
import type { Ci, Conversation, GhMessage, Pr } from '@shared/git'
import { isBot } from '@shared/git'
import { taskIdsFromText } from '@shared/tasks'
import { shellEnv, which } from '../shell-env'
import type { Repo } from '../store/repo'

const POLL_MS = 2 * 60_000

const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt headRefName headRefOid body reviewDecision mergeable
  repository { nameWithOwner name }
  author { login __typename }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`
const ACTOR = 'author { login __typename }'

export const QUERY = `
query {
  viewer { login }
  mine: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      ${PR_FIELDS}
      reviewThreads(first: 50) { nodes {
        id isResolved path
        head: comments(first: 1) { nodes { diffHunk } }
        comments(last: 6) { nodes { id ${ACTOR} createdAt body url } }
      } }
      comments(last: 8) { nodes { id ${ACTOR} createdAt body url } }
      reviews(last: 15) { nodes { id ${ACTOR} state submittedAt body url } }
    } }
  }
  requested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  reviewed: search(query: "is:pr is:open reviewed-by:@me -author:@me archived:false", type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FIELDS} latestOpinionatedReviews(first: 30) { nodes { author { login } state } } } }
  }
}`

interface Actor {
  login: string
  __typename?: string
}
interface RawComment {
  id: string
  author: Actor | null
  createdAt: string
  body: string
  url: string
}
interface RawReview {
  id: string
  author: Actor | null
  state: string
  submittedAt: string | null
  body: string
  url: string
}
interface RawPr {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  headRefName: string
  headRefOid: string
  body: string
  reviewDecision: string | null
  mergeable: string
  repository: { nameWithOwner: string; name: string }
  author: Actor | null
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  reviewThreads?: { nodes: { id: string; isResolved: boolean; path: string; head: { nodes: { diffHunk: string }[] }; comments: { nodes: RawComment[] } }[] }
  comments?: { nodes: RawComment[] }
  reviews?: { nodes: RawReview[] }
  latestOpinionatedReviews?: { nodes: { author: { login: string } | null; state: string }[] }
}
export interface RawResult {
  viewer: { login: string }
  mine: { nodes: RawPr[] }
  requested: { nodes: RawPr[] }
  reviewed: { nodes: RawPr[] }
}

const login = (a: Actor | null) => a?.login ?? 'ghost'
const human = (a: Actor | null) => !!a && !isBot(a.login, a.__typename)

function ci(p: RawPr): Ci {
  const s = p.commits.nodes[0]?.commit.statusCheckRollup?.state
  if (!s) return 'none'
  if (s === 'SUCCESS') return 'pass'
  if (s === 'FAILURE' || s === 'ERROR') return 'fail'
  return 'pending'
}

const comment = (c: RawComment): GhMessage => ({ id: c.id, author: login(c.author), at: c.createdAt, body: c.body, url: c.url })

function conversations(p: RawPr): Conversation[] {
  const threads: Conversation[] = (p.reviewThreads?.nodes ?? [])
    .filter((t) => !t.isResolved)
    .map((t) => ({
      key: `thread:${t.id}`,
      kind: 'thread',
      targetId: t.id,
      path: t.path,
      diffHunk: t.head.nodes[0]?.diffHunk ?? null,
      messages: t.comments.nodes.filter((c) => human(c.author)).map(comment),
    }))
  // The PR's conversation tab: plain comments plus reviews that said something or decided something.
  const reviews = (p.reviews?.nodes ?? [])
    // A bare approval says nothing to answer; a bare "changes requested" still wants a response.
    .filter((r) => human(r.author) && r.submittedAt && (r.body.trim() || r.state === 'CHANGES_REQUESTED'))
    .map((r): GhMessage => ({ id: r.id, author: login(r.author), at: r.submittedAt!, body: r.body, url: r.url, state: r.state }))
  const comments = (p.comments?.nodes ?? []).filter((c) => human(c.author)).map(comment)
  const pr: Conversation = {
    key: `pr:${p.id}`,
    kind: 'pr',
    targetId: p.id,
    path: null,
    diffHunk: null,
    messages: [...comments, ...reviews].sort((a, b) => a.at.localeCompare(b.at)),
  }
  return [...threads, pr].filter((c) => c.messages.length)
}

function changesRequestedBy(p: RawPr): Pr['changesRequestedBy'] {
  const r = (p.reviews?.nodes ?? []).filter((r) => r.state === 'CHANGES_REQUESTED' && r.submittedAt).at(-1)
  return r ? { id: r.id, author: login(r.author), at: r.submittedAt! } : null
}

function toPr(p: RawPr, withTalk: boolean): Pr {
  const fromBranch = [...p.headRefName.matchAll(/(?:^|\D)(\d{7,9})(?=\D|$)/g)].map((m) => m[1]!)
  return {
    id: p.id,
    repo: p.repository.nameWithOwner,
    repoName: p.repository.name,
    number: p.number,
    title: p.title,
    url: p.url,
    author: login(p.author),
    authorBot: !human(p.author),
    draft: p.isDraft,
    reviewDecision: p.reviewDecision || null,
    ci: ci(p),
    conflict: p.mergeable === 'CONFLICTING',
    branch: p.headRefName,
    headSha: p.headRefOid,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    taskRefs: [...new Set([...fromBranch, ...taskIdsFromText(p.body ?? '')])],
    conversations: withTalk ? conversations(p) : [],
    changesRequestedBy: withTalk ? changesRequestedBy(p) : null,
  }
}

export function normalize(r: RawResult): { viewer: string; mine: Pr[]; reviews: Pr[] } {
  const viewer = r.viewer.login
  const requested = r.requested.nodes.filter((p) => p.id).map((p) => ({ ...toPr(p, false), requested: true }))
  const ids = new Set(requested.map((p) => p.id))
  // PRs I already reviewed stay on the list while my latest opinion is "changes requested".
  const asked = r.reviewed.nodes
    .filter((p) => p.id && !ids.has(p.id))
    .filter((p) => p.latestOpinionatedReviews?.nodes.some((v) => v.author?.login === viewer && v.state === 'CHANGES_REQUESTED'))
    .map((p) => ({ ...toPr(p, false), reviewDecision: 'CHANGES_REQUESTED', requested: false }))
  return { viewer, mine: r.mine.nodes.filter((p) => p.id).map((p) => toPr(p, true)), reviews: [...requested, ...asked] }
}

/** Polls my PRs and review requests through `gh api graphql`. Read-only. */
export class GitPoller {
  private timer: NodeJS.Timeout | null = null
  viewer: string | null
  mine: Pr[]
  reviews: Pr[]
  fetchedAt: number | null
  error: string | null = null
  loading = false

  constructor(
    private repo: Repo,
    private changed: () => void,
  ) {
    const cached = repo.getSetting<{ viewer: string; mine: Pr[]; reviews: Pr[]; at: number } | null>('git:cache', null)
    this.viewer = cached?.viewer ?? null
    this.mine = cached?.mine ?? []
    this.reviews = cached?.reviews ?? []
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
      // GitHub now and then cuts a large search response short; one retry covers it.
      const raw = await graphql<RawResult>(QUERY).catch(() => graphql<RawResult>(QUERY))
      const r = normalize(raw)
      this.viewer = r.viewer
      this.mine = r.mine
      this.reviews = r.reviews
      this.fetchedAt = Date.now()
      this.error = null
      this.repo.setSetting('git:cache', { ...r, at: this.fetchedAt })
    } catch (e) {
      this.error = (e as Error).message
    } finally {
      this.loading = false
      this.changed()
    }
  }

  find(id: string): Pr | undefined {
    return this.mine.find((p) => p.id === id) ?? this.reviews.find((p) => p.id === id)
  }
}

export async function gh(args: string[], input?: string): Promise<string> {
  const env = await shellEnv()
  const bin = which('gh', env)
  if (!bin) throw new Error('gh not found')
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    )
    child.stdin?.end(input ?? '')
  })
}

export async function graphql<T>(query: string, vars: Record<string, string> = {}): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ['-f', `${k}=${v}`])]
  const out = JSON.parse(await gh(args)) as { data?: T; errors?: { message: string }[] }
  if (out.errors?.length && !out.data) throw new Error(out.errors[0]!.message)
  return out.data!
}
