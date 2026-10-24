import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { prRepo, type Ci, type GitSnapshot } from '@shared/git'
import type { RunPrSnapshot } from '@shared/runpr'
import { sessionTaskIds } from '@shared/links'
import { statusVivid, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { useOverlay, useStore } from '../store'
import { Box } from './Box'
import { GitHubIcon, NewSessionButton, ProductiveIcon } from './Chips'
import { GitPane } from './GitPane'
import { LinkSuggest } from './LinkSuggest'
import { TaskDetails } from './TaskDetails'
import { TaskPreview } from './TaskPreview'

/** Tasks linked to the session, latest link first. */
export const sessionTasks = (snapshot: TasksSnapshot | null, sessionId: string): string[] => sessionTaskIds(snapshot, sessionId)

/** The session's PRs: ones connected to it by hand, the frontend PR its branch belongs to, and those linked to its tasks. */
export function sessionPrs(sessionId: string, tasks: TasksSnapshot | null, git: GitSnapshot | null, runpr: RunPrSnapshot | null): SessionPr[] {
  const ids = new Set(sessionTasks(tasks, sessionId))
  const all = [...(git?.mine ?? []), ...(git?.reviews ?? [])]
  const out = new Map<string, SessionPr>()
  // Connected by hand (a link suggestion) first: the PR this session opened.
  for (const l of tasks?.sessionPrs ?? []) {
    if (l.sessionId !== sessionId) continue
    const p = all.find((x) => x.url === l.url)
    out.set(l.url, { url: l.url, label: l.label, title: p?.title ?? l.title, branch: p?.branch ?? '', ci: p?.ci ?? null })
  }
  const focus = runpr?.focus[sessionId]
  if (focus && !out.has(focus.url)) {
    const p = all.find((x) => x.url === focus.url)
    out.set(focus.url, { url: focus.url, label: 'fe', title: focus.title, branch: focus.branch, ci: p?.ci ?? null })
  }
  for (const p of all) if (p.taskRefs.some((t) => ids.has(t)) && !out.has(p.url)) out.set(p.url, { url: p.url, label: prRepo(p), title: p.title, branch: p.branch, ci: p.ci })
  return [...out.values()]
}

export interface SessionPr {
  url: string
  label: string
  title: string
  branch: string
  ci: Ci | null
}

const CI_LABEL: Record<Ci, [string, string]> = {
  pass: ['CI passing', 'var(--ok)'],
  fail: ['CI failing', 'var(--bad)'],
  pending: ['CI running', 'var(--info)'],
  none: ['no CI', 'var(--faint)'],
}

/**
 * The session bar under the taskbar, belonging to the open session: its task (status rail, title, status) and its
 * PR (CI state), each opening its sidebar, and the branch at the right.
 */
export function SessionBar({ session }: { session: Session }) {
  const { tasks, git, runpr, side, toggle } = useStore(useShallow((s) => ({ tasks: s.tasks, git: s.git, runpr: s.runpr, side: s.sessionSides[session.id] ?? null, toggle: s.toggleSessionSide })))
  const taskId = sessionTasks(tasks, session.id)[0]
  const task = taskId ? tasks?.tasks.find((t) => t.id === taskId) : undefined
  const prs = sessionPrs(session.id, tasks, git, runpr)
  const pr = prs[0]
  const ci = pr?.ci ? CI_LABEL[pr.ci] : null
  return (
    <div className="session-bar">
      <span className="faint">session</span>
      <button
        className={`sbar-btn${side === 'task' ? ' on' : ''}`}
        aria-pressed={side === 'task'}
        title={task ? `${task.title} · ${task.statusName} (⌘I)` : 'Link a task (⌘I)'}
        style={task ? ({ '--st': statusVivid({ colorId: task.statusColorId }) } as CSSProperties) : undefined}
        onClick={() => toggle('task')}
      >
        {task ? (
          <>
            <span className="sbar-rail" />
            <ProductiveIcon />
            <span className="sbar-title">{task.title}</span>
            <span className="sbar-status">{(task.statusName || 'no status').toLowerCase()}</span>
          </>
        ) : (
          <span className="muted">{taskId ? 'Task' : 'link task…'}</span>
        )}
        <span className="faint">⌘I</span>
      </button>
      {pr && (
        <button className={`sbar-btn pad${side === 'pr' ? ' on' : ''}`} aria-pressed={side === 'pr'} title={`${pr.title} (⌘⇧I)`} onClick={() => toggle('pr')}>
          <GitHubIcon />
          <span className="sbar-title pr">{pr.title}</span>
          {ci && <span style={{ color: ci[1] }}>● {ci[0]}</span>}
          {prs.length > 1 && <span className="faint">+{prs.length - 1}</span>}
          <span className="faint">⌘⇧I</span>
        </button>
      )}
      {task && <NewSessionButton taskId={task.id} />}
      <LinkSuggest session={session} />
      {pr?.branch && (
        <span className="sbar-branch faint">
          ⎇ <span className="muted">{pr.branch}</span>
        </span>
      )}
    </div>
  )
}

/** The PR sidebar: the session's PR in the GitHub pane; with several, a row of chips picks one. */
export function PrSide({ session }: { session: Session }) {
  const { tasks, git, runpr, pane, setSessionSide } = useStore(useShallow((s) => ({ tasks: s.tasks, git: s.git, runpr: s.runpr, pane: s.pane, setSessionSide: s.setSessionSide })))
  const prs = sessionPrs(session.id, tasks, git, runpr)
  const current = prs.find((p) => pane?.prUrl === p.url)
  const first = prs[0]?.url
  // Show one of this session's PRs; a page the pane already has for one of them stays as it is.
  useEffect(() => {
    if (first && !current) void window.workbench.pane.open(first)
  }, [session.id, first, !!current])

  return (
    <aside className="pr-side">
      {prs.length > 1 && (
        <div className="ts-tabs">
          {prs.map((p) => (
            <button key={p.url} className={`sb-chip${p.url === current?.url ? ' on' : ''}`} title={p.title} onClick={() => void window.workbench.pane.open(p.url)}>
              {p.title}
            </button>
          ))}
        </div>
      )}
      {prs.length === 0 ? <span className="faint">No PR for this session.</span> : <GitPane active side onClose={() => setSessionSide(null)} />}
    </aside>
  )
}

/** The sidebar beside a session's terminal (⌘I): its task's card and the Productive section, or a way to link one. */
export function TaskSide({ session }: { session: Session }) {
  const snapshot = useStore((s) => s.tasks)
  const setSessionSide = useStore((s) => s.setSessionSide)
  const ids = sessionTasks(snapshot, session.id)
  const [picked, setPicked] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const id = picked && ids.includes(picked) ? picked : ids[0]
  const task = id ? snapshot?.tasks.find((t) => t.id === id) : undefined
  const close = () => setSessionSide(null)

  const mine = (snapshot?.tasks ?? []).filter((t) => !t.context && t.title.toLowerCase().includes(filter.toLowerCase()))

  return (
    <aside className="task-side">
      {ids.length > 1 && (
        <div className="ts-tabs">
          {ids.map((t) => (
            <button key={t} className={`sb-chip${t === id ? ' on' : ''}`} onClick={() => setPicked(t)}>
              {snapshot?.tasks.find((x) => x.id === t)?.title ?? 'Task'}
            </button>
          ))}
        </div>
      )}
      {!id && (
        <Box title="Task" className="peek" aside={<button className="icon-btn" aria-label="Close" onClick={close}>×</button>}>
          <span className="faint">No task linked to this session. Link one:</span>
          <input className="ts-filter" placeholder="filter my tasks" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="ts-pick">
            {mine.map((t) => (
              <button key={t.id} className="pop-item" onClick={() => void window.workbench.tasks.link(session.id, t.id)}>
                <span className="pop-text">{t.title}</span>
              </button>
            ))}
          </div>
        </Box>
      )}
      {id && task && snapshot && <TaskPreview task={task} snapshot={snapshot} onClose={close} />}
      {id && <TaskDetails taskId={id} withTitle={!task} />}
    </aside>
  )
}

/** The narrowest a sidebar gets, and how much room it always leaves the terminal. */
const SIDE_MIN = 320
const TERM_MIN = 360

/** The sidebar's left edge: drag it to resize, double-click for the default width. Each sidebar remembers its own width. */
export function SideResizer({ side }: { side: 'task' | 'pr' }) {
  const setWidth = useStore((s) => s.setSideWidth)
  const main = useRef<DOMRect | null>(null)
  const [dragging, setDragging] = useState(false)
  // The GitHub pane is a native view that would swallow the pointer; it waits behind a still while dragging.
  useOverlay(dragging)
  const widthAt = (x: number) => {
    const r = main.current!
    return Math.min(Math.max(r.right - x, SIDE_MIN), r.width - TERM_MIN)
  }
  const current = (el: HTMLElement) => el.parentElement!.getBoundingClientRect().right - el.getBoundingClientRect().left - 4
  return (
    <div
      className={`side-resizer${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault()
        main.current = e.currentTarget.parentElement!.getBoundingClientRect()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => main.current && setWidth(side, widthAt(e.clientX), false)}
      onPointerUp={(e) => {
        if (!main.current) return
        setWidth(side, widthAt(e.clientX), true)
        main.current = null
        setDragging(false)
      }}
      onDoubleClick={() => setWidth(side, null, true)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        main.current = e.currentTarget.parentElement!.getBoundingClientRect()
        setWidth(side, widthAt(main.current.right - current(e.currentTarget) + (e.key === 'ArrowLeft' ? -24 : 24)), true)
        main.current = null
      }}
    />
  )
}
