import { useEffect, useRef, useState } from 'react'
import type { Session, SessionState } from '@shared/types'
import { activeSessionId, useStore } from '../store'
import { CaffeinateButton } from './CaffeinateControl'
import { Cup } from './Cup'

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  failed: 'Last run failed',
  idle: 'Idle',
}

/** The taskbar: ▌wb, 1 Today, 2 Local, the session tabs 3…n, then the cup and ⌘K. */
export function TopBar({ onNew }: { onNew: () => void }) {
  const { sessions, view, show, caf, local, wsPlace, closeWorkstream } = useStore()
  const inProfile = local?.services.filter((s) => s.def.profiles.includes(local.profile) && !s.transient) ?? []
  const up = inProfile.filter((s) => s.status === 'running').length
  const caffeinated = (s: Session) => {
    if (!caf || caf.mode === 'off') return null
    return (caf.scope === 'all' ? s.alive : caf.sessionId === s.id) ? caf.mode : null
  }
  const activeId = activeSessionId(view)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<string[]>([])
  const [moreOpen, setMoreOpen] = useState(false)

  // Tabs that don't fit go into the +N menu; the strip itself scrolls and fades at the edge.
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const measure = () => {
      const box = el.getBoundingClientRect()
      const ids = [...el.querySelectorAll<HTMLElement>('[data-session]')].filter((t) => t.getBoundingClientRect().right > box.right - 30).map((t) => t.dataset.session!)
      setHidden((cur) => (cur.join() === ids.join() ? cur : ids))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.addEventListener('scroll', measure)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', measure)
    }
  }, [sessions])

  // The current tab scrolls into view when it changes.
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

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
      <span className="tb-logo" aria-hidden="true">
        ▌wb
      </span>
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

      <div className="tabs" role="tablist" aria-label="Sessions" ref={strip}>
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
