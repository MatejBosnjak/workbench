import { describe, expect, it } from 'vitest'
import { tomorrowMorning } from './needs'

describe('tomorrowMorning', () => {
  it('is 08:00 the next day, also late at night', () => {
    const late = new Date(2026, 9, 23, 23, 30)
    const t = new Date(tomorrowMorning(late))
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([24, 8, 0])
    expect(new Date(tomorrowMorning(new Date(2026, 9, 31, 9, 0))).getMonth()).toBe(10)
  })
})
