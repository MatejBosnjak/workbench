import { describe, expect, it } from 'vitest'
import { transcriptTail } from './linker'

describe('transcriptTail', () => {
  it('keeps user and assistant text, newest last, within the cap', () => {
    const lines = [
      { type: 'user', message: { role: 'user', content: 'first ask' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'did a thing' }, { type: 'tool_use' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      { type: 'system', message: { content: 'ignored' } },
      { type: 'user', message: { content: 'second ask' } },
    ].map((l) => JSON.stringify(l))
    expect(transcriptTail(lines.join('\n') + '\nnot json')).toBe('User: first ask\n\nClaude: did a thing\n\nUser: second ask\n\n')
    expect(transcriptTail(lines.join('\n'), 20)).toBe('\n\nUser: second ask\n\n'.slice(-20))
  })
})
