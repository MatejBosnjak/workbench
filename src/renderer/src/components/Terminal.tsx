import { memo, useRef } from 'react'
import type { Session } from '@shared/types'
import { TermView } from './TermView'

// Claude prefixes its terminal title with a status glyph (✳ or a spinner frame).
const cleanTitle = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, '').trim()

/** A claude session's terminal. */
export const Terminal = memo(function Terminal({ session, active }: { session: Session; active: boolean }) {
  const open = (size: { cols: number; rows: number }) => void window.workbench.openSession(session.id, size)
  const lastTitle = useRef('')
  return (
    <TermView
      id={session.id}
      active={active}
      alive={session.alive}
      open={open}
      revive={open}
      scrollback={10_000}
      sheet
      exitMessage={`${session.state === 'failed' ? 'claude exited with an error' : 'claude exited'} · press Enter to resume`}
      onTitle={(raw) => {
        const title = cleanTitle(raw)
        if (title && title !== lastTitle.current && title !== session.title) {
          lastTitle.current = title
          void window.workbench.setTitle(session.id, title, true)
        }
      }}
    />
  )
})
