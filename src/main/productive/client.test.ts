import { describe, expect, it } from 'vitest'
import { commentHtml, encodeParams, htmlText } from './client'

describe('encodeParams', () => {
  it('encodes a saved filter the way the API expects', () => {
    expect(decodeURIComponent(encodeParams('filter', { assignee_id: { eq: '365452' }, workflow_status_category_id: { eq: ['1', '2'] } }).join('&'))).toBe(
      'filter[assignee_id][eq]=365452&filter[workflow_status_category_id][eq][]=1&filter[workflow_status_category_id][eq][]=2',
    )
  })
})

describe('comment html', () => {
  it('turns light markdown into Productive comment html', () => {
    expect(commentHtml('**Weekly**: fixed `a<b`\nnext line\n\n- one\n- two')).toBe(
      '<p><strong>Weekly</strong>: fixed <code>a&lt;b</code><br>next line</p><ul><li><p>one</p></li><li><p>two</p></li></ul>',
    )
  })

  it('reads stored html back as text', () => {
    expect(htmlText('<div class="prose-mirror-html"></div><p><strong>Weekly</strong>: Na PR-u &amp; sve</p><ul><li><p>a</p></li></ul>')).toBe('Weekly: Na PR-u & sve\n- a')
  })
})
