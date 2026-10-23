import { useEffect, useState, type ReactNode } from 'react'
import type { Limit } from '@shared/types'
import { activeSessionId, useOverlay, useStore } from '../store'
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

export const SHORTCUTS: [string, string][] = [
  ['j / k', 'move'],
  ['⏎', 'open'],
  ['tab', 'next pane'],
  ['r', 'run app'],
  ['s', 'new session'],
  ['/', 'filter'],
  ['g', 'my git'],
  ['v', 'my reviews'],
  ['1–9', 'switch tab'],
  ['c', 'caffeinate'],
  ['esc', 'back'],
  ['?', 'all shortcuts'],
]

/** The ⌨ cell: all shortcuts in a popover on hover or focus (`?` toggles it). */
function Shortcuts() {
  const open = useStore((s) => s.keysOpen)
  useOverlay(open)
  return (
    <span className={`sb-keys${open ? ' open' : ''}`} tabIndex={0} aria-label="Keyboard shortcuts">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <rect x="2.5" y="6" width="19" height="12" />
        <path d="M6 10h1M10 10h1M14 10h1M18 10h0M7 14h10" />
      </svg>
      <span className="kbpop" role="tooltip">
        <span className="kbpop-title">Shortcuts</span>
        <span className="kbpop-grid">
          {SHORTCUTS.map(([k, what]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="kbpop-key">{k}</span>
              <span>{what}</span>
            </span>
          ))}
        </span>
        <span className="kbpop-note">Keys work when no terminal or text field has focus.</span>
      </span>
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
  const pct = (n?: number | null) => (n == null ? '—' : `${Math.round(n)}%`)

  return (
    <footer className="statusbar">
      <Shortcuts />
      <span className="sb-session" title={session ? `${session.title} · ${session.cwd}` : undefined}>
        {session ? (
          <>
            <span className={`dot-${session.state}`}>●</span>
            <span className="sb-title">{session.title}</span>
            {session.external && <span className="faint">ext</span>}
            <span className="faint">{age(now - session.startedAt)}</span>
          </>
        ) : (
          <span className="faint">no session</span>
        )}
      </span>

      <span className="sb-middle">
        <RunPrChip />
        {hooks && !(hooks.hooks && hooks.statusline) && (
          <button className="sb-chip warn" title="Workbench hooks aren't installed, so tab states and limits don't update. Click to install." onClick={() => void window.workbench.installHooks()}>
            ⚠ hooks
          </button>
        )}
      </span>

      <span className="sb-meters">
        <span className="sb-meter" title={ctx != null ? `Context ${Math.round(ctx)}%${live?.contextSize ? ` of ${sizeLabel(live.contextSize)}` : ''}${ctx >= 60 ? ' · /compact suggested' : ''}` : 'Context of the active session'}>
          <span className="sb-k">ctx</span>
          <Meter pct={ctx ?? 0} width={48} color={ctx != null && ctx >= 75 ? 'var(--bad)' : ctx != null && ctx >= 60 ? 'var(--warn)' : 'var(--ok)'} />
          <span className="sb-v" style={{ color: ctx != null && ctx >= 75 ? 'var(--bad)' : undefined }}>
            {pct(ctx)}
          </span>
          {ctx != null && ctx >= 60 && session?.alive && !session.external && (
            <button className="sb-compact" title="Run /compact in this session" onClick={() => void window.workbench.writeSession(session.id, '/compact\r')}>
              /compact
            </button>
          )}
        </span>
        <span className="sb-meter" title={five ? `5h limit ${Math.round(five.pct)}%${five.resetsAt ? ` · resets ${clock(five.resetsAt)}` : ''}` : '5h limit'}>
          <span className="sb-k">5h</span>
          <Meter pct={five?.pct ?? 0} width={48} color="var(--accent)" />
          <span className="sb-v">{pct(five?.pct)}</span>
          <span className="faint sb-reset">{five?.resetsAt ? `↻${clock(five.resetsAt)}` : ''}</span>
        </span>
        <span className="sb-meter" title={week ? `Week ${Math.round(week.pct)}%${week.resetsAt ? ` · resets ${day(week.resetsAt)}` : ''}` : 'Week limit'}>
          <span className="sb-k">wk</span>
          <Meter pct={week?.pct ?? 0} width={48} color="var(--info)" />
          <span className="sb-v">{pct(week?.pct)}</span>
        </span>
      </span>

      {children}
    </footer>
  )
}
