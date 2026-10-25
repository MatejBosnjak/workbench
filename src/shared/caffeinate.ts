import type { Session } from './types'

export type CafMode = 'off' | 'on' | 'lid'
/** When a hold lets go: the session's turn ends, its tab closes, or I release it. */
export type CafUntil = 'done' | 'closed' | 'manual'

/** One session keeping the Mac awake. Auto holds come from the Auto rule: a session that's working. */
export interface CafHold {
  sessionId: string
  mode: 'on' | 'lid'
  until: CafUntil
  since: number
  auto: boolean
}

export const UNTIL_LABEL: Record<CafUntil, string> = { done: 'until done', closed: 'until tab closes', manual: 'until I stop' }
export const UNTIL_NEXT: Record<CafUntil, CafUntil> = { done: 'closed', closed: 'manual', manual: 'done' }

const working = (s: Session) => s.alive && (s.state === 'running' || s.state === 'waiting')

/**
 * Holds after a sessions update: a closed tab drops its hold, and an "until done" hold drops once its session stops
 * working (it may be set on an idle session; it then waits for a turn to start and end).
 */
export function settleHolds(holds: CafHold[], sessions: Session[], wasWorking: Set<string>): { holds: CafHold[]; released: CafHold[] } {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const keep: CafHold[] = []
  const released: CafHold[] = []
  for (const h of holds) {
    const s = byId.get(h.sessionId)
    const finished = h.until === 'done' && s && wasWorking.has(s.id) && !working(s)
    ;(!s || finished ? released : keep).push(h)
  }
  return { holds: keep, released }
}

/** The Auto rule: every session that's running (not one waiting on me) holds the Mac, unless it has a hold of its own. */
export function autoHolds(sessions: Session[], manual: CafHold[], since: Map<string, number>): CafHold[] {
  return sessions
    .filter((s) => s.alive && s.state === 'running' && !manual.some((h) => h.sessionId === s.id))
    .map((s) => ({ sessionId: s.id, mode: 'on', until: 'done', since: since.get(s.id) ?? Date.now(), auto: true }))
}

/** The Mac follows the strongest hold. */
export const strongest = (holds: CafHold[]): CafMode => (holds.some((h) => h.mode === 'lid') ? 'lid' : holds.length ? 'on' : 'off')
