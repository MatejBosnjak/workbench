import type { CSSProperties } from 'react'
import { SESSION_SIGILS } from '@shared/sessionColor'
import type { Session, SessionState } from '@shared/types'

/** The session's colour as a CSS custom property, for its tab, menu row, session bar and status bar. */
export const sessionStyle = (s: Session) => ({ '--sc': `var(--sess-${s.color})` }) as CSSProperties

/** The session's mark: a thin bar in its colour (CSS), or on MU/TH/UR its block sigil. */
export function SessionMark({ session }: { session: Session }) {
  return (
    <span className="sess-mark" aria-hidden="true">
      <span className="sess-sigil">{SESSION_SIGILS[session.color % SESSION_SIGILS.length]}</span>
    </span>
  )
}

/** State without colour: ? waiting, ··· running, ! failed, nothing when idle. */
export function StateGlyph({ state }: { state: SessionState }) {
  if (state === 'waiting') return <span className="st-glyph st-q" aria-hidden="true">?</span>
  if (state === 'running') return <span className="st-glyph st-run" aria-hidden="true">···</span>
  if (state === 'failed') return <span className="st-glyph st-fail" aria-hidden="true">!</span>
  return null
}
