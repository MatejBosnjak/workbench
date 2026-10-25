import { describe, expect, it } from 'vitest'
import { askedForChanges, gitEvents, groupByStage, groupReviews, mergeChecks, mergeScore, needsReply, type Conversation, type Pr } from './git'

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
    // An emoji reaction from me on the last message is an answer.
    const r = talk('t', 'me', 'rev')
    r.messages[1]!.reacted = true
    expect(needsReply(r, 'me', {})).toBe(false)
  })
})

describe('groupByStage', () => {
  it('sorts PRs by stage, nearest to merge first', () => {
    const approved = pr({ reviewDecision: 'APPROVED' })
    const review = pr({})
    const changes = pr({ reviewDecision: 'CHANGES_REQUESTED' })
    const addressed = pr({ reviewDecision: 'CHANGES_REQUESTED', changesAddressed: true })
    const draft = pr({ draft: true, reviewDecision: 'APPROVED' })
    expect(groupByStage([draft, changes, review, approved, addressed]).map((g) => [g.title, g.prs.map((p) => p.id).sort()])).toEqual([
      ['Ready to merge', [approved.id]],
      ['In review', [review.id, addressed.id].sort()],
      ['Changes requested', [changes.id]],
      ['Draft', [draft.id]],
    ])
  })

  it('puts the PR closest to merging first within a stage', () => {
    const red = pr({ ci: 'fail', updatedAt: '2026-10-22T00:00:00Z' })
    const green = pr({ ci: 'pass', updatedAt: '2026-10-21T00:00:00Z' })
    expect(groupByStage([red, green])[0]!.prs.map((p) => p.id)).toEqual([green.id, red.id])
  })

  it('sorts by date opened, newest first, when asked', () => {
    const old = pr({ ci: 'pass', createdAt: '2026-10-01T00:00:00Z' })
    const fresh = pr({ ci: 'fail', createdAt: '2026-10-10T00:00:00Z' })
    expect(groupByStage([old, fresh], 'opened')[0]!.prs.map((p) => p.id)).toEqual([fresh.id, old.id])
  })
})

describe('mergeChecks', () => {
  it('reads CI, reviews, conflicts and open threads', () => {
    const p = pr({ ci: 'fail', reviewDecision: 'CHANGES_REQUESTED', conflict: true, conversations: [talk('a', 'rev'), talk('b', 'rev')] })
    expect(mergeChecks(p).map((c) => `${c.state} ${c.label}`)).toEqual(['bad CI', 'bad changes requested', 'bad conflict', 'wait 2 open threads'])
    expect(mergeScore(pr({ reviewDecision: 'APPROVED' }))).toBe(4)
    expect(mergeScore(pr({ reviewDecision: 'APPROVED', ci: 'none' }))).toBe(4)
  })
})

describe('groupReviews', () => {
  it('groups reviews waiting on me by age and keeps the ones where I asked for changes apart', () => {
    const now = new Date('2026-10-22T12:00:00Z').getTime()
    const asked = pr({ reviewDecision: 'CHANGES_REQUESTED', requested: false, createdAt: '2026-01-01T00:00:00Z' })
    // Someone else asked for changes and the author re-requested me: it's waiting on me.
    const rerequested = pr({ reviewDecision: 'CHANGES_REQUESTED', requested: true, createdAt: '2026-10-21T00:00:00Z' })
    const fresh = pr({ requested: true, createdAt: '2026-10-21T00:00:00Z' })
    const old = pr({ requested: true, createdAt: '2026-09-01T00:00:00Z' })
    expect(groupReviews([old, fresh, asked, rerequested], now).map((g) => [g.title, g.prs.map((p) => p.id).sort()])).toEqual([
      ['New this week', [fresh.id, rerequested.id].sort()],
      ['Waiting longer', [old.id]],
    ])
    expect(askedForChanges([old, asked, fresh]).map((p) => p.id)).toEqual([asked.id])
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
