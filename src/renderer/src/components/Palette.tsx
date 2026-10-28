import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RecentSession, Session, SessionState } from '@shared/types'
import { prRepo } from '@shared/git'
import { rootOf } from '@shared/workstream'
import { THEMES } from '@shared/theme'
import { navigate, openWorkstream, useOverlay, useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'

interface Item {
  key: string
  group: 'Run in session' | 'To-do' | 'Sessions' | 'Recently closed' | 'Workstreams' | 'Tasks' | 'PRs' | 'Actions' | 'Themes'
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

/** Typing these into a session rewrites the global defaults in ~/.claude/settings.json; the picker covers them. */
const BLOCKED = /^\/(model|effort)\b/
/** Searchable groups that only show once something is typed. */
const SEARCH_ONLY = new Set<Item['group']>(['Workstreams', 'Tasks', 'PRs', 'Themes'])
const PER_GROUP = 8

/** Every query word must appear somewhere in the text. */
const matches = (q: string, text: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w))

export function Palette({ onNew }: { onNew(pick: boolean): void }) {
  useOverlay(true)
  const { sessions, show, setPalette, view, tasks, git, setTodayTab, setPeekTask, theme, setTheme, setCapture } = useStore(
    useShallow((s) => ({ sessions: s.sessions, show: s.show, setPalette: s.setPalette, view: s.view, tasks: s.tasks, git: s.git, setTodayTab: s.setTodayTab, setPeekTask: s.setPeekTask, theme: s.theme, setTheme: s.setTheme, setCapture: s.setCapture })),
  )
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
      ...THEMES.map((t): Item => ({
        key: `theme:${t.id}`,
        group: 'Themes',
        title: `Theme: ${t.name}`,
        detail: t.id === theme ? `${t.note} · current` : t.note,
        hint: '↵ switch',
        run: () => setTheme(t.id),
      })),
    ]
    const mine = (tasks?.tasks ?? []).filter((t) => !t.context)
    const roots = [...new Set(mine.filter((t) => t.parentId || t.milestone).map((t) => rootOf(t.id, tasks!.tasks)))]
    const streams: Item[] = roots.map((id) => {
      const t = tasks!.tasks.find((x) => x.id === id)
      const n = mine.filter((x) => rootOf(x.id, tasks!.tasks) === id && x.id !== id).length
      return { key: id, group: 'Workstreams', title: t?.title ?? id, detail: `${t?.milestone ? 'Milestone · ' : ''}${t?.projectName ?? ''} · ${n} of your tasks`, hint: '↵ open', run: () => openWorkstream(id) }
    })
    const taskItems: Item[] = mine.map((t) => ({
      key: t.id,
      group: 'Tasks',
      title: t.title,
      detail: `${t.statusName} · ${t.projectName}`,
      hint: '↵ preview',
      run: () => {
        setTodayTab('tasks')
        setPeekTask(t.id)
        show({ kind: 'today' })
      },
    }))
    const prItems: Item[] = [
      ...(git?.mine ?? []).map((p) => ({ p, kind: 'git' as const })),
      ...(git?.reviews ?? []).filter((p) => !p.authorBot).map((p) => ({ p, kind: 'reviews' as const })),
    ].map(({ p, kind }) => ({
      key: p.id,
      group: 'PRs',
      title: p.title,
      detail: `${prRepo(p)} · ${kind === 'git' ? 'yours' : `review · ${p.author}`} · ${p.branch}`,
      hint: '↵ show',
      run: () => navigate({ kind, prId: p.id }),
    }))
    const target = view.kind === 'session' ? sessions.find((x) => x.id === view.id && !x.external && x.alive) : undefined
    const slash: Item[] = query.startsWith('/')
      ? [
          BLOCKED.test(query)
            ? { key: 'slash', group: 'Run in session', title: `${query.split(' ')[0]} isn't sent from here`, detail: 'It would change your global defaults in ~/.claude/settings.json. Use the picker in the status bar.', hint: '', run: () => {} }
            : target
              ? { key: 'slash', group: 'Run in session', title: `Run ${query}`, detail: `In ${target.title}`, hint: '↵ run', run: () => void window.workbench.writeSession(target.id, `${query}\r`) }
              : { key: 'slash', group: 'Run in session', title: `Run ${query}`, detail: 'Open a running session first', hint: '', run: () => {} },
        ]
      : []
    // "todo call the bank fri" hands the rest to the to-do capture line.
    const todo = /^(todo|to-do)\b\s*(.*)$/i.exec(query)
    const todoItem: Item[] = todo
      ? [{ key: 'todo', group: 'To-do', title: todo[2] ? `Add to-do: ${todo[2]}` : 'Add a to-do…', detail: 'To Needs you · ⌥⌘T from anywhere', hint: '↵ add', run: () => setCapture({ text: todo[2] ?? '' }) }]
      : []
    const q = query.startsWith('/') ? '' : query
    const all = [...open, ...closed, ...streams, ...taskItems, ...prItems, ...actions].filter((it) => (q ? matches(q, `${it.title} ${it.detail}`) : !SEARCH_ONLY.has(it.group)))
    const counts = new Map<string, number>()
    const capped = all.filter((it) => {
      if (!SEARCH_ONLY.has(it.group)) return true
      const n = (counts.get(it.group) ?? 0) + 1
      counts.set(it.group, n)
      return n <= PER_GROUP
    })
    return [...slash, ...todoItem, ...(query.startsWith('/') || todo ? [] : capped)]
  }, [sessions, recent, query, show, onNew, tasks, git, view, setTodayTab, setPeekTask, theme, setTheme, setCapture])

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
          <input autoFocus aria-label="Search" placeholder="Sessions, workstreams, tasks, PRs — or type / to run a command" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
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
