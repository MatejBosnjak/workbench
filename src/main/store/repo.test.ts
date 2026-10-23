import { describe, expect, it } from 'vitest'
import { migrate, openDb } from './db'
import { Repo, type SessionRow } from './repo'

const row = (id: string): SessionRow => ({
  id,
  cwd: '/tmp',
  title: id,
  state: 'idle',
  external: false,
  startedAt: 1,
  lastEventAt: 1,
  claudeId: null,
  transcriptPath: null,
  model: null,
  effort: null,
  permissionMode: null,
})

describe('Repo', () => {
  it('keeps open tabs in insertion order and drops closed ones', () => {
    const repo = new Repo(openDb(':memory:'))
    ;['a', 'b', 'c'].forEach((id) => repo.insertTab(row(id)))
    repo.closeTab('b')
    expect(repo.openTabs().map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('reorders tabs', () => {
    const repo = new Repo(openDb(':memory:'))
    ;['a', 'b', 'c'].forEach((id) => repo.insertTab(row(id)))
    repo.reorder(['c', 'a', 'b'])
    expect(repo.openTabs().map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('updates state and title', () => {
    const repo = new Repo(openDb(':memory:'))
    repo.insertTab(row('a'))
    repo.update('a', { state: 'failed', title: 'Fix CI' })
    expect(repo.openTabs()[0]).toMatchObject({ state: 'failed', title: 'Fix CI', external: false })
  })

  it('stores a locked title', () => {
    const repo = new Repo(openDb(':memory:'))
    repo.insertTab(row('a'))
    expect(repo.get('a')?.titleLocked).toBe(false)
    repo.update('a', { title: 'Task', titleLocked: true })
    expect(repo.get('a')).toMatchObject({ title: 'Task', titleLocked: true })
  })

  it('finds a session by its claude id and reopens closed tabs at the end', () => {
    const repo = new Repo(openDb(':memory:'))
    ;['a', 'b'].forEach((id) => repo.insertTab(row(id)))
    repo.update('a', { claudeId: 'c1' })
    expect(repo.findByClaudeId('c1')?.id).toBe('a')
    expect(repo.findByClaudeId('b')?.id).toBe('b')
    repo.closeTab('a')
    expect(repo.get('a')?.open).toBe(false)
    repo.reopenTab('a')
    expect(repo.openTabs().map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('round-trips settings as JSON', () => {
    const repo = new Repo(openDb(':memory:'))
    expect(repo.getSetting('defaultCwd', '/x')).toBe('/x')
    repo.setSetting('defaultCwd', '/y')
    expect(repo.getSetting('defaultCwd', '/x')).toBe('/y')
  })

  it('migrations are idempotent', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(6)
  })
})

describe('links', () => {
  it('a link removed by hand is not re-added by inference', () => {
    const repo = new Repo(openDb(':memory:'))
    repo.insertTab(row('s1'))
    expect(repo.addLink('s1', 't1', 'task URL in prompt', 'auto')).toBe(true)
    expect(repo.addLink('s1', 't1', 'again', 'auto')).toBe(false)
    repo.removeLink('s1', 't1')
    expect(repo.addLink('s1', 't1', 'branch name', 'auto')).toBe(false)
    expect(repo.links()).toHaveLength(0)
    expect(repo.addLink('s1', 't1', 'linked by hand', 'manual')).toBe(true)
    const [l] = repo.links()
    expect(l).toMatchObject({ sessionId: 's1', taskId: 't1', via: 'linked by hand', createdBy: 'manual' })
    expect(l!.session?.title).toBe('s1')
  })
})

describe('seen and drafts', () => {
  it('keeps the last seen message per conversation', () => {
    const repo = new Repo(openDb(':memory:'))
    repo.markSeen('thread:T1', 'c1')
    repo.markSeen('thread:T1', 'c2')
    expect(repo.seen()).toEqual({ 'thread:T1': 'c2' })
  })

  it('stores drafts with their target', () => {
    const repo = new Repo(openDb(':memory:'))
    const target = { kind: 'gh-pr' as const, key: 'pr:P1', repo: 'o/r', number: 1 }
    const id = repo.addDraft(target, '', 'drafting')
    repo.updateDraft(id, { body: 'hello', status: 'ready' })
    expect(repo.draft(id)).toMatchObject({ target, body: 'hello', status: 'ready', error: null })
    repo.deleteDraft(id)
    expect(repo.drafts()).toEqual([])
  })
})
