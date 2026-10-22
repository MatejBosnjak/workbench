import { describe, expect, it } from 'vitest'
import { migrate, openDb } from './db'
import { Repo, type SessionRow } from './repo'

const row = (id: string): SessionRow => ({ id, cwd: '/tmp', title: id, state: 'idle', external: false, startedAt: 1, lastEventAt: 1 })

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

  it('round-trips settings as JSON', () => {
    const repo = new Repo(openDb(':memory:'))
    expect(repo.getSetting('defaultCwd', '/x')).toBe('/x')
    repo.setSetting('defaultCwd', '/y')
    expect(repo.getSetting('defaultCwd', '/x')).toBe('/y')
  })

  it('migrations are idempotent', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(1)
  })
})
