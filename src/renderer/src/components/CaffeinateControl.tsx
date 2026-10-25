import { useEffect, useRef, useState } from 'react'
import { UNTIL_LABEL, UNTIL_NEXT, type CafHold, type CafMode, type CafUntil } from '@shared/caffeinate'
import type { CaffeinateState, Session } from '@shared/types'
import { activeSessionId, useOverlay, useStore } from '../store'
import { Cup } from './Cup'
import { useShallow } from 'zustand/react/shallow'

const OPTIONS: { mode: CafMode; label: string; key: string }[] = [
  { mode: 'off', label: 'Off', key: 'o' },
  { mode: 'on', label: 'Awake', key: 'a' },
  { mode: 'lid', label: 'Lid closed', key: 'l' },
]
const MODE_LABEL: Record<CafMode, string> = { off: 'Off', on: 'Awake', lid: 'Lid closed' }
const STATE: Record<Session['state'], string> = { running: 'working', waiting: 'waiting on you', idle: 'idle', failed: 'failed' }

const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The session's own hold, if it has one (auto included). */
export const holdOf = (caf: CaffeinateState | null, sessionId: string): CafHold | undefined => caf?.holds.find((h) => h.sessionId === sessionId)

/**
 * The 44px cup in the taskbar: what the Mac is doing, with how many sessions hold it. Click or `c` opens the popover:
 * the holds (× lets one go, its until cycles), the open session's Off / Awake / Lid closed (`o` / `a` / `l`) and until,
 * and the Auto rule. Esc closes.
 */
