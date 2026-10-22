import type { SessionState } from '@shared/types'

/** How a hook event moves a session's tab state; null leaves it as is. */
export function nextState(current: SessionState, event: string): SessionState | null {
  switch (event) {
    case 'SessionStart':
    case 'Stop':
    case 'SessionEnd':
      return 'idle'
    case 'UserPromptSubmit':
      return 'running'
    case 'Notification':
      return 'waiting'
    case 'PostToolUse':
      // A tool ran, so a permission prompt was answered.
      return current === 'waiting' ? 'running' : null
    default:
      return null
  }
}
