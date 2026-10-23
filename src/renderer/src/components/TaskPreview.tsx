import { useState } from 'react'
import { prRef } from '@shared/git'
import { FE_REPO } from '@shared/runpr'
import type { Task, TaskLink, TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { openPrLink, openWorkstream, useStore, type View } from '../store'
import { Box } from './Box'
import { RunAppButton, runPr } from './RunPr'
import { ago, dueLabel, statusColor } from './TodayView'
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
  const { sessions, show, git, setDraft } = useStore(useShallow((s) => ({ sessions: s.sessions, show: s.show, git: s.git, setDraft: s.setDraft })))
  const prs = [...(git?.mine ?? []), ...(git?.reviews ?? [])].filter((p) => p.taskRefs.includes(task.id))
  const fePr = prs.find((p) => p.repo === FE_REPO)
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
  const comment = () => {
    const target = { kind: 'productive' as const, key: `task:${task.id}`, taskId: task.id, title: task.title }
    setDraft(target)
    void window.workbench.git.openDraft(target)
  }

  return (
    <Box title="Task" className="peek" aside={<button className="icon-btn" aria-label="Close task" onClick={onClose}>×</button>}>
      <span style={{ color: statusColor(task) }}>
        {task.statusCategory === 2 ? '●' : '○'} {task.statusName}
      </span>
      {parent && (
        <button className="peek-parent" title="Open workstream" onClick={() => openWorkstream(task.id)}>
          {parent.milestone ? '◆' : '◇'} {parent.title}
        </button>
      )}
      <h2 className="peek-title">{task.title}</h2>

      <div className="kv">
        <span className="k">where</span>
        <span>
          {task.projectName}
          {task.taskListName ? ` › ${task.taskListName}` : ''}
        </span>
        <span className="k">due</span>
        <span className={due?.late ? 'bad-text' : ''}>{due?.text ?? '—'}</span>
        <span className="k">active</span>
        <span>{ago(task.lastActivityAt)}</span>
        <span className="k">links</span>
        <span className="peek-prs">
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

      <div className="peek-actions">
        <button className="key-btn primary-key" onClick={() => void primary.run()}>
          ⏎ {primary.label}
        </button>
        {fePr && (
          <button className="key-btn" onClick={() => void runPr(fePr.number)}>
            r run app
          </button>
        )}
      </div>
      <div className="peek-links">
        <button className="link-btn" onClick={() => openWorkstream(task.id)}>
          workstream
        </button>
        <button className="link-btn" onClick={comment}>
          comment…
        </button>
        <button className="link-btn" onClick={() => void window.workbench.openExternal(task.url)}>
          open in Productive
        </button>
      </div>
    </Box>
  )
}
