import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { cachedTitle, TaskDetails, TaskNav, useTaskDetail } from './TaskDetails'
import { TaskPreview } from './TaskPreview'

/**
 * Wraps a sidebar's task card and Productive section. A Productive task link inside opens that task in their place,
 * with ← back to the one before; another base task starts over.
 */
export function TaskTrail({ baseId, onClose, children }: { baseId: string; onClose(): void; children: ReactNode }) {
  const [state, setState] = useState<{ base: string; ids: string[] }>({ base: baseId, ids: [] })
  const trail = state.base === baseId ? state.ids : []
  const open = useCallback(
    (id: string) =>
      setState((s) => {
        const ids = s.base === baseId ? s.ids : []
        return { base: baseId, ids: id === (ids.at(-1) ?? baseId) ? ids : [...ids, id] }
      }),
    [baseId],
  )
  const tasks = useStore((s) => s.tasks?.tasks)
  const top = trail.at(-1)
  // The link was likely far down the sidebar; the opened task starts at its top.
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    backRef.current?.scrollIntoView({ block: 'start' })
  }, [top])
  const prev = trail.at(-2) ?? baseId
  return (
    <TaskNav.Provider value={open}>
      {top ? (
        <>
          <button ref={backRef} className="ghost trail-back" title="Back to the task before" onClick={() => setState({ base: baseId, ids: trail.slice(0, -1) })}>
            ← {tasks?.find((t) => t.id === prev)?.title ?? cachedTitle(prev) ?? 'back'}
          </button>
          <LinkedTask key={top} id={top} onClose={onClose} />
        </>
      ) : (
        children
      )}
    </TaskNav.Provider>
  )
}

/** A task opened from a link: the full card once its detail (or my list) has it, then the Productive section. */
function LinkedTask({ id, onClose }: { id: string; onClose(): void }) {
  const snapshot = useStore((s) => s.tasks)
  const { detail } = useTaskDetail(id)
  const task = snapshot?.tasks.find((t) => t.id === id) ?? detail?.task
  return (
    <>
      {task && snapshot && <TaskPreview task={task} snapshot={snapshot} onClose={onClose} />}
      <TaskDetails taskId={id} withTitle={!task || !snapshot} />
    </>
  )
}
