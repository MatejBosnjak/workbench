import { useEffect, useRef } from 'react'
import type { CaffeinateState } from '@shared/types'
import { activeSessionId, useOverlay, useStore } from '../store'
import { Cup } from './Cup'

const OPTIONS: { mode: CaffeinateState['mode']; label: string; key: string; note: string }[] = [
  { mode: 'off', label: 'Off', key: 'o', note: 'The Mac sleeps as usual' },
  { mode: 'on', label: 'Awake', key: 'a', note: 'While this session runs' },
  { mode: 'lid', label: 'Lid closed', key: 'l', note: 'Keeps running with the lid shut · on power' },
]

/** The 44px cup in the taskbar; click or `c` opens the popover, `o` / `a` / `l` pick, Esc closes. */
export function CaffeinateButton() {
  const { caf, setCaf, view, cafOpen: open, setCafOpen: setOpen } = useStore()
  const root = useRef<HTMLSpanElement>(null)
  useOverlay(open)

  useEffect(() => {
    void window.workbench.getCaffeinate().then(setCaf)
    return window.workbench.onCaffeinate(setCaf)
  }, [setCaf])

  const sessionId = activeSessionId(view) ?? caf?.sessionId ?? null
  const set = (mode: CaffeinateState['mode'], scope = caf?.scope ?? 'session') => void window.workbench.setCaffeinate(mode, scope, sessionId).then(setCaf)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const pick = OPTIONS.find((o) => o.key === e.key)
      if (e.key === 'Escape' || pick) {
        e.preventDefault()
        e.stopPropagation()
        if (pick && !(pick.mode === 'lid' && !caf?.lidAvailable)) set(pick.mode)
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  })

  if (!caf) return null
  const current = OPTIONS.find((o) => o.mode === caf.mode)!
  const label = `Caffeinate: ${current.label} (${caf.scope === 'all' ? 'all sessions' : 'this session'})`
  const lidNote =
    caf.lidVia === 'amphetamine'
      ? 'Keeps running with the lid shut · via Amphetamine'
      : caf.lidVia === 'clamshell'
        ? 'Keeps running with the lid shut · clamshell'
        : `Unavailable: ${caf.lidSetup ?? 'needs power and Amphetamine, or an external display'}`

  return (
    <span className="cafb" ref={root}>
      <button className={`cafb-btn caf-${caf.mode}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={`${label} · c`} onClick={() => setOpen(!open)}>
        <Cup mode={caf.mode} size={28} />
      </button>
      {open && (
        <div className="cafpop" role="dialog" aria-label="Caffeinate">
          <span className="cafpop-head">
            Caffeinate <span className="faint">· c</span>
          </span>
          {OPTIONS.map((o) => {
            const disabled = o.mode === 'lid' && !caf.lidAvailable
            return (
              <button key={o.mode} role="radio" aria-checked={o.mode === caf.mode} className={`cafpop-item caf-${o.mode}`} disabled={disabled} onClick={() => (set(o.mode), setOpen(false))}>
                <Cup mode={o.mode} size={30} />
                <span className="cafpop-text">
                  <span className="cafpop-label">{o.label}</span>
                  <span className="cafpop-note">{o.mode === 'lid' ? lidNote : o.note}</span>
                </span>
                <span className="faint">{o.key}</span>
              </button>
            )
          })}
          {caf.note && <span className="cafpop-msg">{caf.note}</span>}
          <span className="cafpop-foot">
            applies to
            <span className="seg-switch" role="radiogroup" aria-label="Scope">
              {(['session', 'all'] as const).map((sc) => (
                <button key={sc} role="radio" aria-checked={caf.scope === sc} onClick={() => set(caf.mode, sc)}>
                  {sc === 'session' ? 'this session' : 'all'}
                </button>
              ))}
            </span>
          </span>
        </div>
      )}
    </span>
  )
}
