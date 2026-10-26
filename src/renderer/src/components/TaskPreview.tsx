import { useState } from 'react'
import { isLive, MARK_WORD, markOf, taskPrs, taskSessions, type LinkedSession } from '@shared/links'
import { FE_REPO } from '@shared/runpr'
import { statusColors, type Task, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { openWorkstream, useStore, type View } from '../store'
import { Box } from './Box'
import { goToSession, MarkGlyph, NewSessionButton, PrChip, Spark, UnlinkIcon } from './Chips'
import { RunAppButton } from './RunPr'
import { StatusSelect } from './TaskDetails'
import { ago, dueLabel } from './TodayView'
import { useShallow } from 'zustand/react/shallow'

function primaryOf(task: Task, snapshot: TasksSnapshot, sessions: Session[], show: (v: View) => void) {
  const links = taskSessions(task.id, snapshot, sessions)
  const target = links[0]
  if (target) {
    const how = isLive(target) ? 'switch to' : target.open ? 'open the tab of' : 'resume'
    return { label: `${how} ${target.title}`, target, run: () => goToSession(target) }
  }
  return {
    label: 'start a session',
    target: undefined as LinkedSession | undefined,
    run: async () => {
      const s = await window.workbench.tasks.start(task.id)
      if (s) show({ kind: 'session', id: s.id })
    },
  }
}

/** What ⏎ does on a task: switch to its running session, open or resume the latest one, or start one. */
export function taskPrimary(task: Task, snapshot: TasksSnapshot, sessions: Session[], show: (v: View) => void): Promise<void> {
  return primaryOf(task, snapshot, sessions, show).run()
}

const when = (ms: number) => {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return new Date().toDateString() === d.toDateString() ? `Today ${time}` : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/** onUnlink: in a session's sidebar, takes this task off the session (with traffic-light tools, like the PR sidebar). */
export function TaskPreview({ task, snapshot, onClose, onUnlink }: { task: Task; snapshot: TasksSnapshot; onClose(): void; onUnlink?(): void }) {
  const { sessions, show, git } = useStore(useShallow((s) => ({ sessions: s.sessions, show: s.show, git: s.git })))
  const prs = taskPrs(task.id, git)
  const [busy, setBusy] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  const parent = task.parentId ? snapshot.tasks.find((t) => t.id === task.parentId) : null
  const links = taskSessions(task.id, snapshot, sessions)
  const summary = links.map((l) => snapshot.summaries[l.id]).find(Boolean)
  const linkable = sessions.filter((s) => !links.some((l) => l.id === s.id))
  const due = dueLabel(task.dueDate)
  const primary = primaryOf(task, snapshot, sessions, show)

  const summarize = async () => {
    setBusy(true)
    setSummaryError(null)
    try {
      await window.workbench.tasks.summarize(task.id)
    } catch (e) {
      setSummaryError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box title={`${task.projectName}${task.taskListName ? ` › ${task.taskListName}` : ''}`} className="peek has-edge" aside={
        onUnlink ? (
          <span className="gp-tools">
            <button className="key-btn tl-unlink" title="Unlink this task from the session" aria-label="Unlink this task from the session" onClick={onUnlink}>
              <UnlinkIcon />
            </button>
            <button className="key-btn tl-close" title="Close" aria-label="Close task" onClick={onClose}>
              ×
            </button>
          </span>
        ) : (
          <button className="icon-btn" aria-label="Close task" onClick={onClose}>
            ×
          </button>
        )
      }>
      {parent && (
        <button className="peek-parent" title={`${parent.title} · open workstream`} onClick={() => openWorkstream(task.id)}>
          {parent.milestone ? '◆' : '◇'} {parent.title}
        </button>
      )}
      <div className="peek-head">
        <h2 className="peek-title">
          <a href={task.url} title="Open in Productive" style={{ textDecorationColor: statusColors({ colorId: task.statusColorId })[1] }} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(task.url))}>
            {task.title}
          </a>
        </h2>
        <StatusSelect task={task} />
      </div>

      <div className="peek-facts">
        <span>
          <span className="k">due </span>
          <span className={due?.late ? 'bad-text' : ''}>{due?.text ?? '—'}</span>
        </span>
        <span>
          <span className="k">active </span>
          {ago(task.lastActivityAt)}
        </span>
      </div>

      <div className="peek-links">
        <span className="k">PR</span>
        {prs.length === 0 && <span className="faint">none</span>}
        {prs.map((p) => (
          <span key={p.id} className="peek-pr">
            <PrChip pr={p} />
            {p.repo === FE_REPO && <RunAppButton n={p.number} compact />}
          </span>
        ))}
        <span className="peek-sess-head">
          sessions ({links.length})
          <button className="link-btn" title="Link an open session to this task" onClick={() => setLinking(!linking)} disabled={!linkable.length}>
            link <Spark />
          </button>
        </span>
      </div>
      {linking && (
        <div className="link-pick">
          {linkable.map((s) => (
            <button
              key={s.id}
              className="pop-item"
              onClick={() => {
                setLinking(false)
                void window.workbench.tasks.link(s.id, task.id)
              }}
            >
              <MarkGlyph mark={markOf(s)} />
              <span className="pop-text">{s.title}</span>
            </button>
          ))}
        </div>
      )}
      {links.length === 0 && <span className="faint">none yet</span>}
      {links.map((l) => (
        <div key={l.id} className={`peek-session${isLive(l) ? ' live' : ''}`}>
          <button className="peek-session-main" title={`${l.title} · ${MARK_WORD[l.mark]} · linked via ${l.via}`} onClick={() => void goToSession(l)}>
            <span className="peek-when">
              <MarkGlyph mark={l.mark} /> {when(l.at)}
            </span>
            <span className="peek-prompt">{l.firstPrompt ?? l.title}</span>
          </button>
          <button className="icon-btn unlink tl-unlink" aria-label="Unlink session" title="Unlink this session from the task" onClick={() => void window.workbench.tasks.unlink(l.id, task.id)}>
            <UnlinkIcon size={13} />
          </button>
        </div>
      ))}

      {links.length > 0 && (
        <>
          <div className="peek-sub">
            left off
            <button className="link-btn" disabled={busy} onClick={() => void summarize()}>
              {busy ? 'summarizing…' : summary ? 'refresh' : 'summarize'}
            </button>
          </div>
          {summary ? <span className="peek-summary">{summary.text}</span> : <span className="faint">Summarize reads the latest session with Haiku.</span>}
          {summaryError && <span className="bad-text">{summaryError}</span>}
        </>
      )}

      <span className="peek-edge">
        <NewSessionButton taskId={task.id} hint />
        {primary.target && (
          <button type="button" className="continue-btn" title={`⏎ ${primary.label}`} onClick={() => void primary.run()}>
            ⏎ continue
          </button>
        )}
      </span>
    </Box>
  )
}
