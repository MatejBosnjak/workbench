import { useState } from 'react'
import { statusVivid, type Suggestion } from '@shared/tasks'
import type { Session } from '@shared/types'
import { useStore } from '../store'
import { GitHubIcon, ProductiveIcon } from './Chips'

/**
 * A link Workbench noticed but won't make without you, shown under the session bar: a task id you typed, or a PR the
 * session opened. One at a time, oldest first; the rest wait behind it.
 */
export function LinkSuggest({ session }: { session: Session }) {
  const all = useStore((s) => s.tasks?.suggestions)
  const toggleSide = useStore((s) => s.toggleSessionSide)
  const mine = (all ?? []).filter((s) => s.sessionId === session.id)
  const s = mine[0]
  const [busy, setBusy] = useState(false)
  if (!s) return null

  const answer = async (a: 'yes' | 'pr-only' | 'todo' | 'no') => {
    setBusy(true)
    try {
      await window.workbench.suggest.answer(s.id, a)
    } finally {
      setBusy(false)
    }
  }
  const more = mine.length > 1 && <span className="faint">+{mine.length - 1} more</span>

  return (
    <div className="lsug" role="dialog" aria-label="Link suggestion">
      {s.kind === 'task' ? <TaskBody s={s} /> : <PrBody s={s} />}
      <div className="lsug-actions">
        {s.kind === 'task' && (
          <button className="lsug-yes" disabled={busy} onClick={() => void answer('yes')}>
            Link
          </button>
        )}
        {s.kind === 'pr' && s.task && (
          <>
            <button className="lsug-yes" disabled={busy} onClick={() => void answer('yes')}>
              {s.task.fromPr ? 'Connect both' : 'Connect'}
            </button>
            <button className="lsug-alt" disabled={busy} onClick={() => void answer(s.task!.fromPr ? 'pr-only' : 'todo')}>
              {s.task.fromPr ? 'PR only' : '+ add PR to-do in Productive'}
            </button>
          </>
        )}
        {s.kind === 'pr' && !s.task && (
          <>
            <button className="lsug-yes" disabled={busy} onClick={() => void answer('pr-only')}>
              Connect to session
            </button>
            <button className="lsug-alt" disabled={busy} onClick={() => (void answer('pr-only'), toggleSide('task'))}>
              + pick a task…
            </button>
          </>
        )}
        {more}
        <button className="lsug-no" disabled={busy} aria-label="Not this; don't ask again" title="Not this; don't ask again in this session" onClick={() => void answer('no')}>
          ×
        </button>
      </div>
    </div>
  )
}

function TaskBody({ s }: { s: Extract<Suggestion, { kind: 'task' }> }) {
  return (
    <>
      <div>
        <b className="lsug-k">Link task?</b> <span className="faint">· {s.taskId} in your prompt</span>
      </div>
      <div className="lsug-t">
        <span className="lsug-dot" style={{ background: statusVivid({ colorId: s.colorId }) }} />
        <ProductiveIcon />
        {s.title}
      </div>
      <div className="faint">
        {s.area} · {s.status.toLowerCase()}
      </div>
    </>
  )
}

function PrBody({ s }: { s: Extract<Suggestion, { kind: 'pr' }> }) {
  return (
    <>
      <div>
        <b className="lsug-k">New PR</b> <span className="faint">· opened in this session</span>
      </div>
      <div className="lsug-t">
        <GitHubIcon />
        {s.label} · {s.title}
      </div>
      <div className="faint">
        {!s.task
          ? 'Connect it to this session?'
          : s.task.fromPr
            ? `The PR names a task: ${s.task.title}`
            : `Connect it to this session and to ${s.task.title}?`}
      </div>
    </>
  )
}
