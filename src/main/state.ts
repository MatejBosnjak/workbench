import type { SessionState } from '@shared/types'

/** How a hook event moves a session's tab state; null leaves it as is. */
export function nextState(current: SessionState, event: string, notificationType?: unknown): SessionState | null {
  switch (event) {
    case 'SessionStart':
    case 'Stop':
    case 'SessionEnd':
      return 'idle'
    case 'UserPromptSubmit':
      return 'running'
    case 'Notification':
      // claude's "waiting for your input" reminder a minute after every turn: the turn is done, nothing is asked.
      return notificationType === 'idle_prompt' ? null : 'waiting'
    case 'PostToolUse':
      // A tool ran inside a turn: a permission prompt was answered (or input already marked it idle).
      return current === 'waiting' || current === 'idle' ? 'running' : null
    default:
      return null
  }
}

/**
 * Typing Enter or Esc into a waiting session answers its prompt. Declining fires no hook, so without
 * this the tab would say "waiting" until the next turn. If the tool then runs, PostToolUse marks it running.
 */
export function stateAfterInput(current: SessionState, data: string): SessionState | null {
  return current === 'waiting' && (data === '\r' || data === '\x1b') ? 'idle' : null
}
