import { describe, expect, it } from 'vitest'
import { needsBreakdown, needsYou, todoDetail, todoLater, tomorrowMorning } from './needs'

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
