import { describe, expect, it } from 'vitest'
import { autoHolds, settleHolds, strongest, type CafHold } from './caffeinate'
import type { Session } from './types'

const s = (id: string, state: Session['state'], alive = true): Session => ({
  id,
  cwd: '/',
  title: id,
  state,
  alive,
  external: false,
  startedAt: 0,
  lastEventAt: 0,
  model: null,
  effort: null,
  permissionMode: null,
  color: 0,
})
const h = (sessionId: string, until: CafHold['until'], mode: CafHold['mode'] = 'on'): CafHold => ({ sessionId, mode, until, since: 0, auto: false })

describe('settleHolds', () => {
  it('drops a hold whose tab closed', () => {
    expect(settleHolds([h('a', 'manual')], [], new Set()).holds).toEqual([])
  })
  it('drops an until-done hold once its session stops working', () => {
    const r = settleHolds([h('a', 'done'), h('b', 'closed')], [s('a', 'idle'), s('b', 'idle')], new Set(['a', 'b']))
    expect(r.holds.map((x) => x.sessionId)).toEqual(['b'])
    expect(r.released.map((x) => x.sessionId)).toEqual(['a'])
  })
  it('keeps an until-done hold set on an idle session until a turn runs', () => {
    expect(settleHolds([h('a', 'done')], [s('a', 'idle')], new Set()).holds).toHaveLength(1)
  })
  it('keeps it while the session waits on me', () => {
    expect(settleHolds([h('a', 'done')], [s('a', 'waiting')], new Set(['a'])).holds).toHaveLength(1)
  })
})

describe('autoHolds', () => {
  it('holds for running sessions without a hold of their own', () => {
    const a = autoHolds([s('a', 'running'), s('b', 'waiting'), s('c', 'running'), s('d', 'running', false)], [h('c', 'manual')], new Map())
    expect(a.map((x) => x.sessionId)).toEqual(['a'])
  })
})

describe('strongest', () => {
  it('lid beats awake beats off', () => {
    expect(strongest([])).toBe('off')
    expect(strongest([h('a', 'done')])).toBe('on')
    expect(strongest([h('a', 'done'), h('b', 'manual', 'lid')])).toBe('lid')
  })
})
