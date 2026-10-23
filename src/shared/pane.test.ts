import { describe, expect, it } from 'vitest'
import { evictionOrder, paneRoute, prKey } from './pane'

describe('paneRoute', () => {
  it('keeps productiveio pages and the login flow in the pane', () => {
    expect(paneRoute('https://github.com/productiveio/frontend/pull/30228/files')).toBe('pane')
    expect(paneRoute('https://github.com/productiveio/frontend/actions/runs/1')).toBe('pane')
    expect(paneRoute('https://github.com/login?return_to=x')).toBe('pane')
    expect(paneRoute('https://github.com/sessions/two-factor/app')).toBe('pane')
    expect(paneRoute('https://accounts.google.com/v3/signin/identifier')).toBe('pane')
    expect(paneRoute('https://accounts.google.hr/accounts/SetSID')).toBe('pane')
  })
  it('sends everything else to the browser', () => {
    expect(paneRoute('https://github.com/rails/rails/pull/1')).toBe('external')
    expect(paneRoute('https://github.com/MatejBosnjak')).toBe('external')
    expect(paneRoute('https://app.productive.io/109-productive/tasks/1')).toBe('external')
    expect(paneRoute('https://github.com.evil.example/productiveio/x')).toBe('external')
  })
})

describe('prKey', () => {
  it('strips tabs, anchors and queries', () => {
    expect(prKey('https://github.com/productiveio/specs/pull/391#discussion_r4335449758')).toBe('https://github.com/productiveio/specs/pull/391')
    expect(prKey('https://github.com/productiveio/frontend/pull/30228/files?w=1')).toBe('https://github.com/productiveio/frontend/pull/30228')
    expect(prKey('https://github.com/productiveio/frontend/issues/1')).toBeNull()
  })
})

describe('evictionOrder', () => {
  it('drops the least recently used first', () => {
    expect(evictionOrder([{ key: 'a', lastUsed: 3 }, { key: 'b', lastUsed: 1 }, { key: 'c', lastUsed: 2 }])).toEqual(['b', 'c', 'a'])
  })
})
