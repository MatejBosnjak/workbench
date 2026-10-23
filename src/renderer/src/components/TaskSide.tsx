import { useState } from 'react'
import type { TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useStore } from '../store'
import { Box } from './Box'
import { TaskDetails } from './TaskDetails'
import { TaskPreview } from './TaskPreview'

/** Tasks linked to the session, latest link first. */
export function sessionTasks(snapshot: TasksSnapshot | null, sessionId: string): string[] {
  return (snapshot?.links ?? [])
    .filter((l) => l.sessionId === sessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => l.taskId)
}

/** The sidebar beside a session's terminal (⌘I): its task's card and the Productive section, or a way to link one. */
export function TaskSide({ session }: { session: Session }) {
  const snapshot = useStore((s) => s.tasks)
  const setTaskSide = useStore((s) => s.setTaskSide)
  const ids = sessionTasks(snapshot, session.id)
  const [picked, setPicked] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const id = picked && ids.includes(picked) ? picked : ids[0]
  const task = id ? snapshot?.tasks.find((t) => t.id === id) : undefined
  const close = () => setTaskSide(false)

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
