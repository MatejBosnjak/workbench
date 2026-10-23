import { Fragment, useEffect, useState } from 'react'
import { statusColors, type TaskDetail } from '@shared/tasks'
import { Box } from './Box'

/** Last fetch per task, so switching back shows something at once while the fresh copy loads. */
const cache = new Map<string, TaskDetail>()

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Plain text with its URLs as links that open in the browser. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(p))}>
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

/** The task as Productive has it: status (click one to move it), description and to-dos. Every write asks first. */
export function TaskDetails({ taskId, withTitle = false }: { taskId: string; withTitle?: boolean }) {
  const [detail, setDetail] = useState<TaskDetail | null>(cache.get(taskId) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setDetail(cache.get(taskId) ?? null)
    setError(null)
    window.workbench.tasks.detail(taskId).then(
      (d) => {
        cache.set(taskId, d)
        if (live) setDetail(d)
      },
      (e) => live && setError(clean(e)),
    )
    return () => {
      live = false
    }
  }, [taskId])

  const write = async (key: string, run: () => Promise<TaskDetail | null>) => {
    setBusy(key)
    setError(null)
    try {
      const d = await run()
      if (d) {
        cache.set(taskId, d)
        setDetail(d)
      }
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(null)
    }
  }

  const open = detail?.todos.filter((t) => !t.closed).length ?? 0

  return (
    <Box title="Productive" className="peek task-details">
      {!detail && !error && <span className="faint">loading…</span>}
      {error && <span className="bad-text">{error}</span>}
      {detail && (
        <>
          {withTitle && (
            <h2 className="peek-title">
              <a href={detail.task.url} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(detail.task.url))}>
                {detail.task.title}
              </a>
            </h2>
          )}
          <div className="td-statuses" role="group" aria-label="Status">
            {detail.statuses.map((s) => {
              const [bg, fg] = statusColors(s)
              const on = s.id === detail.statusId
              return (
                <button
                  key={s.id}
                  className={`td-status${on ? ' on' : ''}`}
                  style={{ background: bg, color: fg }}
                  aria-pressed={on}
                  disabled={!!busy}
                  title={on ? 'Current status' : `Move to ${s.name}`}
                  onClick={() => !on && void write(`s:${s.id}`, () => window.workbench.tasks.setStatus(taskId, s.id))}
                >
                  {busy === `s:${s.id}` ? '…' : s.name}
                </button>
              )
            })}
          </div>

          <div className="peek-sub">description</div>
          {detail.description ? (
            <div className="td-desc">
              <Linked text={detail.description} />
            </div>
          ) : (
            <span className="faint">none</span>
          )}

          <div className="peek-sub">
            to-dos {detail.todos.length > 0 && <span className="faint">{detail.todos.length - open}/{detail.todos.length}</span>}
          </div>
          {detail.todos.length === 0 && <span className="faint">none</span>}
          {detail.todos.map((t) => (
            <label key={t.id} className={`td-todo${t.closed ? ' done' : ''}`}>
              <input type="checkbox" checked={t.closed} disabled={!!busy} onChange={() => void write(`t:${t.id}`, () => window.workbench.tasks.setTodo(taskId, t.id, !t.closed))} />
              <span>{busy === `t:${t.id}` ? '…' : <Linked text={t.text} />}</span>
            </label>
          ))}
        </>
      )}
    </Box>
  )
}
