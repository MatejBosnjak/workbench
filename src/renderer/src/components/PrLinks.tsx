import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import type { Pr } from '@shared/git'
import { MARK_WORD, prSessions, prTasks, type LinkedSession } from '@shared/links'
import { statusVivid, type Task, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useOverlay, useStore } from '../store'
import { goToSession, MarkGlyph, NewSessionButton, ProductiveIcon, Spark } from './Chips'

/** The PR's tasks (from its branch and description) and the sessions linked to them or working on the PR, live first. */
export function prLinks(
  pr: Pr | undefined,
  prUrl: string,
  tasks: TasksSnapshot | null,
  sessions: Session[],
  focus: Record<string, { url: string }>,
): { tasks: Task[]; sessions: LinkedSession[] } {
  return { tasks: pr ? prTasks(pr, tasks) : [], sessions: prSessions(pr, prUrl, tasks, sessions, focus) }
}

/**
 * Task ▾ and Session ▾ in the GitHub pane's strip: the PR's tasks (from its branch and description) and the
 * sessions linked to them or working on this PR, each a click away. While a menu is open the page is a still
 * (useOverlay), so the menu isn't hidden behind the native view.
 */
export function PrLinks({ pr, prUrl }: { pr: Pr | undefined; prUrl: string }) {
  const { tasks, sessions, runpr, show, setTodayTab, setPeekTask } = useStore(
    useShallow((s) => ({ tasks: s.tasks, sessions: s.sessions, runpr: s.runpr, show: s.show, setTodayTab: s.setTodayTab, setPeekTask: s.setPeekTask })),
  )
  const [menu, setMenuState] = useState<'task' | 'session' | null>(null)
  // Where the open menu hangs: under its button's right edge, in window coordinates.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const setMenu = (m: 'task' | 'session' | null, el?: HTMLElement) => {
    if (m && el) {
      const r = el.getBoundingClientRect()
      setAt({ top: r.bottom + 4, right: window.innerWidth - r.right })
    }
    setMenuState(m)
  }
  useOverlay(menu !== null)

  useEffect(() => {
    if (!menu) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    const click = (e: MouseEvent) => !(e.target as HTMLElement).closest('.prl, .prl-menu') && setMenu(null)
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
  const openSession = (s: LinkedSession) => {
    setMenu(null)
    void goToSession(s)
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
            onClick={(e) => setMenu(menu === 'task' ? null : 'task', e.currentTarget)}
          >
            <span className="prl-rail" />
            <ProductiveIcon />
            <span className="prl-title">{first.title}</span>
            {prTasks.length > 1 && <span className="muted">+{prTasks.length - 1}</span>}
            <span className="faint">▾</span>
          </button>
          {menu === 'task' && (
            <Menu at={at}>
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
            </Menu>
          )}
        </span>
      )}
      {!best && first ? (
        <NewSessionButton taskId={first.id} />
      ) : (
      <span className="prl-wrap">
        <button
          className={`prl-btn${menu === 'session' ? ' on' : ''}`}
          aria-expanded={menu === 'session'}
          title={best ? `${best.title} · ${MARK_WORD[best.mark]}` : 'No session yet'}
          onClick={(e) => setMenu(menu === 'session' ? null : 'session', e.currentTarget)}
        >
          {best ? (
            <>
              <MarkGlyph mark={best.mark} />
              <span className="prl-title">{best.title}</span>
              {linked.length > 1 && <span className="muted">+{linked.length - 1}</span>}
            </>
          ) : (
            <>
              <Spark /> session
            </>
          )}
          <span className="faint">▾</span>
        </button>
        {menu === 'session' && (
          <Menu at={at}>
            <span className="prl-head">{linked.length ? 'sessions on this PR’s task' : 'no session yet'}</span>
            {linked.map((s) => (
              <button key={s.id} role="menuitem" className="prl-item" title={`linked via ${s.via}`} onClick={() => openSession(s)}>
                <MarkGlyph mark={s.mark} />
                <span className="prl-title">{s.title}</span>
                <span className={`mk-${s.mark}`}>{MARK_WORD[s.mark]}</span>
              </button>
            ))}
            {first && (
              <>
                {linked.length > 0 && <span className="prl-sep" />}
                <button role="menuitem" className="prl-item prl-new" onClick={() => void start(first)}>
                  + new <Spark /> for this task
                </button>
              </>
            )}
          </Menu>
        )}
      </span>
      )}
    </span>
  )
}

/**
 * A menu drawn at the top of the document, not inside the strip: the strip clips its overflow, which hid the menus.
 * A click inside it (.prl-menu) doesn't count as clicking outside.
 */
function Menu({ at, children }: { at: { top: number; right: number } | null; children: ReactNode }) {
  if (!at) return null
  return createPortal(
    <div className="prl-menu" role="menu" style={{ top: at.top, right: at.right }}>
      {children}
    </div>,
    document.body,
  )
}
