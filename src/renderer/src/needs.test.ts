import { describe, expect, it } from 'vitest'
import { needsBreakdown, needsYou, nextNeed, said, todoDetail, todoLater, tomorrowMorning, withNext, type NeedItem } from './needs'
import type { Pr } from '@shared/git'

describe('tomorrowMorning', () => {
  it('is 08:00 the next day, also late at night', () => {
    const late = new Date(2026, 9, 23, 23, 30)
    const t = new Date(tomorrowMorning(late))
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([24, 8, 0])
    expect(new Date(tomorrowMorning(new Date(2026, 9, 31, 9, 0))).getMonth()).toBe(10)
  })
})

describe('to-dos in Needs you', () => {
  const todo = (id: number, due: string | null, doneAt: number | null = null) => ({ id, text: `t${id}`, note: '', due, sessionId: null, sessionTitle: null, createdAt: id, doneAt })
  it('lists open ones, dated by day first, and counts them', () => {
    const items = needsYou(null, null, [todo(1, null), todo(2, '2026-11-03'), todo(3, '2026-10-30'), todo(4, null, 5)])
    expect(items.map((i) => i.todo!.id)).toEqual([3, 2, 1])
    expect(needsBreakdown(items)).toBe('3 to-dos')
  })
  it('puts later ones to sleep and marks late ones', () => {
    const now = new Date(2026, 9, 28, 10)
    const [later] = needsYou(null, null, [todo(1, '2026-10-30')])
    expect(todoLater(later!, now)).toBe(true)
    expect(todoDetail(todo(2, '2026-10-27'), now)).toMatch(/^late · /)
    expect(todoDetail(todo(3, '2026-10-28'), now)).toBe('due today')
  })
})

describe('the row to start with', () => {
  const now = new Date(2026, 9, 28, 12)
  const pr = (o: Partial<Pr> = {}) => ({ id: 'p', reviewDecision: null, reviewers: [], ...o }) as Pr
  const item = (key: string, kind: NeedItem['kind'], o: Partial<NeedItem> = {}): NeedItem => ({ key, kind, ref: 'fe', text: key, detail: '', ...o })
  it('picks an approved PR held up only by CI before everything else', () => {
    const items = [
      item('reply', 'reply needed', { at: '2026-10-01T10:00:00Z' }),
      item('ci', 'ci failing', { pr: pr({ reviewDecision: 'APPROVED', reviewers: [{ login: 'tereza', avatar: '', state: 'approved' }] }) }),
    ]
    const n = nextNeed(items, now)!
    expect(n.key).toBe('ci')
    expect(n.why).toMatch(/approved by tereza; only CI/)
    expect(withNext(items, now).items.map((i) => i.key)).toEqual(['ci', 'reply'])
  })
  it('then changes asked of me, then the oldest reply, then what is due', () => {
    const due = item('todo', 'to-do', { todo: { id: 1, text: 'x', note: '', due: '2026-10-28', sessionId: null, sessionTitle: null, createdAt: 0, doneAt: null } })
    const old = item('old', 'reply needed', { at: '2026-10-10T10:00:00Z' })
    const fresh = item('fresh', 'reply needed', { at: '2026-10-27T10:00:00Z' })
    expect(nextNeed([due, fresh, old, item('cr', 'changes requested', { detail: 'marta' })], now)!.key).toBe('cr')
    expect(nextNeed([due, fresh, old], now)).toMatchObject({ key: 'old', why: expect.stringMatching(/^waiting on your reply for \d+d$/) })
    expect(nextNeed([item('red', 'ci failing', { pr: pr() }), due], now)).toEqual({ key: 'todo', why: 'due today' })
    expect(nextNeed([], now)).toBeNull()
  })
})

describe('said', () => {
  it('drops quoted lines when the message has its own words', () => {
    expect(said('> @x earlier text\n\nmy answer\nhere')).toBe('my answer here')
    expect(said('> only a quote')).toBe('> only a quote')
  })
})
