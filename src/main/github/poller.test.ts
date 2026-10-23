import { describe, expect, it } from 'vitest'
import { normalize, type RawResult } from './poller'

const actor = (login: string, __typename = 'User') => ({ login, __typename })
const base = (p: Record<string, unknown>) => ({
  id: 'P1',
  number: 1,
  title: 't',
  url: 'u',
  isDraft: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  headRefName: 'feature/21071355-rate-card',
  headRefOid: 'sha',
  body: 'Task: https://app.productive.io/109-productive/tasks/20135272',
  reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'CONFLICTING',
  repository: { nameWithOwner: 'productiveio/frontend', name: 'frontend' },
  author: actor('me'),
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  ...p,
})
const c = (id: string, who: string, at: string, type = 'User') => ({ id, author: actor(who, type), createdAt: at, body: id, url: '' })

describe('normalize', () => {
  it('builds PRs, conversations and the review list', () => {
    const raw = {
      viewer: { login: 'me' },
      mine: {
        nodes: [
          base({
            reviewThreads: {
              nodes: [
                { id: 'T1', isResolved: false, path: 'a.ts', head: { nodes: [{ diffHunk: '@@' }] }, comments: { nodes: [c('c1', 'rev', '2026-10-01'), c('c2', 'me', '2026-10-02')] } },
                { id: 'T2', isResolved: true, path: 'b.ts', head: { nodes: [] }, comments: { nodes: [c('c3', 'rev', '2026-10-01')] } },
              ],
            },
            comments: { nodes: [c('c4', 'codecov', '2026-10-03', 'Bot'), c('c5', 'rev', '2026-10-01')] },
            reviews: {
              nodes: [
                { id: 'R1', author: actor('rev'), state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02', body: '', url: '' },
                { id: 'R2', author: actor('rev'), state: 'COMMENTED', submittedAt: '2026-10-02', body: '', url: '' },
                // My reply in a review thread arrives as a review with no top-level text: it answers the PR conversation.
                { id: 'R3', author: actor('me'), state: 'COMMENTED', submittedAt: '2026-10-03', body: '', url: '', reactionGroups: [] },
              ],
            },
          }),
          {},
        ],
      },
      requested: { nodes: [base({ id: 'P2', author: actor('dependabot', 'Bot') })] },
      reviewed: {
        nodes: [
          base({ id: 'P2' }),
          base({ id: 'P3', latestOpinionatedReviews: { nodes: [{ author: { login: 'me' }, state: 'CHANGES_REQUESTED' }] } }),
          base({ id: 'P4', latestOpinionatedReviews: { nodes: [{ author: { login: 'me' }, state: 'APPROVED' }] } }),
        ],
      },
    } as unknown as RawResult
    const r = normalize(raw)
    const p = r.mine[0]!
    expect(r.mine).toHaveLength(1)
    expect([p.ci, p.conflict, p.taskRefs]).toEqual(['fail', true, ['21071355', '20135272']])
    expect(p.conversations.map((x) => [x.key, x.messages.map((m) => m.id)])).toEqual([
      ['thread:T1', ['c1', 'c2']],
      ['pr:P1', ['c5', 'R1', 'R3']],
    ])
    expect(p.conversations[0]!.diffHunk).toBe('@@')
    expect(p.changesRequestedBy?.id).toBe('R1')
    expect(r.reviews.map((x) => [x.id, x.requested, x.authorBot, x.reviewDecision])).toEqual([
      ['P2', true, true, 'REVIEW_REQUIRED'],
      ['P3', false, false, 'CHANGES_REQUESTED'],
    ])
  })
})
