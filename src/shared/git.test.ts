import { describe, expect, it } from 'vitest'
import { gitEvents, groupMine, groupReviews, needsReply, type Conversation, type Pr } from './git'

let n = 0
const pr = (p: Partial<Pr>): Pr => ({
  id: `PR${++n}`,
  repo: 'productiveio/frontend',
  repoName: 'frontend',
  number: n,
  title: `pr ${n}`,
  url: '',
  author: 'me',
  authorBot: false,
  draft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  ci: 'pass',
  conflict: false,
  branch: 'b',
  headSha: 'sha',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  taskRefs: [],
  conversations: [],
  changesRequestedBy: null,
  ...p,
})
const talk = (key: string, ...authors: string[]): Conversation => ({
  key,
  kind: 'thread',
  targetId: key,
  path: 'a.ts',
  diffHunk: null,
  messages: authors.map((author, i) => ({ id: `${key}-${i}`, author, at: `2026-10-2${i}T00:00:00Z`, body: 'x', url: '' })),
})

describe('needsReply', () => {
  it('is the last message not being mine, until marked seen', () => {
    const c = talk('t', 'me', 'rev')
    expect(needsReply(c, 'me', {})).toBe(true)
    expect(needsReply(c, 'me', { t: 't-1' })).toBe(false)
    expect(needsReply(talk('t', 'rev', 'me'), 'me', {})).toBe(false)
    // A newer message after the seen one brings it back.
    expect(needsReply(talk('t', 'rev', 'me', 'rev'), 'me', { t: 't-1' })).toBe(true)
  })
})

describe('groupMine', () => {
  it('sorts PRs into the four groups', () => {
    const red = pr({ ci: 'fail' })
    const talking = pr({ conversations: [talk('a', 'rev')] })
    const approved = pr({ reviewDecision: 'APPROVED' })
    const waiting = pr({})
    const draft = pr({ draft: true, ci: 'fail' })
    const groups = groupMine([red, talking, approved, waiting, draft], 'me', {})
    expect(groups.map((g) => [g.title, g.prs.map((p) => p.id).sort()])).toEqual([
      ['Needs you', [red.id, talking.id].sort()],
      ['Ready to merge', [approved.id]],
      ['Waiting on reviewers', [waiting.id]],
      ['Drafts', [draft.id]],
    ])
    expect(groupMine([talking], 'me', { a: 'a-0' })[0]!.title).toBe('Waiting on reviewers')
  })
})

describe('groupReviews', () => {
  it('puts changes requested first, then by age', () => {
    const now = new Date('2026-10-22T12:00:00Z').getTime()
    const cr = pr({ reviewDecision: 'CHANGES_REQUESTED', createdAt: '2026-01-01T00:00:00Z' })
    const fresh = pr({ createdAt: '2026-10-21T00:00:00Z' })
    const old = pr({ createdAt: '2026-09-01T00:00:00Z' })
    expect(groupReviews([old, fresh, cr], now).map((g) => [g.title, g.prs.map((p) => p.id)])).toEqual([
      ['Changes requested', [cr.id]],
      ['New this week', [fresh.id]],
      ['Waiting longer', [old.id]],
    ])
  })
})

describe('gitEvents', () => {
  it('has one stable key per thing worth a notification', () => {
    const p = pr({
      ci: 'fail',
      headSha: 'abc',
      reviewDecision: 'CHANGES_REQUESTED',
      changesRequestedBy: { id: 'R1', author: 'rev', at: '' },
      conversations: [talk('t', 'rev'), { ...talk('pr', 'rev'), kind: 'pr', messages: [{ id: 'R1', author: 'rev', at: '', body: 'no', url: '', state: 'CHANGES_REQUESTED' }] }],
    })
    const asked = { ...pr({ author: 'colleague' }), requested: true }
    const botPr = { ...pr({ author: 'dependabot', authorBot: true }), requested: true }
    const keys = gitEvents({ viewer: 'me', mine: [p, pr({ draft: true, ci: 'fail' })], reviews: [asked, botPr], seen: {} }).map((e) => e.key)
    expect(keys).toEqual(['msg:t-0', `cr:R1`, `ci:${p.id}:abc`, `rr:${asked.id}`])
  })
})
