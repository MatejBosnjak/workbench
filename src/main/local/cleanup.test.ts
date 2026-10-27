import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// GitHub answers from a fixture: feature/merged has a merged PR at its current head.
const prs: unknown[] = []
vi.mock('../github/poller', () => ({
  gh: async () => JSON.stringify(prs),
  graphql: async () => ({}),
}))
const { WorktreeCleanup } = await import('./cleanup')

const dir = mkdtempSync(join(tmpdir(), 'wb-cleanup-'))
const root = join(dir, 'repos', 'app')
const wts = join(dir, 'worktrees')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
mkdirSync(root, { recursive: true })
mkdirSync(wts)
git(root, 'init', '-q', '-b', 'main')
git(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
git(root, 'worktree', 'add', '-q', '-b', 'feature/merged', join(wts, 'app-merged'))
git(root, 'worktree', 'add', '-q', '-b', 'feature/dirty', join(wts, 'app-dirty'))
writeFileSync(join(wts, 'app-dirty', 'notes.txt'), 'wip')
prs.push({ number: 7, state: 'MERGED', url: 'u', title: 'Merged', headRefName: 'feature/merged', headRefOid: git(root, 'rev-parse', 'HEAD'), mergedAt: '2026-01-01T00:00:00Z', closedAt: null })
writeFileSync(join(dir, 'wtrc.json'), JSON.stringify({ reposDir: join(dir, 'repos'), worktreesDir: wts }))
process.env.WORKBENCH_WTRC = join(dir, 'wtrc.json')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('WorktreeCleanup', () => {
  const c = new WorktreeCleanup({ productive: async () => Promise.reject(new Error('offline')), tabs: () => [], services: () => [] }, () => {})

  it('scans linked worktrees, classifies them, and removes the done one with its branch', async () => {
    await c.scan()
    const rows = c.snapshot().rows
    expect(rows.map((r) => [r.name, r.verdict, r.deleteBranch])).toEqual([
      ['app-merged', 'done', true],
      ['app-dirty', 'keep', false],
    ])
    expect(rows[1]!.changes).toEqual(['?? notes.txt'])

    await c.remove([join(wts, 'app-merged')])
    expect(existsSync(join(wts, 'app-merged'))).toBe(false)
    expect(git(root, 'branch', '--list', 'feature/merged')).toBe('')
  })

  it('removes a worktree with changes only with force, keeping its branch', async () => {
    await c.remove([join(wts, 'app-dirty')])
    expect(c.snapshot().failed[join(wts, 'app-dirty')]).toMatch(/untracked|modified/)
    await c.remove([join(wts, 'app-dirty')], true)
    expect(existsSync(join(wts, 'app-dirty'))).toBe(false)
    expect(git(root, 'branch', '--list', 'feature/dirty')).toContain('feature/dirty')
  })
})
