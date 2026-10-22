import { useEffect, useMemo, useState } from 'react'
import { groupTasks, type Task, type TaskLine, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import type { GitSnapshot } from '@shared/git'
import { needsReply } from '@shared/git'
import { openWorkstream, useStore, type TodayTab } from '../store'
import { DraftPanel } from './DraftPanel'
import { GitView, ReviewsView } from './GitView'
import { TaskPreview } from './TaskPreview'

// Productive workflow status colours, approximated with theme tokens.
const STATUS_COLORS = ['var(--muted)', 'var(--muted)', 'var(--info)', 'var(--teal)', 'var(--ok)', 'var(--warn)', 'var(--bad)', 'var(--violet)', 'var(--accent)', 'var(--faint)', 'var(--link)']
export const statusColor = (t: Task) => STATUS_COLORS[Number(t.statusColorId ?? 0) % STATUS_COLORS.length]!

type Chip = 'all' | 'started' | 'due' | 'sessions'
const CHIPS: { id: Chip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'started', label: 'Started' },
  { id: 'due', label: 'Due this week' },
  { id: 'sessions', label: 'With sessions' },
]

const isBug = (t: Task) => /bug/i.test(t.projectName)
const dueSoon = (t: Task) => !!t.dueDate && new Date(t.dueDate).getTime() - Date.now() < 7 * 86_400_000

export function dueLabel(d: string | null): { text: string; late: boolean } | null {
  if (!d) return null
  const date = new Date(`${d}T23:59:59`)
  return { text: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), late: date.getTime() < Date.now() }
}

