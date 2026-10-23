import { useEffect, useRef, useState } from 'react'
import type { Session, SessionState } from '@shared/types'
import { activeSessionId, useOverlay, useStore } from '../store'
import { CaffeinateButton } from './CaffeinateControl'
import { SessionSideButtons } from './TaskSide'
import { Cup } from './Cup'
import { MemoryButton } from './Memory'
import { useShallow } from 'zustand/react/shallow'

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  failed: 'Last run failed',
  idle: 'Idle',
}

/** The taskbar: ▌wb, 1 Today, 2 Local, the session tabs 3…n, then the cup and ⌘K. */
export function TopBar({ onNew }: { onNew: () => void }) {
  const { sessions, view, show, caf, local, wsPlace, closeWorkstream } = useStore(useShallow((s) => ({ sessions: s.sessions, view: s.view, show: s.show, caf: s.caf, local: s.local, wsPlace: s.wsPlace, closeWorkstream: s.closeWorkstream })))
  const inProfile = local?.services.filter((s) => s.def.profiles.includes(local.profile) && !s.transient) ?? []
  const up = inProfile.filter((s) => s.status === 'running').length
  const caffeinated = (s: Session) => {
    if (!caf || caf.mode === 'off') return null
    return (caf.scope === 'all' ? s.alive : caf.sessionId === s.id) ? caf.mode : null
  }
  const activeId = activeSessionId(view)
  const activeSession = view.kind === 'session' ? sessions.find((s) => s.id === activeId) : undefined
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const strip_ = () => strip.current
  const [hidden, setHidden] = useState<string[]>([])
  const [moreOpen, setMoreOpen] = useState(false)
  useOverlay(moreOpen)

  // Overflow: the strip scrolls sideways (edge hover, wheel); +N counts tabs fully or partly out of view.
  const [fade, setFade] = useState({ l: false, r: false })
  // Re-measure only when tabs come, go or change width (title); state changes arrive far more often and move nothing.
  const tabsKey = sessions.map((s) => `${s.id}:${s.title}`).join('\n')
  const [edge, setEdge] = useState<'l' | 'r' | null>(null)
  const speed = useRef(0)
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const measure = () => {
      const box = el.getBoundingClientRect()
      const ids = [...el.querySelectorAll<HTMLElement>('[data-session]')]
        .filter((t) => {
          const r = t.getBoundingClientRect()
          return r.right > box.right + 0.5 || r.left < box.left - 0.5
        })
        .map((t) => t.dataset.session!)
      setHidden((cur) => (cur.join() === ids.join() ? cur : ids))
      const next = { l: el.scrollLeft > 0, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
      setFade((cur) => (cur.l === next.l && cur.r === next.r ? cur : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.addEventListener('scroll', measure)
    // A vertical wheel scrolls the strip sideways.
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', measure)
      el.removeEventListener('wheel', wheel)
    }
  }, [tabsKey])

  // Edge hover: within 56px of an edge with more tabs beyond it, scroll that way, faster nearer the edge.
  useEffect(() => {
    if (!edge) return
    let frame = 0
    const step = () => {
      const el = strip.current
      if (!el) return
      el.scrollLeft += (edge === 'l' ? -1 : 1) * speed.current
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [edge])
  const EDGE = 56
  const onStripMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const fromL = e.clientX - box.left
    const fromR = box.right - e.clientX
    const zone = fromL < EDGE && fade.l ? 'l' : fromR < EDGE && fade.r ? 'r' : null
    speed.current = zone ? 2 + ((EDGE - (zone === 'l' ? fromL : fromR)) / EDGE) * 12 : 0
    if (zone !== edge) setEdge(zone)
  }
  useEffect(() => {
    if ((edge === 'l' && !fade.l) || (edge === 'r' && !fade.r)) setEdge(null)
  }, [fade, edge])

  // The current tab scrolls fully into view, clear of the edge fades, whenever it changes or first appears
  // (a reopened session's tab arrives a moment after the switch).
  useEffect(() => {
    const strip = strip_()
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!strip || !tab) return
    const margin = 48
    const left = tab.offsetLeft - strip.offsetLeft
    const right = left + tab.offsetWidth
    if (left - margin < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - margin)
    else if (right + margin > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right + margin - strip.clientWidth
    // Titles change right after a tab opens (the task's name, then claude's), which changes its width.
  }, [activeId, sessions.map((x) => x.title).join('\n')])

  useEffect(() => {
    if (!moreOpen) return
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.tab-more-wrap') && setMoreOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [moreOpen])

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return
    const ids = sessions.map((s) => s.id).filter((id) => id !== dragId)
    ids.splice(ids.indexOf(targetId), 0, dragId)
    void window.workbench.reorderSessions(ids)
  }

  return (
    <header className="topbar">
      <MemoryButton />
      <nav className="places" aria-label="Workbench">
        <button className="seg-btn place" aria-current={view.kind === 'today' ? 'page' : undefined} onClick={() => show({ kind: 'today' })}>
          1 Today
        </button>
        <button className="seg-btn place" aria-current={view.kind === 'local' ? 'page' : undefined} title={inProfile.length ? `${up} of ${inProfile.length} services running` : undefined} onClick={() => show({ kind: 'local' })}>
          2 Local
          {inProfile.length > 0 && <span className="place-count">{` ${up}/${inProfile.length}`}</span>}
        </button>
        {wsPlace && (
          <span className="seg-btn place ws-place" aria-current={view.kind === 'workstream' ? 'page' : undefined}>
            <button className="ws-place-open" title={wsPlace.title} onClick={() => show({ kind: 'workstream', id: wsPlace.id })}>
              ◆ {wsPlace.title}
            </button>
            <button className="ws-place-close" aria-label="Close workstream" onClick={closeWorkstream}>
              ×
            </button>
          </span>
        )}
      </nav>

      <span className="divider" />

      <div
        className={`tabs${fade.l ? ' fade-l' : ''}${fade.r ? ' fade-r' : ''}${edge ? ` edge-${edge}` : ''}`}
        role="tablist"
        aria-label="Sessions"
        ref={strip}
        onMouseMove={onStripMove}
        onMouseLeave={() => setEdge(null)}
      >
        {sessions.map((s, i) => (
          <Tab
            key={s.id}
            n={i + 3}
            session={s}
            selected={s.id === activeId}
            cup={caffeinated(s)}
            dropBefore={dropBefore === s.id}
            onSelect={() => show({ kind: 'session', id: s.id })}
            onClose={() => void window.workbench.closeSession(s.id)}
            onDragStart={() => setDragId(s.id)}
            onDragOver={() => setDropBefore(s.id)}
            onDrop={() => {
              drop(s.id)
              setDragId(null)
              setDropBefore(null)
            }}
          />
        ))}
      </div>
      {hidden.length > 0 && (
        <span className="tab-more-wrap">
          <button className="seg-btn tab-more" title={`${hidden.length} more session${hidden.length > 1 ? 's' : ''}`} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            +{hidden.length} <span className="faint">▾</span>
          </button>
          {moreOpen && (
            <div className="tab-menu" role="menu">
              {sessions
                .filter((s) => hidden.includes(s.id))
                .map((s) => (
                  <button
                    key={s.id}
                    role="menuitem"
                    className={`tab-menu-item st-${s.state}${s.id === activeId ? ' on' : ''}`}
                    onClick={() => {
                      setMoreOpen(false)
                      show({ kind: 'session', id: s.id })
                    }}
                  >
                    <span className="tab-menu-n">{sessions.indexOf(s) + 3}</span>
                    {s.title}
                    <span className="faint">{STATE_LABEL[s.state].toLowerCase()}</span>
                  </button>
                ))}
            </div>
          )}
        </span>
      )}
      <button className="seg-btn tab-new" aria-label="New session" title="New session (s)" onClick={onNew}>
        +
      </button>

      <span className="tb-right">
        {activeSession && !activeSession.external && <SessionSideButtons session={activeSession} />}
        <CaffeinateButton />
        <button className="seg-btn kbar" title="Switch or run (⌘K)" onClick={() => useStore.getState().setPalette(true)}>
          ⌘K
        </button>
      </span>
    </header>
  )
}

interface TabProps {
  n: number
  session: Session
  selected: boolean
  dropBefore: boolean
  cup: 'on' | 'lid' | null
  onSelect(): void
  onClose(): void
  onDragStart(): void
  onDragOver(): void
  onDrop(): void
}

function Tab({ n, session: s, selected, dropBefore, cup, onSelect, onClose, onDragStart, onDragOver, onDrop }: TabProps) {
  const cls = ['seg-btn', 'tab', `st-${s.state}`, s.alive ? '' : 'dead', dropBefore ? 'drop-before' : ''].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      role="tab"
      data-session={s.id}
      aria-selected={selected}
      title={`${STATE_LABEL[s.state]} · ${s.title}\n${s.cwd}`}
      draggable
      onClick={onSelect}
      onAuxClick={(e) => e.button === 1 && onClose()}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver()
      }}
      onDrop={onDrop}
    >
      <span className="sr-only">{STATE_LABEL[s.state]}: </span>
      <span className="tab-title">
        {n <= 9 ? `${n} ` : ''}
        {s.title}
      </span>
      {cup && (
        <span className="tab-cup">
          <Cup mode={cup} size={13} label={cup === 'lid' ? 'Kept awake with lid closed' : 'Kept awake'} />
        </span>
      )}
      <button
        className="tab-close"
        aria-label={`Close ${s.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        ×
      </button>
    </div>
  )
}
