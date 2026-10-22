import { useState } from 'react'
import type { Session, SessionState } from '@shared/types'
import { activeSessionId, useStore } from '../store'
import { Cup } from './Cup'

const STATE_LABEL: Record<SessionState, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  failed: 'Last run failed',
  idle: 'Idle',
}

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

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return
    const ids = sessions.map((s) => s.id).filter((id) => id !== dragId)
    ids.splice(ids.indexOf(targetId), 0, dragId)
    void window.workbench.reorderSessions(ids)
  }

  return (
    <header className="topbar">
      <nav className="places" aria-label="Workbench">
        <button className="place" aria-current={view.kind === 'today' ? 'page' : undefined} onClick={() => show({ kind: 'today' })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
          Today
        </button>
        <button className="place" aria-current={view.kind === 'local' ? 'page' : undefined} onClick={() => show({ kind: 'local' })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>
          Local
          {up > 0 && (
            <span className="place-count" title={`${up} of ${inProfile.length} services running`}>
              {up}/{inProfile.length}
            </span>
          )}
        </button>
        {wsPlace && (
          <span className="place ws-place" aria-current={view.kind === 'workstream' ? 'page' : undefined}>
            <button className="ws-place-open" title={wsPlace.title} onClick={() => show({ kind: 'workstream', id: wsPlace.id })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z" /></svg>
              {wsPlace.title}
            </button>
            <button className="ws-place-close" aria-label="Close workstream" onClick={closeWorkstream}>
              ×
            </button>
          </span>
        )}
      </nav>

      <span className="divider" />

      <div className="tabs" role="tablist" aria-label="Sessions">
        <span className="tabs-label">SESSIONS</span>
        {sessions.map((s) => (
          <Tab
            key={s.id}
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
        <button className="icon-btn" aria-label="New session" title="New session (⌘T)" onClick={onNew}>
          +
        </button>
      </div>

      <button className="kbar" onClick={() => useStore.getState().setPalette(true)}>
        Switch or run <kbd>⌘K</kbd>
      </button>
    </header>
  )
}

interface TabProps {
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

function Tab({ session: s, selected, dropBefore, cup, onSelect, onClose, onDragStart, onDragOver, onDrop }: TabProps) {
  const cls = ['tab', s.alive ? '' : 'dead', dropBefore ? 'drop-before' : ''].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      role="tab"
      aria-selected={selected}
      title={`${s.title}\n${s.cwd}`}
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
      <span className={`tab-line state-${s.state}`} role="img" aria-label={STATE_LABEL[s.state]} />
      <span className="tab-title">{s.title}</span>
      {cup && (
        <span className="tab-cup">
          <Cup mode={cup} size={13} knockout={selected ? 'var(--line-soft)' : 'var(--chrome)'} label={cup === 'lid' ? 'Kept awake with lid closed' : 'Kept awake'} />
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
