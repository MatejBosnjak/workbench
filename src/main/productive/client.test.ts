import { describe, expect, it } from 'vitest'
import { encodeParams } from './client'

describe('encodeParams', () => {
  it('encodes a saved filter the way the API expects', () => {
    expect(decodeURIComponent(encodeParams('filter', { assignee_id: { eq: '365452' }, workflow_status_category_id: { eq: ['1', '2'] } }).join('&'))).toBe(
      'filter[assignee_id][eq]=365452&filter[workflow_status_category_id][eq][]=1&filter[workflow_status_category_id][eq][]=2',
    )
  })
})
