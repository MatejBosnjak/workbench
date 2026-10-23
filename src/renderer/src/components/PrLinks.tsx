import { useEffect, useState, type CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Pr } from '@shared/git'
import { statusVivid, type Task, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useOverlay, useStore } from '../store'

export interface LinkedSession {
  id: string
  title: string
  /** Its tab is open and claude is alive. */
  alive: boolean
  open: boolean
  state: string
  at: number
}

/** The PR's tasks (from its branch and description) and the sessions linked to them or working on the PR, live first. */
export function prLinks(
  pr: Pr | undefined,
  prUrl: string,
  tasks: TasksSnapshot | null,
  sessions: Session[],
  focus: Record<string, { url: string }>,
): { tasks: Task[]; sessions: LinkedSession[] } {
  const prTasks: Task[] = pr ? (tasks?.tasks ?? []).filter((t) => !t.context && pr.taskRefs.includes(t.id)) : []
  const ids = new Set(prTasks.map((t) => t.id))
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const found = new Map<string, LinkedSession>()
  for (const l of tasks?.links ?? []) {
    if (!ids.has(l.taskId) || !l.session) continue
    const s = byId.get(l.sessionId)
    found.set(l.sessionId, {
      id: l.sessionId,
      title: s?.title ?? l.session.title,
      alive: !!s?.alive,
      open: !!s,
      state: s?.state ?? l.session.state,
      at: s?.lastEventAt ?? l.session.lastEventAt,
    })
  }
  // Sessions working on this frontend PR, linked to a task or not.
  for (const [id, f] of Object.entries(focus)) {
    const s = byId.get(id)
    if (f.url === prUrl && s && !found.has(id)) found.set(id, { id, title: s.title, alive: s.alive, open: true, state: s.state, at: s.lastEventAt })
  }
  return { tasks: prTasks, sessions: [...found.values()].sort((a, b) => Number(live(b)) - Number(live(a)) || b.at - a.at) }
}

const live = (s: LinkedSession) => s.alive && (s.state === 'running' || s.state === 'waiting')
const STATE_COLOR: Record<string, string> = { running: 'var(--info)', waiting: 'var(--accent)', failed: 'var(--bad)' }

/**
 * Task ▾ and Session ▾ in the GitHub pane's strip: the PR's tasks (from its branch and description) and the
 * sessions linked to them or working on this PR, each a click away. While a menu is open the page is a still
 * (useOverlay), so the menu isn't hidden behind the native view.
 */
export function PrLinks({ pr, prUrl }: { pr: Pr | undefined; prUrl: string }) {
  const { tasks, sessions, runpr, show, setTodayTab, setPeekTask } = useStore(
    useShallow((s) => ({ tasks: s.tasks, sessions: s.sessions, runpr: s.runpr, show: s.show, setTodayTab: s.setTodayTab, setPeekTask: s.setPeekTask })),
  )
  const [menu, setMenu] = useState<'task' | 'session' | null>(null)
  useOverlay(menu !== null)

  useEffect(() => {
    if (!menu) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    const click = (e: MouseEvent) => !(e.target as HTMLElement).closest('.prl') && setMenu(null)
    window.addEventListener('keydown', key)
    window.addEventListener('mousedown', click)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('mousedown', click)
    }
  }, [menu])
  useEffect(() => setMenu(null), [prUrl])

  const { tasks: prTasks, sessions: linked } = prLinks(pr, prUrl, tasks, sessions, runpr?.focus ?? {})
  if (!prTasks.length && !linked.length) return null

  const first = prTasks[0]
  const best = linked[0]
  const openSession = async (s: LinkedSession) => {
    setMenu(null)
    if (!s.open) await window.workbench.reopenSession(s.id)
    show({ kind: 'session', id: s.id })
  }
  const openTask = (t: Task) => {
    setMenu(null)
    setTodayTab('tasks')
    setPeekTask(t.id)
  }
  const start = async (t: Task) => {
    setMenu(null)
    const s = await window.workbench.tasks.start(t.id)
    if (s) show({ kind: 'session', id: s.id })
  }

  return (
    <span className="prl">
      {first && (
        <span className="prl-wrap">
          <button
            className={`prl-btn${menu === 'task' ? ' on' : ''}`}
            aria-expanded={menu === 'task'}
            title={prTasks.map((t) => `${t.title} · ${t.statusName}`).join('\n')}
            style={{ '--st': statusVivid({ colorId: first.statusColorId }) } as CSSProperties}
            onClick={() => setMenu(menu === 'task' ? null : 'task')}
          >
            <span className="prl-rail" />
            Task{prTasks.length > 1 ? ` ${prTasks.length}` : ''} <span className="faint">▾</span>
          </button>
          {menu === 'task' && (
            <div className="prl-menu" role="menu">
              <span className="prl-head">{prTasks.length > 1 ? 'tasks on this PR' : 'task on this PR'}</span>
              {prTasks.map((t) => (
                <span key={t.id} className="prl-item-row" style={{ '--st': statusVivid({ colorId: t.statusColorId }) } as CSSProperties}>
                  <button role="menuitem" className="prl-item" title="Show in My tasks" onClick={() => openTask(t)}>
                    <span className="prl-rail" />
                    <span className="prl-title">{t.title}</span>
                    <span className="prl-status">{t.statusName.toLowerCase()}</span>
                  </button>
                  <button className="link-btn prl-ext" title="Open in Productive" onClick={() => (setMenu(null), void window.workbench.openExternal(t.url))}>
                    ↗
                  </button>
                </span>
              ))}
            </div>
          )}
        </span>
      )}
      <span className="prl-wrap">
        <button
          className={`prl-btn${menu === 'session' ? ' on' : ''}`}
          aria-expanded={menu === 'session'}
          title={best ? `${best.title}${live(best) ? ` · ${best.state}` : ''}` : 'No session yet'}
          onClick={() => setMenu(menu === 'session' ? null : 'session')}
        >
          <span style={{ color: best && live(best) ? STATE_COLOR[best.state] : 'var(--faint)' }}>{best && live(best) ? '●' : '○'}</span>
          Session {linked.length > 0 && <span className="muted">{linked.length}</span>} <span className="faint">▾</span>
        </button>
        {menu === 'session' && (
          <div className="prl-menu" role="menu">
            <span className="prl-head">{linked.length ? 'sessions on this PR’s task' : 'no session yet'}</span>
            {linked.map((s) => (
              <button key={s.id} role="menuitem" className="prl-item" onClick={() => void openSession(s)}>
                <span style={{ color: live(s) ? STATE_COLOR[s.state] : 'var(--faint)' }}>{live(s) ? '●' : '○'}</span>
                <span className="prl-title">{s.title}</span>
                <span className="faint">{live(s) ? s.state : s.open ? 'open tab' : 'resume'}</span>
              </button>
            ))}
            {first && (
              <>
                {linked.length > 0 && <span className="prl-sep" />}
                <button role="menuitem" className="prl-item prl-new" onClick={() => void start(first)}>
                  + new session for this task
                </button>
              </>
            )}
          </div>
        )}
      </span>
    </span>
  )
}
