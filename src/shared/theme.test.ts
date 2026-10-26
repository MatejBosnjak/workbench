import { describe, expect, it } from 'vitest'
import { isTheme, statusCode } from './theme'

describe('statusCode', () => {
  it('uses the hand-picked codes for known statuses', () => {
    expect(statusCode('Working')).toBe('WRK')
    expect(statusCode('Peer Review')).toBe('REV')
    expect(statusCode('On Production / Followup')).toBe('PRD')
    expect(statusCode(null)).toBe('---')
  })
  it('derives three letters for the rest', () => {
    expect(statusCode('Deployed')).toBe('DPL')
    expect(statusCode('Ready for QA')).toBe('RFQ')
    expect(statusCode('Design done')).toBe('DED')
  })
})

describe('isTheme', () => {
  it('knows the four themes', () => {
    expect(isTheme('console')).toBe(true)
    expect(isTheme('beige')).toBe(false)
  })
})
