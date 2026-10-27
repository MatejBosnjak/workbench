import { describe, expect, it } from 'vitest'
import { classify, pickPr, reviewNumber, type CleanupPr, type WorktreeFacts } from './cleanup'

const NOW = 1_800_000_000
const facts = (p: Partial<WorktreeFacts>): WorktreeFacts => ({
  path: '/w/frontend-x',
  name: 'frontend-x',
  repo: 'productiveio/frontend',
  root: '/r/frontend',
  branch: 'feature/x',
  head: 'abc',
  ts: NOW - 3600,
  changes: [],
  moreChanges: false,
  unpushed: 0,
  inPr: false,
  reviewOf: null,
  pr: null,
  task: null,
  tabs: [],
  services: [],
  ...p,
})
const pr = (p: Partial<CleanupPr>): CleanupPr => ({ number: 1, state: 'MERGED', url: '', title: '', headRefName: 'feature/x', headRefOid: 'abc', endedAt: 1, ...p })

describe('classify', () => {
  it('sweeps a merged PR and deletes its branch, even with squash-merge "unpushed" commits the PR has', () => {
    const r = classify(facts({ pr: pr({}), unpushed: 3, inPr: true }), NOW)
    expect([r.verdict, r.deleteBranch]).toEqual(['done', true])
  })

  it('keeps tabs, services and changes before anything else', () => {
    expect(classify(facts({ pr: pr({}), tabs: ['Fix it'] }), NOW).verdict).toBe('keep')
    expect(classify(facts({ pr: pr({}), services: ['app'] }), NOW).verdict).toBe('keep')
    expect(classify(facts({ pr: pr({}), changes: [' M a.ts'] }), NOW).reason).toBe('1 uncommitted change')
  })

  it('asks when a merged branch has commits the PR lacks, and keeps the branch', () => {
    const r = classify(facts({ pr: pr({}), unpushed: 2, inPr: false }), NOW)
    expect([r.verdict, r.deleteBranch]).toEqual(['maybe', false])
  })

  it('review checkouts go when their PR is merged or closed; never their (absent) branch', () => {
    const r = classify(facts({ branch: null, reviewOf: 7, pr: pr({ number: 7, state: 'CLOSED' }), unpushed: 1, inPr: true }), NOW)
    expect([r.verdict, r.deleteBranch]).toEqual(['done', false])
    expect(classify(facts({ branch: null, reviewOf: 7, pr: pr({ number: 7, state: 'OPEN' }) }), NOW).verdict).toBe('keep')
  })

  it('keeps a detached checkout whose commits are on no branch', () => {
    expect(classify(facts({ branch: null, unpushed: 2 }), NOW).verdict).toBe('keep')
  })

  it('without a PR: open task keeps, closed task or 4 quiet weeks ask', () => {
    expect(classify(facts({ task: { id: '1', title: 'T', closed: false }, ts: 0 }), NOW).verdict).toBe('keep')
    expect(classify(facts({ task: { id: '1', title: 'T', closed: true } }), NOW).verdict).toBe('maybe')
    expect(classify(facts({ ts: NOW - 40 * 86400 }), NOW).verdict).toBe('maybe')
    expect(classify(facts({}), NOW).verdict).toBe('keep')
  })

  it('a closed PR asks and keeps the branch', () => {
    const r = classify(facts({ pr: pr({ state: 'CLOSED' }) }), NOW)
    expect([r.verdict, r.deleteBranch]).toEqual(['maybe', false])
  })
})

describe('pickPr', () => {
  it('prefers open, then the latest merged', () => {
    expect(pickPr([pr({ number: 1, endedAt: 5 }), pr({ number: 2, endedAt: 9 })])?.number).toBe(2)
    expect(pickPr([pr({ number: 1 }), pr({ number: 3, state: 'OPEN', endedAt: null })])?.number).toBe(3)
    expect(pickPr([])).toBeNull()
  })
})

describe('reviewNumber', () => {
  it('reads the PR from review folder names', () => {
    expect(reviewNumber('frontend-review-29043')).toBe(29043)
    expect(reviewNumber('review-28481')).toBe(28481)
    expect(reviewNumber('frontend-pr29469-review')).toBe(29469)
    expect(reviewNumber('frontend-20836223-service-discount')).toBeNull()
  })
})
