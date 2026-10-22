import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RecentSession, Session, SessionState } from '@shared/types'
import { useStore } from '../store'

interface Item {
  key: string
  group: 'Sessions' | 'Recently closed' | 'Actions'
  title: string
  detail: string
  state?: SessionState
  hint: string
  run(): void | Promise<void>
}

const STATE_TEXT: Record<SessionState, string> = { running: 'Running', waiting: 'Waiting for you', failed: 'Last run failed', idle: 'Idle' }
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** Every query word must appear somewhere in the text. */
const matches = (q: string, text: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w))

export function Palette({ onNew }: { onNew(pick: boolean): void }) {
  const { sessions, show, setPalette } = useStore()
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<RecentSession[]>([])
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.workbench.recentSessions().then(setRecent)
  }, [])

  const close = () => setPalette(false)

  const items = useMemo<Item[]>(() => {
    const open: Item[] = sessions.map((s: Session, i) => ({
      key: s.id,
      group: 'Sessions',
      title: s.title,
      detail: `${s.external ? 'External · ' : ''}${STATE_TEXT[s.state]} · ${home(s.cwd)}`,
      state: s.state,
      hint: i < 9 ? `⌘${i + 1}` : '↵ switch',
      run: () => show({ kind: 'session', id: s.id }),
    }))
    const closed: Item[] = recent.map((r) => ({
      key: r.id,
      group: 'Recently closed',
      title: r.title,
      detail: `${home(r.cwd)} · ${ago(r.lastEventAt)}`,
      hint: '↵ resume',
      run: async () => {
        await window.workbench.reopenSession(r.id)
        show({ kind: 'session', id: r.id })
      },
    }))
    const actions: Item[] = [
      { key: 'new', group: 'Actions', title: 'New session', detail: 'In the default folder', hint: '⌘T', run: () => onNew(false) },
      { key: 'new-in', group: 'Actions', title: 'New session in folder…', detail: 'Pick a folder', hint: '⇧⌘T', run: () => onNew(true) },
    ]
    return [...open, ...closed, ...actions].filter((it) => !query || matches(query, `${it.title} ${it.detail}`))
  }, [sessions, recent, query, show, onNew])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const runAt = (i: number) => {
    const it = items[i]
    if (!it) return
    close()
    void it.run()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1))
    else if (e.key === 'Enter') runAt(index)
    else return
    e.preventDefault()
  }

  let lastGroup: string | null = null
  return (
    <div className="scrim" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Switch or run" onMouseDown={(e) => e.stopPropagation()}>
        <label className="palette-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input autoFocus aria-label="Search" placeholder="Switch to a session, resume one, or start new" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          <kbd>esc</kbd>
        </label>
        <div className="palette-list" ref={list}>
          {items.length === 0 && <div className="palette-empty">Nothing matches</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            return (
              <div key={`${it.group}:${it.key}`}>
                {header && <div className="palette-group">{header}</div>}
                <button className="palette-item" data-active={i === index} onMouseEnter={() => setIndex(i)} onClick={() => runAt(i)}>
                  {it.state ? <span className={`sb-dot state-${it.state}`} /> : <span className="sb-dot" style={{ background: 'var(--line-heavy)' }} />}
                  <span className="pop-text">
                    <span>{it.title}</span>
                    <span className="pop-note">{it.detail}</span>
                  </span>
                  <span className="mono muted palette-hint">{i === index ? it.hint.replace(/^⌘\d$/, '↵ switch') : it.hint}</span>
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot mono">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
