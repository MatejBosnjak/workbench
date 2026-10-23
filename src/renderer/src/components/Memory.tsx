import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { memoryColor, shortSize, type MemoryRow, type MemorySnapshot } from '@shared/memory'
import { useOverlay, useStore } from '../store'

const size = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`)
const PRESSURE = { normal: 'pressure normal', warn: 'pressure elevated', critical: 'pressure critical' } as const

/**
 * ▌wb in the taskbar: the ▌ blends from light purple to bright red as total memory (Workbench, sessions and
 * local services) climbs through steps of 1/12 of the Mac's RAM. Click for the breakdown.
 */
export function MemoryButton() {
  const [snap, setSnap] = useState<MemorySnapshot | null>(null)
  const [open, setOpen] = useState(false)
  useOverlay(open)

  useEffect(() => {
    void window.workbench.memory.snapshot().then((s) => s && setSnap(s))
    return window.workbench.memory.onChanged(setSnap)
  }, [])

  useEffect(() => {
    if (!open) return
    void window.workbench.memory.watch(true)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const click = (e: MouseEvent) => !(e.target as HTMLElement).closest('.mem-wrap') && setOpen(false)
    window.addEventListener('keydown', key)
    window.addEventListener('mousedown', click)
    return () => {
      void window.workbench.memory.watch(false)
      window.removeEventListener('keydown', key)
      window.removeEventListener('mousedown', click)
    }
  }, [open])

  const color = snap ? memoryColor(snap.totalMb, snap.ramMb, snap.pressure) : 'var(--accent)'
  return (
    <span className="mem-wrap">
      <button
        className={`mem-btn${open ? ' open' : ''}`}
        aria-expanded={open}
        title={snap ? `Memory ${size(snap.totalMb)} of ${size(snap.ramMb)} · ${PRESSURE[snap.pressure]}` : 'Memory'}
        onClick={() => setOpen(!open)}
      >
        <span className="mem-glyph" style={{ color, textShadow: `0 0 8px color-mix(in oklab, ${color} 45%, transparent)` }} aria-hidden="true">
          ▌
        </span>
        wb
        {snap && <span className="mem-short">{shortSize(snap.totalMb)}</span>}
      </button>
      {open && snap && <MemoryPopover snap={snap} close={() => setOpen(false)} />}
    </span>
  )
}

function MemoryPopover({ snap, close }: { snap: MemorySnapshot; close: () => void }) {
  const { show, mounted, sessions } = useStore(useShallow((s) => ({ show: s.show, mounted: s.mounted, sessions: s.sessions })))
  const total = snap.totalMb || 1
  const workbench = snap.workbench.map((r) => (r.id === 'window' ? { ...r, detail: `UI · ${mounted.size} of ${sessions.length} terminals mounted` } : r))
  const growth = snap.trend.length > 1 ? snap.trend.at(-1)!.mb - snap.trend[0]!.mb : 0
  const minutes = snap.trend.length > 1 ? Math.round((snap.trend.at(-1)!.at - snap.trend[0]!.at) / 60_000) : 0

  return (
    <div className="mem-pop" role="dialog" aria-label="Memory">
      <div className="mem-head">
        <div className="mem-total">
          <span className="muted">Memory</span>
          <span>
            <span className="mem-big">{(snap.totalMb / 1024).toFixed(2)}</span> <span className="muted">GB</span>
          </span>
          <span className="faint">
            of {Math.round(snap.ramMb / 1024)} GB on this Mac · <span className={snap.pressure === 'normal' ? '' : snap.pressure === 'warn' ? 'warn-text' : 'bad-text'}>{PRESSURE[snap.pressure]}</span>
          </span>
        </div>
        <div className="mem-trend">
          <Sparkline points={snap.trend.map((p) => p.mb)} />
          <span className="faint">
            {minutes ? `last ${minutes} min · ` : 'collecting · '}
            <span className={growth > 100 ? 'warn-text' : ''}>
              {growth >= 0 ? '↗ +' : '↘ '}
              {size(Math.abs(growth))}
            </span>
          </span>
        </div>
      </div>

      <div className="mem-stack">
        <div className="mem-stack-bar">
          <span style={{ width: `${(snap.workbenchMb / total) * 100}%`, background: 'var(--accent)' }} />
          <span style={{ width: `${(snap.sessionsMb / total) * 100}%`, background: 'var(--info)' }} />
          <span style={{ width: `${(snap.servicesMb / total) * 100}%`, background: 'var(--ok)' }} />
        </div>
        <div className="mem-legend">
          <span><span style={{ color: 'var(--accent)' }}>■</span> Workbench <b>{size(snap.workbenchMb)}</b></span>
          <span><span style={{ color: 'var(--info)' }}>■</span> Sessions <b>{size(snap.sessionsMb)}</b></span>
          <span><span style={{ color: 'var(--ok)' }}>■</span> Local services <b>{size(snap.servicesMb)}</b></span>
        </div>
      </div>

      <Section title="Workbench" mb={snap.workbenchMb} color="--accent" rows={workbench}
        action={(r) => (r.closable ? <button className="link-btn" onClick={() => void window.workbench.pane.closeIdle()}>close idle</button> : null)} />
      <Section title="Sessions" mb={snap.sessionsMb} color="--info" rows={snap.sessions} aside="by size · incl. child processes"
        open={(r) => { show({ kind: 'session', id: r.id }); close() }} />
      {snap.services.length > 0 && <Section title="Local services" mb={snap.servicesMb} color="--ok" rows={snap.services} />}

      <div className="mem-foot faint">
        <span>updates every 5s while open</span>
        <span>click a session to open it · esc closes</span>
      </div>
    </div>
  )
}

function Section({ title, mb, color, rows, aside, action, open }: {
  title: string
  mb: number
  color: string
  rows: MemoryRow[]
  aside?: string
  action?: (r: MemoryRow) => React.ReactNode
  open?: (r: MemoryRow) => void
}) {
  const max = Math.max(1, ...rows.map((r) => r.mb))
  return (
    <div className="mem-sec">
      <span className="mem-sec-title">
        <span className="mem-swatch" style={{ background: `var(${color})` }} />
        {title} <b>{size(mb)}</b>
      </span>
      {aside && <span className="mem-sec-aside faint">{aside}</span>}
      {rows.length === 0 && <div className="faint">none running</div>}
      {rows.map((r) => {
        const Row = open ? 'button' : 'div'
        return (
          <Row key={r.id} className={`mem-row${open ? ' click' : ''}`} onClick={open ? () => open(r) : undefined}>
            <span className="mem-name">
              <span>{r.name}</span>
              {r.detail && <span className="faint">{r.detail}</span>}
            </span>
            <span className="mem-extra">{r.growthMb ? <span className="warn-text">↗ {size(r.growthMb)}</span> : action?.(r)}</span>
            <span className="meter mem-meter">
              <span style={{ width: `${(r.mb / max) * 100}%`, background: `linear-gradient(90deg, color-mix(in srgb, var(${color}) 35%, transparent), var(${color}))` }} />
            </span>
            <span className={`mem-mb${r.growthMb ? ' warn-text' : ''}`}>{size(r.mb)}</span>
          </Row>
        )
      })}
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <svg width="300" height="30" aria-hidden="true" />
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const span = Math.max(hi - lo, 50) // a flat line stays flat instead of magnifying noise
  const xy = points.map((p, i) => `${((i / (points.length - 1)) * 300).toFixed(1)},${(28 - ((p - lo) / span) * 24).toFixed(1)}`).join(' ')
  return (
    <svg width="300" height="30" viewBox="0 0 300 30" aria-hidden="true">
      <polyline points={`${xy} 300,30 0,30`} fill="color-mix(in srgb, var(--text-3) 10%, transparent)" stroke="none" />
      <polyline points={xy} fill="none" stroke="var(--text-3)" strokeWidth="1.5" />
    </svg>
  )
}
