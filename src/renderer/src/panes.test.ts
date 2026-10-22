import { describe, expect, it } from 'vitest'
import type { ServiceDef } from '@shared/local'
import { closePane, defaultLayout, leaves, nextShellId, splitPane } from './panes'

const def = (panes: number): ServiceDef => ({ name: 'app', cwd: '/', command: 'x', panes, profiles: [] })

describe('pane layout', () => {
  it('starts like prd: output left, shells stacked right', () => {
    expect(leaves(defaultLayout(def(2)))).toEqual(['svc:app', 'pane:app:0', 'pane:app:1'])
    expect(defaultLayout(def(0))).toEqual({ type: 'leaf', id: 'svc:app' })
  })

  it('splits and closes', () => {
    let l = defaultLayout(def(1))
    l = splitPane(l, 'pane:app:0', 'col', nextShellId(l, 'app'))
    expect(leaves(l)).toEqual(['svc:app', 'pane:app:0', 'pane:app:1'])
    l = splitPane(l, 'svc:app', 'row', nextShellId(l, 'app'))
    expect(leaves(l)).toEqual(['svc:app', 'pane:app:2', 'pane:app:0', 'pane:app:1'])
    l = closePane(closePane(l, 'pane:app:0'), 'pane:app:1')
    expect(leaves(l)).toEqual(['svc:app', 'pane:app:2'])
    expect(l.type === 'split' && l.children.every((c) => c.type === 'leaf')).toBe(true)
  })
})
