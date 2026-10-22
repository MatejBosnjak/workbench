import { describe, expect, it } from 'vitest'
import { modelFromId, modelMatches } from './agent'

describe('modelMatches', () => {
  it('tells the 1M variant apart', () => {
    expect(modelMatches('opus[1m]', 'claude-opus-5-5[1m]')).toBe(true)
    expect(modelMatches('opus', 'claude-opus-5-5[1m]')).toBe(false)
    expect(modelMatches('opus', 'claude-opus-5-5')).toBe(true)
    expect(modelMatches('haiku', 'claude-sonnet-5-5')).toBe(false)
    expect(modelMatches('claude-haiku-5-5', 'claude-haiku-5-5')).toBe(true)
  })

  it('maps ids back to options', () => {
    expect(modelFromId('claude-sonnet-5-5')?.value).toBe('sonnet')
    expect(modelFromId('claude-opus-5-5[1m]')?.value).toBe('opus[1m]')
    expect(modelFromId(undefined)).toBeUndefined()
  })
})
