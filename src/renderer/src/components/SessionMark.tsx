import type { CSSProperties } from 'react'
import { SESSION_SIGILS } from '@shared/sessionColor'
import type { Session } from '@shared/types'

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

/** What a session's glyph means, for its tooltip; null when it shows none. */
export function stateTip(s: Session): string | null {
  if (s.state === 'waiting') return s.ask ? `Asks you: ${s.ask}` : 'Waiting for you'
  if (s.state === 'running') return 'Running'
  if (s.state === 'failed') return 'Last run failed: claude exited with an error'
  if (s.background?.length) return `Waiting on its own background work, wakes by itself:\n${s.background.map((t) => `· ${t}`).join('\n')}`
  return null
}

/** State without colour: ? waiting, ··· running, ! failed, ◷ background work out, nothing when idle. Hover says which. */
export function StateGlyph({ session: s }: { session: Session }) {
  const tip = stateTip(s) ?? undefined
  if (s.state === 'waiting') return <span className="st-glyph st-q" role="img" aria-label={tip} title={tip}>?</span>
  if (s.state === 'running') return <span className="st-glyph st-run" role="img" aria-label={tip} title={tip}>···</span>
  if (s.state === 'failed') return <span className="st-glyph st-fail" role="img" aria-label={tip} title={tip}>!</span>
  if (s.background?.length) return <span className="st-glyph st-bg" role="img" aria-label={tip} title={tip}>◷</span>
  return null
}
