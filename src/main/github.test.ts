import { describe, expect, it } from 'vitest'
import { PR_URL, rollup } from './github'

describe('rollup', () => {
  it('failure wins, then pending', () => {
    expect(rollup([])).toBeNull()
    expect(rollup([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('SUCCESS')
    expect(rollup([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }])).toBe('PENDING')
    expect(rollup([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('FAILURE')
    expect(rollup([{ state: 'SUCCESS' }])).toBe('SUCCESS')
  })
})

describe('PR_URL', () => {
  it('matches PR links inside text', () => {
    const m = PR_URL.exec('see https://github.com/productiveio/frontend/pull/30227/files for it')
    expect(m?.slice(1)).toEqual(['productiveio', 'frontend', '30227'])
  })
})
