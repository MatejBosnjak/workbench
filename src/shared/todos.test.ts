import { describe, expect, it } from 'vitest'
import { dayText, parseCapture, parseDay } from './todos'

// Wed 28 Oct 2026
const now = new Date(2026, 9, 28, 10, 0)

describe('parseDay', () => {
  it('reads today, tomorrow and weekdays (the next one, never today)', () => {
    expect(parseDay('today', now)).toBe('2026-10-28')
    expect(parseDay('tomorrow', now)).toBe('2026-10-29')
    expect(parseDay('fri', now)).toBe('2026-10-30')
    expect(parseDay('Friday', now)).toBe('2026-10-30')
    expect(parseDay('wed', now)).toBe('2026-11-04')
    expect(parseDay('mon', now)).toBe('2026-11-02')
  })
  it('reads day and month either way round, rolling past dates into next year', () => {
    expect(parseDay('3 nov', now)).toBe('2026-11-03')
    expect(parseDay('nov 3', now)).toBe('2026-11-03')
    expect(parseDay('3. november', now)).toBe('2026-11-03')
    expect(parseDay('5 jan', now)).toBe('2027-01-05')
    expect(parseDay('2026-12-01', now)).toBe('2026-12-01')
  })
  it('ignores ordinary words', () => {
    expect(parseDay('bank', now)).toBeNull()
    expect(parseDay('the', now)).toBeNull()
    expect(parseDay('card', now)).toBeNull()
  })
})

describe('parseCapture', () => {
  it('takes a trailing day word off the text', () => {
    expect(parseCapture('Call the bank about the card fri', now)).toEqual({ text: 'Call the bank about the card', due: '2026-10-30' })
    expect(parseCapture('Renew registration 3 nov', now)).toEqual({ text: 'Renew registration', due: '2026-11-03' })
    expect(parseCapture('Book dentist', now)).toEqual({ text: 'Book dentist', due: null })
  })
  it('keeps a lone day word as the text', () => {
    expect(parseCapture('tomorrow', now)).toEqual({ text: 'tomorrow', due: null })
  })
})

describe('dayText', () => {
  it('names today and tomorrow', () => {
    expect(dayText('2026-10-28', now)).toBe('today')
    expect(dayText('2026-10-29', now)).toBe('tomorrow')
  })
})
