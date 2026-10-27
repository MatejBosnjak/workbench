import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Ci } from '@shared/git'
import { sessionPrs, sessionTaskIds } from '@shared/links'
import { statusVivid, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { useOverlay, useStore } from '../store'
import { Box } from './Box'
import { SessionCup } from './CaffeinateControl'
import { GitHubIcon, NewSessionButton, ProductiveIcon } from './Chips'
import { GitPane } from './GitPane'
import { LinkSuggest } from './LinkSuggest'
import { TaskDetails } from './TaskDetails'
import { LinkPrButton } from './LinkPicker'
import { TaskTrail } from './TaskTrail'
import { TaskPreview } from './TaskPreview'

/** Tasks linked to the session, latest link first. */
export const sessionTasks = (snapshot: TasksSnapshot | null, sessionId: string): string[] => sessionTaskIds(snapshot, sessionId)

export { sessionPrs, type SessionPr } from '@shared/links'

const CI_LABEL: Record<Ci, [string, string]> = {
  pass: ['passing', 'var(--ok)'],
  fail: ['failing', 'var(--bad)'],
  pending: ['running', 'var(--info)'],
  none: ['no CI', 'var(--faint)'],
}
// The session bar lists PRs worst CI first, so trouble is never behind +N.
const CI_RANK: Record<Ci, number> = { fail: 0, pending: 1, none: 2, pass: 3 }
const SHOWN_PRS = 3
// The PR a session bar segment asked for: a new GitHub view has no URL yet when the sidebar mounts.
let wantedPr: string | null = null
const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? ''

/**
 * The session bar under the taskbar, belonging to the open session: its task (status rail, title, status) and its
 * PR (CI state), each opening its sidebar, and the branch at the right.
 */
export function SessionBar({ session }: { session: Session }) {
  const { tasks, git, runpr, side, toggle, setSessionSide } = useStore(useShallow((s) => ({ tasks: s.tasks, git: s.git, runpr: s.runpr, side: s.sessionSides[session.id] ?? null, toggle: s.toggleSessionSide, setSessionSide: s.setSessionSide })))
  const taskId = sessionTasks(tasks, session.id)[0]
  const task = taskId ? tasks?.tasks.find((t) => t.id === taskId) : undefined
  const prs = sessionPrs(session.id, tasks, git, runpr)
  const ranked = [...prs].sort((a, b) => (a.ci ? CI_RANK[a.ci] : 2.5) - (b.ci ? CI_RANK[b.ci] : 2.5))
  const shown = prs.length > SHOWN_PRS ? ranked.slice(0, SHOWN_PRS) : ranked
  const hidden = ranked.slice(shown.length)
  const paneUrl = useStore((s) => s.pane?.prUrl)
  const prOpen = (url: string) => side === 'pr' && paneUrl === url
  // A PR's segment opens the sidebar on it, or closes the sidebar when it's the one shown.
  const openPr = async (url: string) => {
    if (prOpen(url)) return setSessionSide(null)
    wantedPr = url
    await window.workbench.pane.open(url)
    setSessionSide('pr')
  }
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
          </>
        ) : (
          <span className="muted">{taskId ? 'Task' : 'link task…'}</span>
        )}
        <span className="faint">⌘I</span>
      </button>
      {shown.length > 0 && (
        <>
          <span className="sbar-gh">
            <GitHubIcon />
          </span>
          {shown.map((p) => {
            const ci = p.ci ? CI_LABEL[p.ci] : null
            return (
              <button
                key={p.url}
                className={`sbar-btn seg${prOpen(p.url) ? ' on' : ''}`}
                aria-pressed={prOpen(p.url)}
                title={`${p.title} · ${p.label} #${prNumber(p.url)}${ci ? ` · CI ${ci[0]}` : ''}`}
                onClick={() => void openPr(p.url)}
              >
                <span>{p.label}</span>
                {ci && <span style={{ color: ci[1] }}>● {ci[0]}</span>}
              </button>
            )
          })}
          {hidden.length > 0 && (
            <button
              className={`sbar-btn seg${hidden.some((p) => prOpen(p.url)) ? ' on' : ''}`}
              title={hidden.map((p) => p.title).join('\n')}
              onClick={() => void openPr(hidden.find((p) => prOpen(p.url))?.url ?? hidden[0]!.url)}
            >
              <span className="faint">+{hidden.length}</span>
            </button>
          )}
          <span className="faint">⌘⇧I</span>
        </>
      )}
      {!prs.length && (
        <LinkPrButton sessionId={session.id} className="sbar-btn pad">
          <GitHubIcon />
          <span className="muted">link PR…</span>
        </LinkPrButton>
      )}
      {task && <NewSessionButton taskId={task.id} />}
      <LinkSuggest session={session} />
      <SessionCup session={session} />
    </div>
  )
}

/** The PR sidebar: the session's PR in the GitHub pane; with several, a row of chips picks one. */
export function PrSide({ session }: { session: Session }) {
  const { tasks, git, runpr, pane, setSessionSide } = useStore(useShallow((s) => ({ tasks: s.tasks, git: s.git, runpr: s.runpr, pane: s.pane, setSessionSide: s.setSessionSide })))
  const prs = sessionPrs(session.id, tasks, git, runpr)
  const current = prs.find((p) => pane?.prUrl === p.url)
  const first = prs.find((p) => p.url === wantedPr)?.url ?? prs[0]?.url
  // Show one of this session's PRs (the one a segment asked for, else the first); a page the pane already has for one of them stays as it is.
  useEffect(() => {
    if (current) wantedPr = null
    else if (first) void window.workbench.pane.open(first)
  }, [session.id, first, !!current])

  return (
    <aside className="pr-side">
      <div className="ts-tabs">
        {prs.length > 1 &&
          prs.map((p) => (
            <button key={p.url} className={`sb-chip${p.url === current?.url ? ' on' : ''}`} title={p.title} onClick={() => void window.workbench.pane.open(p.url)}>
              {p.title}
            </button>
          ))}
        <LinkPrButton sessionId={session.id} className="sb-chip lk-add">
          + link PR
        </LinkPrButton>
      </div>
      {prs.length === 0 ? <span className="faint">No PR for this session.</span> : <GitPane active side onClose={() => setSessionSide(null)} onUnlink={(url) => void window.workbench.tasks.unlinkPr(session.id, url)} />}
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
      {id && (
        <TaskTrail baseId={id} onClose={close}>
          {task && snapshot && <TaskPreview task={task} snapshot={snapshot} onClose={close} onUnlink={() => void window.workbench.tasks.unlink(session.id, task.id)} />}
          <TaskDetails taskId={id} withTitle={!task} />
        </TaskTrail>
      )}
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