export function CaffeinateButton() {
  const { caf, setCaf, view, sessions, show, cafOpen: open, setCafOpen: setOpen } = useStore(
    useShallow((s) => ({ caf: s.caf, setCaf: s.setCaf, view: s.view, sessions: s.sessions, show: s.show, cafOpen: s.cafOpen, setCafOpen: s.setCafOpen })),
  )
  const root = useRef<HTMLSpanElement>(null)
  useOverlay(open)

  useEffect(() => {
    void window.workbench.getCaffeinate().then(setCaf)
    return window.workbench.onCaffeinate(setCaf)
  }, [setCaf])

  const sessionId = activeSessionId(view)
  const session = sessions.find((s) => s.id === sessionId)
  const set = (id: string, mode: CafMode, until?: CafUntil) => void window.workbench.setCaffeinate(id, mode, until).then(setCaf)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const pick = session && OPTIONS.find((o) => o.key === e.key)
      if (e.key === 'Escape' || pick) {
        e.preventDefault()
        e.stopPropagation()
        if (pick && session) set(session.id, pick.mode)
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
  const n = caf.holds.length
  const label = `Caffeinate: ${MODE_LABEL[caf.mode]}${n ? ` · held by ${n} session${n > 1 ? 's' : ''}` : ''}`
  const via = caf.mode === 'lid' ? (caf.lidVia === 'amphetamine' ? ' · via Amphetamine' : ' · clamshell') : ''

  return (
    <span className="cafb" ref={root}>
      <button className={`cafb-btn caf-${caf.mode}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={`${label} · c`} onClick={() => setOpen(!open)}>
        <Cup mode={caf.mode} size={28} />
        {n > 0 && <span className="cafb-n">{n}</span>}
      </button>
      {open && (
        <div className="cafpop" role="dialog" aria-label="Caffeinate">
          <span className="cafpop-head">
            <span>
              Caffeinate <span className="faint">· c</span>
            </span>
            <span className={`cafpop-now caf-${caf.mode}`}>
              {caf.mode === 'off' ? 'sleeps as usual' : MODE_LABEL[caf.mode]}
              {via}
            </span>
          </span>

          <span className="cafpop-sec">Holding the Mac · {n}</span>
          {n === 0 && <span className="cafpop-empty">Nothing; the Mac sleeps as usual.</span>}
          {caf.holds.map((h) => {
            const s = sessions.find((x) => x.id === h.sessionId)
            const i = sessions.findIndex((x) => x.id === h.sessionId)
            return (
              <div key={h.sessionId} className="cafpop-hold">
                <Cup mode={h.mode} size={22} />
                <button className="cafpop-hold-t" title="Open the session" onClick={() => (s && show({ kind: 'session', id: s.id }), setOpen(false))}>
                  <span className="cafpop-label">
                    {i >= 0 && i + 3 <= 9 ? `${i + 3} ` : ''}
                    {s?.title ?? 'closed session'}
                  </span>
                  <span className="cafpop-note">
                    {s && <span className={`cafpop-dot st-${s.state}`} />}
                    {s ? `${s.external ? 'terminal · ' : ''}${STATE[s.state]}` : ''} · {ago(h.since)}
                    {h.auto && ' · auto'}
                  </span>
                </button>
                {h.auto ? (
                  <span className="cafpop-until faint">while working</span>
                ) : (
                  <button className="cafpop-until" title="Change when it lets go" onClick={() => set(h.sessionId, h.mode, UNTIL_NEXT[h.until])}>
                    {UNTIL_LABEL[h.until]} ▾
                  </button>
                )}
                {h.auto ? (
                  <span />
                ) : (
                  <button className="cafpop-x" aria-label="Let go" title="Let go" onClick={() => set(h.sessionId, 'off')}>
                    ×
                  </button>
                )}
              </div>
            )
          })}

          {session && (
            <>
              <span className="cafpop-sec">This session · {session.title}</span>
              <HoldControls caf={caf} sessionId={session.id} onSet={setCaf} />
            </>
          )}
          {caf.note && <span className="cafpop-msg">{caf.note}</span>}
          <label className="cafpop-foot">
            <input type="checkbox" checked={caf.auto} onChange={(e) => void window.workbench.setCaffeinateAuto(e.target.checked).then(setCaf)} />
            <span>
              Auto: hold while any session is working
              <span className="cafpop-note">terminal sessions too; lets go when it stops or waits on you</span>
            </span>
          </label>
        </div>
      )}
    </span>
  )
}

/** Off / Awake / Lid closed and until, for one session's own hold. */
function HoldControls({ caf, sessionId, onSet }: { caf: CaffeinateState; sessionId: string; onSet: (c: CaffeinateState) => void }) {
  const mine = holdOf(caf, sessionId)
  const mineMode: CafMode = mine && !mine.auto ? mine.mode : 'off'
  const set = (mode: CafMode, until?: CafUntil) => void window.workbench.setCaffeinate(sessionId, mode, until).then(onSet)
  const lidNote = caf.lidAvailable ? null : `Lid closed unavailable: ${caf.lidSetup ?? 'needs power and Amphetamine, or an external display'}`
  return (
    <>
      <span className="cafpop-modes" role="radiogroup" aria-label="This session">
        {OPTIONS.map((o) => (
          <button
            key={o.mode}
            role="radio"
            aria-checked={o.mode === mineMode}
            className={`caf-${o.mode}`}
            title={o.mode === 'lid' ? (lidNote ?? 'Keeps running with the lid shut · on power') : undefined}
            onClick={() => set(o.mode)}
          >
            <Cup mode={o.mode} size={18} />
            {o.label} <span className="faint">{o.key}</span>
          </button>
        ))}
      </span>
      {mineMode !== 'off' && mine && (
        <span className="cafpop-untils" role="radiogroup" aria-label="Until">
          until
          {(['done', 'closed', 'manual'] as const).map((u) => (
            <button key={u} role="radio" aria-checked={mine.until === u} onClick={() => set(mineMode, u)}>
              {UNTIL_LABEL[u].replace('until ', '')}
            </button>
          ))}
        </span>
      )}
      {mine?.auto && <span className="cafpop-empty">Held by Auto while it works.</span>}
      {mineMode === 'lid' && lidNote && <span className="cafpop-msg">{lidNote}; using Awake.</span>}
    </>
  )
}

/** The session bar's small cup: this session's hold, and a small popover with just its controls (`o` / `a` / `l`, Esc). */
export function SessionCup({ session }: { session: Session }) {
  const { caf, setCaf } = useStore(useShallow((s) => ({ caf: s.caf, setCaf: s.setCaf })))
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useOverlay(open)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const pick = OPTIONS.find((o) => o.key === e.key)
      if (e.key === 'Escape' || pick) {
        e.preventDefault()
        e.stopPropagation()
        if (pick) void window.workbench.setCaffeinate(session.id, pick.mode).then(setCaf)
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
  const h = holdOf(caf, session.id)
  const mode: CafMode = h?.mode ?? 'off'
  const label = h ? `${MODE_LABEL[h.mode]} · ${h.auto ? 'while working (auto)' : UNTIL_LABEL[h.until]}` : 'Not keeping the Mac awake'
  return (
    <span className="sbar-cup-wrap" ref={root}>
      <button className={`sbar-cup caf-${mode}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`Keep the Mac awake for this session: ${label}`} title={label} onClick={() => setOpen(!open)}>
        <Cup mode={mode} size={18} />
      </button>
      {open && caf && (
        <div className="cafpop sbar-cafpop" role="dialog" aria-label="Keep the Mac awake for this session">
          <span className="cafpop-head">Keep the Mac awake</span>
          <HoldControls caf={caf} sessionId={session.id} onSet={setCaf} />
        </div>
      )}
    </span>
  )
}
