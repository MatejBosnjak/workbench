import { useEffect, useState, type ReactNode } from 'react'
import type { Limit } from '@shared/types'
import { activeSessionId, useStore } from '../store'
import { RunPrChip } from './RunPr'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (unix: number) => {
  const d = new Date(unix * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const sizeLabel = (n?: number) => (!n ? '' : n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`)

function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Re-renders on an interval; the value is read fresh on every render. */
function useNow(everyMs: number): number {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return Date.now()
}

function Meter({ pct, width, color }: { pct: number; width: number; color: string }) {
  return (
    <span className="meter" style={{ width }}>
      <span style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </span>
  )
}

export function StatusBar({ children }: { children?: ReactNode }) {
  const { sessions, view, status, hooks } = useStore()
  const now = useNow(30_000)
  const id = activeSessionId(view)
  const session = sessions.find((s) => s.id === id)
  const live = id ? status.sessions[id] : undefined
  const ctx = live?.contextPct
  const usage = status.usage
  // Limits older than their reset time are stale; claude reports fresh ones on the next turn.
  const fresh = (l?: Limit) => (l && (!l.resetsAt || l.resetsAt * 1000 > now) ? l : undefined)
  const five = fresh(usage?.fiveHour)
  const week = fresh(usage?.sevenDay)

  return (
    <footer className="statusbar">
      {session ? (
        <span className="sb-session">
          <span className={`sb-dot state-${session.state}`} />
          <span className="sb-title">{session.title}</span>
          {session.external && <span className="sb-tag">external</span>}
          <span className="mono muted">{age(now - session.startedAt)}</span>
        </span>
      ) : (
        <span className="sb-session muted">No session</span>
      )}

      {hooks && !(hooks.hooks && hooks.statusline) && (
        <button className="sb-chip warn" onClick={() => void window.workbench.installHooks()}>
          Hooks not installed · Install…
        </button>
      )}

      <RunPrChip />

      <span className="sb-group push" title="Context window of the active session">
        <span>Context</span>
        {ctx != null ? (
          <>
            <Meter pct={ctx} width={72} color={ctx >= 75 ? 'var(--bad)' : ctx >= 60 ? 'var(--accent)' : 'var(--ok)'} />
            <span className="mono" style={{ color: ctx >= 75 ? 'var(--bad)' : ctx >= 60 ? 'var(--warn)' : 'var(--text)' }}>
              {Math.round(ctx)}% {live?.contextSize ? <span className="muted">of {sizeLabel(live.contextSize)}</span> : null}
            </span>
            {ctx >= 60 && session?.alive && !session.external && (
              <button className="sb-compact" onClick={() => void window.workbench.writeSession(session.id, '/compact\r')}>
                /compact
              </button>
            )}
          </>
        ) : (
          <span className="mono muted">—</span>
        )}
      </span>

      <span className="sb-sep" />

      <span className="sb-group" title={usage ? `Plan usage, updated ${new Date(usage.at).toLocaleTimeString()}` : 'Plan usage'}>
        <span>5h limit</span>
        {five ? (
          <>
            <Meter pct={five.pct} width={72} color="var(--accent)" />
            <span className="mono">{Math.round(five.pct)}%</span>
            {five.resetsAt && <span className="muted">resets {clock(five.resetsAt)}</span>}
          </>
        ) : (
          <span className="mono muted">—</span>
        )}
      </span>

      <span className="sb-group" title={week?.resetsAt ? `Resets ${day(week.resetsAt)}` : undefined}>
        <span>Week</span>
        {week ? (
          <>
            <Meter pct={week.pct} width={48} color="var(--info)" />
            <span className="mono">{Math.round(week.pct)}%</span>
          </>
        ) : (
          <span className="mono muted">—</span>
        )}
      </span>

      {children}
    </footer>
  )
}
