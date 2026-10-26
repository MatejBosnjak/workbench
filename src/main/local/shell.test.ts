import { describe, expect, it } from 'vitest'
import { readMarks } from './shell'

describe('readMarks', () => {
  it('takes the markers out and says where they were', () => {
    const r = readMarks('boom\r\n\x1b]6973;wb;exit;1\x07~/api $ ')
    expect(r.data).toBe('boom\r\n~/api $ ')
    expect(r.marks).toEqual([{ kind: 'exit', value: '1', at: 6 }])
  })
  it('reads the command line a start marker carries', () => {
    expect(readMarks('\x1b]6973;wb;start;bundle exec sidekiq\x07').marks[0]).toMatchObject({ kind: 'start', value: 'bundle exec sidekiq', at: 0 })
  })
  it('leaves other output alone', () => {
    const d = '\x1b]0;title\x07plain'
    expect(readMarks(d)).toEqual({ data: d, marks: [] })
  })
})
