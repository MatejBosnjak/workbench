import { useState } from 'react'
import { prRef } from '@shared/git'
import { FE_REPO } from '@shared/runpr'
import { statusColors, type Task, type TaskLink, type TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { openPrLink, openWorkstream, useStore, type View } from '../store'
import { Box } from './Box'
import { RunAppButton } from './RunPr'
import { StatusSelect } from './TaskDetails'
import { ago, dueLabel } from './TodayView'
import { useShallow } from 'zustand/react/shallow'

type Linked = TaskLink & { live: Session | undefined }

function linkedSessions(task: Task, snapshot: TasksSnapshot, sessions: Session[]): Linked[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  return snapshot.links
    .filter((l) => l.taskId === task.id && l.session)
    .map((l) => ({ ...l, live: byId.get(l.sessionId) }))
    .sort((a, b) => (b.live?.lastEventAt ?? b.session!.lastEventAt) - (a.live?.lastEventAt ?? a.session!.lastEventAt))
}

const isLive = (l: Linked) => !!l.live?.alive && (l.live.state === 'running' || l.live.state === 'waiting')

function primaryOf(task: Task, snapshot: TasksSnapshot, sessions: Session[], show: (v: View) => void) {
  const links = linkedSessions(task, snapshot, sessions)
  const open = async (l: Linked) => {
    if (!l.live) await window.workbench.reopenSession(l.sessionId)
    show({ kind: 'session', id: l.sessionId })
  }
  const running = links.find(isLive)
  if (running) return { label: 'switch to session', run: () => open(running) }
  if (links[0]) return { label: links[0].live ? 'open tab' : 'resume latest', run: () => open(links[0]!) }
  return {
    label: 'start session',
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

export function TaskPreview({ task, snapshot, onClose }: { task: Task; snapshot: TasksSnapshot; onClose(): void }) {
  const { sessions, show, git } = useStore(useShallow((s) => ({ sessions: s.sessions, show: s.show, git: s.git })))
  const prs = [...(git?.mine ?? []), ...(git?.reviews ?? [])].filter((p) => p.taskRefs.includes(task.id))
  const [busy, setBusy] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  const parent = task.parentId ? snapshot.tasks.find((t) => t.id === task.parentId) : null
  const links = linkedSessions(task, snapshot, sessions)
  const summary = links.map((l) => snapshot.summaries[l.sessionId]).find(Boolean)
  const linkable = sessions.filter((s) => !links.some((l) => l.sessionId === s.id))
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
    <Box title={`${task.projectName}${task.taskListName ? ` › ${task.taskListName}` : ''}`} className="peek" aside={<button className="icon-btn" aria-label="Close task" onClick={onClose}>×</button>}>
      {parent && (
        <button className="peek-parent" title="Open workstream" onClick={() => openWorkstream(task.id)}>
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
        <span className="peek-prs">
          <span className="k">links</span>
          {prs.length === 0 && <span className="faint">no PRs</span>}
          {prs.map((p) => (
            <span key={p.id} className="peek-pr">
              <button
                className="link-btn"
                title={p.title}
                onClick={(e) => openPrLink(p.url, e.metaKey)}
              >
                {prRef(p)}
              </button>
              {p.repo === FE_REPO && <RunAppButton n={p.number} compact />}
            </span>
          ))}
        </span>
      </div>

      <div className="peek-sub">
        sessions ({links.length})
        <button className="link-btn" onClick={() => setLinking(!linking)} disabled={!linkable.length}>
          link…
        </button>
        <button className="square-btn" aria-label={primary.label} title={`⏎ ${primary.label}`} onClick={() => void primary.run()}>
          ⏎
        </button>
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
              <span className={`dot-${s.state}`}>●</span>
              <span className="pop-text">{s.title}</span>
            </button>
          ))}
        </div>
      )}
      {links.length === 0 && <span className="faint">none yet</span>}
      {links.map((l) => (
        <div key={l.sessionId} className={`peek-session${isLive(l) ? ' live' : ''}`}>
          <button
            className="peek-session-main"
            title={`linked via ${l.via}`}
            onClick={async () => {
              if (!l.live) await window.workbench.reopenSession(l.sessionId)
              show({ kind: 'session', id: l.sessionId })
            }}
          >
            <span className="peek-when">
              {isLive(l) ? '● ' : '  '}
              {when(l.live?.lastEventAt ?? l.session!.lastEventAt)}
            </span>
            <span className="peek-prompt">{l.session!.firstPrompt ?? l.live?.title ?? l.session!.title}</span>
          </button>
          <button className="icon-btn unlink" aria-label="Unlink session" title="Unlink" onClick={() => void window.workbench.tasks.unlink(l.sessionId, task.id)}>
            ×
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

    </Box>
  )
}
