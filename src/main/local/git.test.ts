import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from './git'

describe('parseWorktreeList', () => {
  it('reads paths and branches, skipping bare and temp worktrees', () => {
    const out = [
      'worktree /r/frontend\nHEAD abc\nbranch refs/heads/develop',
      'worktree /w/frontend-pr-1\nHEAD def\nbranch refs/heads/feat/x',
      'worktree /w/detached\nHEAD 123\ndetached',
      'worktree /private/var/folders/bh/T/cache\nHEAD 1\ndetached\nprunable gitdir file points to non-existent location',
      'worktree /r/bare.git\nbare',
    ].join('\n\n')
    expect(parseWorktreeList(out)).toEqual([
      { path: '/r/frontend', branch: 'develop', bare: false },
      { path: '/w/frontend-pr-1', branch: 'feat/x', bare: false },
      { path: '/w/detached', branch: null, bare: false },
    ])
  })
})