export function ago(iso: string | number | null): string {
  if (!iso) return '—'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 60) return `${Math.max(0, m)}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function StatusGlyph({ task, size = 14 }: { task: Task; size?: number }) {
  const color = statusColor(task)
  const started = task.statusCategory === 2
  return (
    <span className="glyph" title={task.statusName} role="img" aria-label={task.statusName} style={{ width: size, height: size, borderColor: color, borderStyle: started ? 'solid' : 'dashed', background: started ? 'transparent' : `color-mix(in srgb, ${color} 14%, transparent)` }}>
      {started && <span style={{ background: color }} />}
    </span>
  )
}

export function TodayView({ snapshot, git, active }: { snapshot: TasksSnapshot | null; git: GitSnapshot | null; active: boolean }) {
  const { todayTab: tab, setTodayTab, draft } = useStore()
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  const today = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const replies = git ? git.mine.filter((p) => p.conversations.some((c) => needsReply(c, git.viewer, git.seen))).length : 0
  const tabs: { id: TodayTab; label: string; count: number | null }[] = [
    { id: 'tasks', label: 'My tasks', count: snapshot?.fetchedAt ? snapshot.tasks.filter((t) => !t.context).length : null },
    { id: 'git', label: 'My git', count: git?.fetchedAt ? git.mine.length : null },
    { id: 'reviews', label: 'My reviews', count: git?.fetchedAt ? git.reviews.filter((p) => !p.authorBot).length : null },
  ]
  const src = tab === 'tasks' ? snapshot : git
  const refresh = () => void (tab === 'tasks' ? window.workbench.tasks.refresh() : window.workbench.git.refresh())

  return (
    <div className="today" hidden={!active}>
      <main className="today-main">
        <div className="today-head">
          <h1>
            Today <span>{today}</span>
          </h1>
          <div className="seg today-tabs" role="tablist" aria-label="Today views">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTodayTab(t.id)}>
                {t.label} {t.count !== null && <span className="mono muted">{t.count}</span>}
                {t.id === 'git' && replies > 0 && (
                  <span className="tab-alert">
                    {replies} repl{replies === 1 ? 'y' : 'ies'} needed
                  </span>
                )}
              </button>
            ))}
          </div>
          {src && (
            <span className="today-sync muted">
              {src.error ? (
                <span className="bad-text" title={src.error}>
                  Couldn't load: {src.error.slice(0, 80)}
                </span>
              ) : src.loading ? (
                'Refreshing…'
              ) : (
                `Updated ${ago(src.fetchedAt)}`
              )}
              <button className="ghost" disabled={src.loading} onClick={refresh}>
                Refresh
              </button>
            </span>
          )}
        </div>
        {tab === 'tasks' && snapshot && <TasksTab snapshot={snapshot} />}
        {tab === 'git' && git && <GitView git={git} tasks={snapshot} />}
        {tab === 'reviews' && git && <ReviewsView git={git} tasks={snapshot} />}
      </main>
      {draft && git ? <DraftPanel target={draft} git={git} /> : tab === 'tasks' && snapshot && <Peek snapshot={snapshot} />}
    </div>
  )
}

function Peek({ snapshot }: { snapshot: TasksSnapshot }) {
  const { peekTask, setPeekTask } = useStore()
  const task = snapshot.tasks.find((t) => t.id === peekTask)
  return task ? <TaskPreview task={task} snapshot={snapshot} onClose={() => setPeekTask(null)} /> : null
}

function TasksTab({ snapshot }: { snapshot: TasksSnapshot }) {
  const sessions = useStore((s) => s.sessions)
  const { peekTask: peek, setPeekTask: setPeek } = useStore()
  const [chip, setChip] = useState<Chip>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('workbench.collapsed') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggle = (key: string) => {
    const next = new Set(collapsed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCollapsed(next)
    try {
      localStorage.setItem('workbench.collapsed', JSON.stringify([...next]))
    } catch {
      // not important
    }
  }

  const bySession = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const linksByTask = useMemo(() => {
    const m = new Map<string, NonNullable<TasksSnapshot>['links']>()
    for (const l of snapshot.links ?? []) m.set(l.taskId, [...(m.get(l.taskId) ?? []), l])
    return m
  }, [snapshot.links])
  const live = (taskId: string) =>
    (linksByTask.get(taskId) ?? []).some((l) => {
      const s: Session | undefined = bySession.get(l.sessionId)
      return s?.alive && (s.state === 'running' || s.state === 'waiting')
    })

  const groups = useMemo(() => {
    const all = snapshot.tasks ?? []
    const keep = (t: Task) =>
      t.context ||
      chip === 'all' ||
      (chip === 'started' && t.statusCategory === 2) ||
      (chip === 'due' && dueSoon(t)) ||
      (chip === 'sessions' && (linksByTask.get(t.id)?.length ?? 0) > 0)
    return groupTasks(all.filter(keep))
  }, [snapshot.tasks, chip, linksByTask])

  const mine = snapshot.tasks.filter((t) => !t.context)
  const counts: Record<Chip, number> = {
    all: mine.length,
    started: mine.filter((t) => t.statusCategory === 2).length,
    due: mine.filter(dueSoon).length,
    sessions: mine.filter((t) => linksByTask.has(t.id)).length,
  }

  // Lines under a collapsed milestone/parent are hidden until the next line at its depth or above.
  const visible = (lines: TaskLine[]) => {
    const out: TaskLine[] = []
    let hideBelow: number | null = null
    for (const l of lines) {
      if (hideBelow !== null && l.depth > hideBelow) continue
      hideBelow = null
      out.push(l)
      if (collapsed.has(`t:${l.task.id}`)) hideBelow = l.depth
    }
    return out
  }
  const hasKids = (lines: TaskLine[], i: number) => (lines[i + 1]?.depth ?? -1) > lines[i]!.depth

  return (
    <>
        <div className="chips">
          {CHIPS.map((c) => (
            <button key={c.id} className={`fchip${chip === c.id ? ' on' : ''}`} onClick={() => setChip(c.id)}>
              {c.label} <span className="mono">{counts[c.id]}</span>
            </button>
          ))}
        </div>

        {snapshot.fetchedAt === null && snapshot.loading && <div className="today-empty muted">Loading your tasks from Productive…</div>}
        {snapshot.fetchedAt !== null && groups.length === 0 && <div className="today-empty muted">Nothing here.</div>}

        <div className="groups">
          {groups.map((g) => {
            const open = !collapsed.has(`p:${g.id}`)
            const lines = visible(g.lines)
            return (
              <section key={g.id} className="group">
                <button className="group-head" aria-expanded={open} onClick={() => toggle(`p:${g.id}`)}>
                  <span className="chev">{open ? '▾' : '▸'}</span>
                  <span className="group-name">{g.name}</span>
                  <span className="mono muted">{g.count}</span>
                </button>
                {open &&
                  lines.map((l) => {
                    const t = l.task
                    const i = g.lines.indexOf(l)
                    const folded = collapsed.has(`t:${t.id}`)
                    const kids = hasKids(g.lines, i)
                    const n = linksByTask.get(t.id)?.length ?? 0
                    const due = dueLabel(t.dueDate)
                    if (l.header) {
                      return (
                        <div key={t.id} className="task-row ctx" style={{ paddingLeft: 12 + l.depth * 22 }}>
                          <button className="fold" aria-expanded={!folded} aria-label="Collapse" onClick={() => toggle(`t:${t.id}`)}>
                            {folded ? '▸' : '▾'}
                          </button>
                          {t.milestone && <Diamond />}
                          <button className="task-title ctx-open" title="Open workstream" onClick={() => openWorkstream(t.id)}>
                            {t.title}
                          </button>
                          <span className="muted ctx-note">{l.header === 'milestone' ? 'milestone · not mine' : 'filtered out'}</span>
                        </div>
                      )
                    }
                    return (
                      <div key={t.id} className={`task-row${t.statusCategory === 2 ? ' started' : ''}${peek === t.id ? ' on' : ''}`} style={{ paddingLeft: 12 + l.depth * 22 }}>
                        <span className="fold-slot">
                          {kids && (
                            <button className="fold" aria-expanded={!folded} aria-label="Collapse" onClick={() => toggle(`t:${t.id}`)}>
                              {folded ? '▸' : '▾'}
                            </button>
                          )}
                        </span>
                        <button className="task-main" onClick={() => setPeek(peek === t.id ? null : t.id)}>
                          <StatusGlyph task={t} />
                          <span className="task-title-wrap">
                            {t.milestone && <Diamond />}
                            {isBug(t) && <BugIcon />}
                            <span className="task-title">{t.title}</span>
                          </span>
                          <span className="task-list muted">{l.list ?? ''}</span>
                          <span className={`task-due mono${due?.late ? ' late' : ''}`}>{due?.text ?? ''}</span>
                          <span className="task-sess mono" aria-label={n ? `${n} linked sessions` : 'No sessions'}>
                            {live(t.id) && <span className="live-dot" />}
                            {n || ''}
                          </span>
                        </button>
                      </div>
                    )
                  })}
              </section>
            )
          })}
        </div>
    </>
  )
}

export function Diamond() {
  return (
    <svg className="diamond" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-label="Milestone" role="img">
      <path d="M12 3l9 9-9 9-9-9z" />
    </svg>
  )
}

function BugIcon() {
  return (
    <svg className="bug" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" role="img" aria-label="Bug">
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <path d="M12 6V4M8 10H4M20 10h-4M8 15H4M20 15h-4" />
    </svg>
  )
}
