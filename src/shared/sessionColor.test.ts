import { describe, expect, it } from 'vitest'
import { pickSessionColor, SESSION_COLORS } from './sessionColor'

describe('pickSessionColor', () => {
  it('starts at the first colour', () => {
    expect(pickSessionColor([])).toBe(0)
  })

  it('keeps away from the two tabs before it', () => {
    const c = pickSessionColor([0, 3])
    expect(c).not.toBe(0)
    expect(c).not.toBe(3)
    expect([1, 2, 4, 6]).not.toContain(c)
  })

  it('uses every colour before repeating one', () => {
    const open: number[] = []
    for (let i = 0; i < SESSION_COLORS; i++) open.push(pickSessionColor(open))
    expect(new Set(open).size).toBe(SESSION_COLORS)
  })

  it('never repeats the colour of the tab before it', () => {
    const open: number[] = []
    for (let i = 0; i < 20; i++) {
      const c = pickSessionColor(open)
      if (open.length) expect(c).not.toBe(open[open.length - 1])
      open.push(c)
    }
  })
})
