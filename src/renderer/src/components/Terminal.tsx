import type { Session } from '@shared/types'
import { TermView } from './TermView'

// Claude prefixes its terminal title with a status glyph (✳ or a spinner frame).
const cleanTitle = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, '').trim()

/** A claude session's terminal. */
export function Terminal({ session, active }: { session: Session; active: boolean }) {
  const open = (size: { cols: number; rows: number }) => void window.workbench.openSession(session.id, size)
  let lastTitle = ''
  return (
    <TermView
      id={session.id}
      active={active}
      alive={session.alive}
      open={open}
      revive={open}
      exitMessage={`${session.state === 'failed' ? 'claude exited with an error' : 'claude exited'} · press Enter to resume`}
      onTitle={(raw) => {
        const title = cleanTitle(raw)
        if (title && title !== lastTitle && title !== session.title) {
          lastTitle = title
          void window.workbench.setTitle(session.id, title)
        }
      }}
    />
  )
}
