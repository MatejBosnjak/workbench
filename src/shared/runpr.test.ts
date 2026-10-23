import { describe, expect, it } from 'vitest'
import { ghPrCommand, matchWorktree, pickFocus, prMentions, prUrls } from './runpr'

describe('pickFocus', () => {
  it('prefers the newest strong signal, falling back to task and gh signals', () => {
    expect(pickFocus([])).toBeNull()
    expect(pickFocus([{ kind: 'task', number: 1, at: 5 }, { kind: 'gh', number: 2, at: 9 }])?.number).toBe(2)
    expect(pickFocus([{ kind: 'gh', number: 2, at: 9 }, { kind: 'worktree', number: 3, at: 1 }])?.number).toBe(3)
    expect(pickFocus([{ kind: 'worktree', number: 3, at: 1 }, { kind: 'mention', number: 4, at: 2 }])?.number).toBe(4)
  })
})

describe('PR detection', () => {
  it('finds frontend PRs in prompts, output and gh commands', () => {
    expect(prMentions('review https://github.com/productiveio/frontend/pull/30228/files and fe #30224, also #123')).toEqual([30228, 30224])
    expect(prMentions('see https://github.com/productiveio/api/pull/24358')).toEqual([])
    expect(prUrls('remote:   https://github.com/productiveio/frontend/pull/30259\n')).toEqual([30259])
    expect(ghPrCommand('gh pr view 30227 --json files')).toBe(30227)
    expect(ghPrCommand('cd x && gh pr checkout --repo productiveio/frontend 30228')).toBe(30228)
    expect(ghPrCommand('gh pr list')).toBeNull()
  })
})

describe('matchWorktree', () => {
  const wts = [
    { path: '/w/a', branch: 'feature/1-a', upstream: 'origin/feature/1-a', hasHead: false },
    { path: '/w/b', branch: 'feature/20360127-rate-card', upstream: 'origin/feature/21071355-rate-card', hasHead: false },
    { path: '/w/c', branch: 'local-name', upstream: null, hasHead: true },
  ]
  it('matches by branch, then upstream, then head commit', () => {
    expect(matchWorktree({ branch: 'feature/1-a' }, wts)).toEqual({ path: '/w/a', by: 'branch' })
    expect(matchWorktree({ branch: 'feature/21071355-rate-card' }, wts)).toEqual({ path: '/w/b', by: 'upstream' })
    expect(matchWorktree({ branch: 'other' }, wts)).toEqual({ path: '/w/c', by: 'commit' })
    expect(matchWorktree({ branch: 'other' }, wts.slice(0, 2))).toBeNull()
  })
})
