import { useEffect, useState, type KeyboardEvent } from 'react'
import type { HeldNote } from '@shared/types'
import { activeSessionId, navigate, useOverlay, useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'

const minutes = (from: number, to = Date.now()) => Math.max(0, Math.floor((to - from) / 60_000))
const span = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`)
/** Past this the minutes turn amber: a nudge to look up, no banner. */
const LONG = 45

/** In the TopBar while focused: what it's for, how long so far (whole minutes, so it stays still), what it's holding. */
export function FocusChip() {
  const { held, intent, since } = useStore(useShallow((s) => ({ held: s.held, intent: s.focusIntent, since: s.focusSince })))
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const m = since ? minutes(since) : 0
  return (
    <button className="focus-chip" title={`Leave focus (⌘F or esc)${since ? ` · since ${new Date(since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}`} onClick={() => void useStore.getState().toggleFocus()}>
      <b>focus</b>
      {intent ? <span className="focus-intent"> · {intent}</span> : ' · this screen only'}
      <span className={m >= LONG ? 'warn-text' : undefined}> · {span(m)}</span> · {held} held
    </button>
  )
}

/** ⌘F: one optional line on what this focus is for; ⏎ starts (empty is fine), esc cancels. */
export function FocusAsk() {
  useOverlay(true)
  const [before] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => before?.focus(), [before])
  const [text, setText] = useState('')
  const close = () => useStore.getState().setFocusAsk(false)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'Enter') void useStore.getState().startFocus(text)
    else return
    e.preventDefault()
  }
  return (
    <div className="scrim" onMouseDown={close}>
      <div className="palette focus-ask" role="dialog" aria-label="Focus on this screen" onMouseDown={(e) => e.stopPropagation()}>
        <label className="palette-search">
          <span className="mono muted">focus on</span>
          <input autoFocus aria-label="What this focus is for" placeholder="what are you doing? (optional)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
          <kbd>esc</kbd>
        </label>
        <div className="palette-foot mono">
          <span>⏎ {text.trim() ? 'start' : 'start without a line'} · the rest of the app goes quiet, notifications wait</span>
          <span>esc cancel</span>
        </div>
      </div>
    </div>
  )
}

const GLYPH: Record<HeldNote['kind'], string> = { waiting: '●', github: '↩', finished: '○' }

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`
}

/** When focus ends: what was held, most urgent first. ⏎ goes to the first, esc stays on this screen. */
export function FocusDigest() {
  const { digest, ended } = useStore(useShallow((s) => ({ digest: s.digest, ended: s.focusEnded })))
  const shown = !!digest || !!ended
  useOverlay(shown)
  const close = () => useStore.setState({ digest: null, focusEnded: null })
  const go = (n: HeldNote) => {
    close()
    navigate(n.target)
  }
  const keepGoing = () => {
    const e = ended!
    close()
    void useStore.getState().startFocus(e.intent, e.since)
  }
  const later = () => {
    const st = useStore.getState()
    const s = st.sessions.find((x) => x.id === activeSessionId(st.view))
    void window.workbench.todos.add({ text: ended!.intent, due: null, sessionId: s?.id ?? null, sessionTitle: s?.title ?? null })
    close()
  }
  useEffect(() => {
    if (!shown) return
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Enter' && digest?.length) go(digest[0]!)
      else close()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [shown, digest])
  if (!shown) return null
  return (
    <div className="scrim" onMouseDown={close}>
      <div className="guard digest" role="dialog" aria-label={ended ? 'Focus ended' : 'While you were focused'} onMouseDown={(e) => e.stopPropagation()}>
        {ended && (
          <div className="digest-intent">
            <span className="digest-title">
              Focused {span(minutes(ended.since, ended.ended))} <span className="faint">on</span> {ended.intent}
            </span>
            <div className="guard-actions">
              <button className="primary" onClick={close}>
                ✓ done
              </button>
              <button className="ghost" onClick={keepGoing}>
                keep going
              </button>
              <button className="ghost" onClick={later} title="Adds it to Needs you, linked to this session">
                to-do for later
              </button>
            </div>
          </div>
        )}
        {digest && <span className={ended ? 'digest-sub' : 'digest-title'}>While you were focused</span>}
        {digest && <div className="digest-list">
          {digest.map((n, i) => (
            <button key={i} className={`digest-row ${n.kind}`} title={n.body} onClick={() => go(n)}>
              <span className="digest-glyph">{GLYPH[n.kind]}</span>
              <span className="digest-text">{n.title}</span>
              <span className="faint">{ago(n.at)}</span>
            </button>
          ))}
        </div>}
        {digest && <div className="guard-actions digest-actions">
          <button className="ghost" onClick={close}>
            Stay here <span className="faint">esc</span>
          </button>
          <button className="primary" onClick={() => go(digest[0]!)}>
            {digest.length > 1 ? 'Go to the top one' : 'Go there'} ⏎
          </button>
        </div>}
      </div>
    </div>
  )
}
