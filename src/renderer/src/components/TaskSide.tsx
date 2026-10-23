import { useEffect, useState } from 'react'
import { prRef, type GitSnapshot } from '@shared/git'
import type { RunPrSnapshot } from '@shared/runpr'
import type { TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { Box } from './Box'
import { GitPane } from './GitPane'
import { TaskDetails } from './TaskDetails'
import { TaskPreview } from './TaskPreview'

/** Tasks linked to the session, latest link first. */
export function sessionTasks(snapshot: TasksSnapshot | null, sessionId: string): string[] {
  return (snapshot?.links ?? [])
    .filter((l) => l.sessionId === sessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => l.taskId)
}

/** The session's PRs: those linked to its tasks, and the frontend PR its branch belongs to. */
export function sessionPrs(sessionId: string, tasks: TasksSnapshot | null, git: GitSnapshot | null, runpr: RunPrSnapshot | null): { url: string; label: string; title: string }[] {
  const ids = new Set(sessionTasks(tasks, sessionId))
  const out = new Map<string, { url: string; label: string; title: string }>()
  const focus = runpr?.focus[sessionId]
  if (focus) out.set(focus.url, { url: focus.url, label: `fe #${focus.number}`, title: focus.title })
  for (const p of [...(git?.mine ?? []), ...(git?.reviews ?? [])]) if (p.taskRefs.some((t) => ids.has(t)) && !out.has(p.url)) out.set(p.url, { url: p.url, label: prRef(p), title: p.title })
  return [...out.values()]
}

/** Task and Pr at the right of the tab strip on a session: each opens its sidebar, the open one is lit. */
export function SessionSideButtons({ session }: { session: Session }) {
  const { tasks, git, runpr, side, toggle } = useStore(useShallow((s) => ({ tasks: s.tasks, git: s.git, runpr: s.runpr, side: s.sessionSide, toggle: s.toggleSessionSide })))
  const hasPr = sessionPrs(session.id, tasks, git, runpr).length > 0
  return (
    <span className="side-btns">
      <button className={`seg-btn${side === 'task' ? ' on' : ''}`} aria-pressed={side === 'task'} title="Task sidebar (⌘I)" onClick={() => toggle('task')}>
        Task
      </button>
      {hasPr && (
        <button className={`seg-btn${side === 'pr' ? ' on' : ''}`} aria-pressed={side === 'pr'} title="PR sidebar (⌘⇧I)" onClick={() => toggle('pr')}>
          Pr
        </button>
      )}
    </span>
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
              {p.label}
            </button>
          ))}
        </div>
      )}
      {prs.length === 0 ? <span className="faint">No PR for this session.</span> : <GitPane active onClose={() => setSessionSide(null)} />}
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
              #{snapshot?.tasks.find((x) => x.id === t)?.number ?? t}
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
                <span className="faint">#{t.number ?? t.id}</span>
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
