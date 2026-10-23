import { useEffect, useRef, useState } from 'react'
import { EFFORTS, MODELS, MODES, modelFromId, type AgentSettings, type ApplyResult } from '@shared/agent'
import { activeSessionId, useStore } from '../store'

const RESULT: Record<ApplyResult, string> = {
  restarted: 'Restarted the session with --resume and the new flags',
  pending: 'Restarts with the new flags when the current turn ends',
  saved: 'Applies the next time the session starts',
}

const MODE_ALIASES: Record<string, string> = { default: 'manual' }

export function Picker() {
  const { sessions, view, status } = useStore()
  const [open, setOpen] = useState(false)
  const [defaults, setDefaults] = useState<AgentSettings | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const id = activeSessionId(view)
  const session = sessions.find((s) => s.id === id && !s.external)
  const live = session ? status.sessions[session.id] : undefined

  useEffect(() => {
    void window.workbench.getDefaults().then(setDefaults)
  }, [])

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

  // What's in effect: live statusline/hook data first, then what the session was started with, then defaults.
  const base = session ?? defaults
  const model = (session && modelFromId(live?.modelId)?.value) ?? base?.model ?? null
  const effort = (session && live?.effort) ?? base?.effort ?? null
  const liveMode = live?.permissionMode ? (MODE_ALIASES[live.permissionMode] ?? live.permissionMode) : undefined
  const mode = (session && liveMode) ?? base?.permissionMode ?? null

  const current: AgentSettings = { model, effort, permissionMode: mode }

  const apply = async (change: Partial<AgentSettings>) => {
    if (!session) {
      const next = { ...current, ...change }
      await window.workbench.setDefaults(next)
      setDefaults(next)
      setNote('Saved as the default for new sessions')
      return
    }
    setBusy(true)
    setNote('Applying…')
    try {
      setNote(RESULT[await window.workbench.configureSession(session.id, change)])
    } catch (e) {
      setNote(`Failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async () => {
    await window.workbench.setDefaults(current)
    setDefaults(current)
    setNote('Saved as the default for new sessions')
  }

  const modelShort = MODELS.find((m) => m.value === model)?.short ?? live?.model ?? 'default'
  const modeLabel = MODES.find((m) => m.value === mode)?.label ?? mode ?? 'default'

  return (
    <div className="picker" ref={root}>
      <button
        className={`picker-btn${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-label="Change agent, model and effort"
        onClick={() => {
          setOpen(!open)
          setNote(null)
        }}
      >
        <span className="picker-agent">◆</span>
        {modelShort}
        <span className="muted">·</span>
        <span style={{ color: 'var(--warn)' }}>{effort ?? 'default'}</span>
        <span className="muted">·</span>
        <span style={{ color: 'var(--text-3)' }}>{modeLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
      </button>

      {open && (
        <div className="popover picker-pop" role="dialog" aria-label="Agent and model">
          <span className="pop-label">Agent</span>
          <div className="agent-row">
            <button className="agent on">Claude Code</button>
            <button className="agent" disabled title="Not in v1">Codex</button>
          </div>

          <span className="pop-label">Model</span>
          {MODELS.map((m) => (
            <button key={m.value} className={`pop-item${m.value === model ? ' on' : ''}`} disabled={busy} onClick={() => void apply({ model: m.value })}>
              <span className="check">{m.value === model ? '✓' : ''}</span>
              <span className="pop-text">
                <span>{m.label}</span>
                <span className="pop-note">{m.note}</span>
              </span>
            </button>
          ))}

          <span className="pop-label">Effort</span>
          <div className="seg" role="radiogroup" aria-label="Effort">
            {EFFORTS.map((e) => (
              <button key={e} role="radio" aria-checked={e === effort} disabled={busy} onClick={() => void apply({ effort: e })}>
                {e}
              </button>
            ))}
          </div>

          <span className="pop-label">Permissions</span>
          <div className="seg" role="radiogroup" aria-label="Permission mode">
            {MODES.map((m) => (
              <button key={m.value} role="radio" aria-checked={m.value === mode} disabled={busy} onClick={() => void apply({ permissionMode: m.value })}>
                {m.label}
              </button>
            ))}
          </div>

          <div className="pop-foot">
            <span>{note ?? (session ? 'Applies to this session' : 'No session open: sets the defaults')}</span>
            {session && (
              <button className="ghost" onClick={() => void makeDefault()}>
                Make default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
