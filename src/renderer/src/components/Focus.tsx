import { useEffect } from 'react'
import type { HeldNote } from '@shared/types'
import { navigate, useOverlay, useStore } from '../store'

/** In the TopBar while focused: what focus does, how much it's holding, how to leave. */
export function FocusChip() {
  const held = useStore((s) => s.held)
  return (
    <button className="focus-chip" title="Leave focus (⌘F or esc)" onClick={() => void useStore.getState().toggleFocus()}>
      <b>focus</b> · this screen only · {held} held · ⌘F to leave
    </button>
  )
}

const GLYPH: Record<HeldNote['kind'], string> = { waiting: '●', github: '↩', finished: '○' }

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`
}

/** When focus ends: what was held, most urgent first. ⏎ goes to the first, esc stays on this screen. */
export function FocusDigest() {
  const digest = useStore((s) => s.digest)
  useOverlay(!!digest)
  const close = () => useStore.getState().setDigest(null)
  const go = (n: HeldNote) => {
    close()
    navigate(n.target)
  }
  useEffect(() => {
    if (!digest) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Enter') go(digest[0]!)
      else close()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [digest])
  if (!digest) return null
  return (
    <div className="scrim" onMouseDown={close}>
      <div className="guard digest" role="dialog" aria-label="While you were focused" onMouseDown={(e) => e.stopPropagation()}>
        <span className="digest-title">While you were focused</span>
        <div className="digest-list">
          {digest.map((n, i) => (
            <button key={i} className={`digest-row ${n.kind}`} title={n.body} onClick={() => go(n)}>
              <span className="digest-glyph">{GLYPH[n.kind]}</span>
              <span className="digest-text">{n.title}</span>
              <span className="faint">{ago(n.at)}</span>
            </button>
          ))}
        </div>
        <div className="guard-actions digest-actions">
          <button className="ghost" onClick={close}>
            Stay here <span className="faint">esc</span>
          </button>
          <button className="primary" onClick={() => go(digest[0]!)}>
            {digest.length > 1 ? 'Go to the top one' : 'Go there'} ⏎
          </button>
        </div>
      </div>
    </div>
  )
}
