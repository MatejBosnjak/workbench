import { describe, expect, it } from 'vitest'
import { parseMessage } from './signal-server'
import { nextState, stateAfterInput } from './state'

describe('nextState', () => {
  it('follows a turn with a permission prompt', () => {
    let s = nextState('idle', 'SessionStart')!
    s = nextState(s, 'UserPromptSubmit') ?? s
    expect(s).toBe('running')
    s = nextState(s, 'PostToolUse') ?? s
    expect(s).toBe('running')
    s = nextState(s, 'Notification') ?? s
    expect(s).toBe('waiting')
    s = nextState(s, 'PostToolUse') ?? s
    expect(s).toBe('running')
    s = nextState(s, 'Stop') ?? s
    expect(s).toBe('idle')
  })

  it('an idle-input notification marks a finished session as waiting', () => {
    expect(nextState('idle', 'Notification')).toBe('waiting')
  })

  it('answering a prompt by keyboard leaves waiting; a tool run then marks it running', () => {
    expect(stateAfterInput('waiting', '\x1b')).toBe('idle')
    expect(stateAfterInput('waiting', '\r')).toBe('idle')
    expect(stateAfterInput('waiting', 'j')).toBeNull()
    expect(stateAfterInput('running', '\r')).toBeNull()
    expect(nextState('idle', 'PostToolUse')).toBe('running')
  })

  it('ignores unknown events', () => {
    expect(nextState('running', 'PreCompact')).toBeNull()
  })
})

describe('parseMessage', () => {
  it('reads the header and body', () => {
    expect(parseMessage('hook abc\n{"session_id":"s","hook_event_name":"Stop","cwd":"/"}')).toEqual({
      kind: 'hook',
      wbId: 'abc',
      payload: { session_id: 's', hook_event_name: 'Stop', cwd: '/' },
    })
  })

  it('treats an empty id as external', () => {
    expect(parseMessage('statusline \n{"session_id":"s","cwd":"/"}')?.wbId).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseMessage('hook x\nnot json')).toBeNull()
    expect(parseMessage('other x\n{"session_id":"s"}')).toBeNull()
    expect(parseMessage('hook x\n{"cwd":"/"}')).toBeNull()
  })
})
