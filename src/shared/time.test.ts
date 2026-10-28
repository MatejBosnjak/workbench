import { describe, expect, it } from 'vitest'
import { age, dueText } from './time'

describe('age', () => {
  const now = new Date(2026, 9, 28, 12, 0).getTime()
  it('says how long ago in one unit', () => {
    expect(age(now - 20_000, now)).toBe('now')
    expect(age(now - 12 * 60_000, now)).toBe('12m')
    expect(age(now - 3 * 3_600_000, now)).toBe('3h')
    expect(age(now - 13 * 86_400_000, now)).toBe('13d')
    expect(age(now - 90 * 86_400_000, now)).toBe('3mo')
  })
})

describe('dueText', () => {
  const now = new Date(2026, 9, 28, 10) // Wed
  it('is a weekday and a distance, or late by', () => {
    expect(dueText('2026-10-28', now)).toBe('today')
    expect(dueText('2026-10-29', now)).toBe('tomorrow')
    expect(dueText('2026-10-30', now)).toMatch(/ · in 2d$/)
    expect(dueText('2026-11-06', now)).toMatch(/ · in 9d$/)
    expect(dueText('2026-10-26', now)).toBe('late · 2d')
  })
})
