import { useEffect, useRef, useState } from 'react'
import type { CaffeinateState } from '@shared/types'
import { activeSessionId, useStore } from '../store'
import { Cup } from './Cup'

const OPTIONS: { mode: CaffeinateState['mode']; label: string; short: string; note: string }[] = [
  { mode: 'off', label: 'Off', short: 'Sleep ok', note: 'The Mac sleeps as usual' },
  { mode: 'on', label: 'Awake', short: 'Awake', note: 'While the session is running' },
  { mode: 'lid', label: 'Awake, lid closed', short: 'Lid closed', note: 'Keeps running with the lid shut' },
]

export function CaffeinateControl() {
  const { caf, setCaf, view } = useStore()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.workbench.getCaffeinate().then(setCaf)
    return window.workbench.onCaffeinate(setCaf)
  }, [setCaf])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  if (!caf) return null
  const current = OPTIONS.find((o) => o.mode === caf.mode)!
  const sessionId = activeSessionId(view) ?? caf.sessionId
  const set = (mode: CaffeinateState['mode'], scope = caf.scope) => void window.workbench.setCaffeinate(mode, scope, sessionId).then(setCaf)
  const label = `${current.label} (${caf.scope === 'all' ? 'all sessions' : 'this session'})`

  return (
    <div className="caf" ref={root}>
      <button className={`caf-btn${caf.mode !== 'off' ? ' on' : ''}${open ? ' open' : ''}`} aria-expanded={open} aria-label={`Caffeinate: ${label}`} title={label} onClick={() => setOpen(!open)}>
        <Cup mode={caf.mode} size={16} knockout={caf.mode === 'off' ? 'var(--chrome)' : 'var(--accent-bg)'} />
        <span>{current.short}</span>
      </button>
      {open && (
        <div className="popover caf-pop" role="dialog" aria-label="Caffeinate">
          <span className="pop-label">Keep the Mac awake</span>
          {OPTIONS.map((o) => {
            const disabled = o.mode === 'lid' && !caf.lidAvailable
            const note =
              o.mode !== 'lid'
                ? o.note
                : caf.lidVia === 'amphetamine'
                  ? `${o.note} · via Amphetamine`
                  : caf.lidVia === 'clamshell'
                    ? `${o.note} · clamshell mode (power + external display)`
                    : `Needs power, and Amphetamine with Power Protect${caf.lidSetup ? ` (${caf.lidSetup})` : ''} or an external display`
            return (
              <button key={o.mode} role="radio" aria-checked={o.mode === caf.mode} className={`pop-item${o.mode === caf.mode ? ' on' : ''}`} disabled={disabled} title={disabled ? note : undefined} onClick={() => set(o.mode)}>
                <Cup mode={o.mode} size={18} knockout="var(--popover)" />
                <span className="pop-text">
                  <span>{o.label}</span>
                  <span className="pop-note">{note}</span>
                </span>
                <span className="check">{o.mode === caf.mode ? '✓' : ''}</span>
              </button>
            )
          })}
          <div className="pop-foot">
            <span>{caf.note ?? 'Applies to'}</span>
            <div className="seg" role="radiogroup" aria-label="Scope" style={{ marginLeft: 'auto' }}>
              {(['session', 'all'] as const).map((sc) => (
                <button key={sc} role="radio" aria-checked={caf.scope === sc} onClick={() => set(caf.mode, sc)}>
                  {sc === 'session' ? 'This session' : 'All sessions'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
