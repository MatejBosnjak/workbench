import { useState } from 'react'
import { prRef } from '@shared/git'
import type { Task, TaskLink, TasksSnapshot } from '@shared/tasks'
import { openWorkstream, useStore } from '../store'
import { ago, Diamond, dueLabel, StatusGlyph } from './TodayView'

export function TaskPreview({ task, snapshot, onClose }: { task: Task; snapshot: TasksSnapshot; onClose(): void }) {
  const { sessions, show, git, setDraft, setTodayTab, setFocusPr } = useStore()
  const prs = [...(git?.mine ?? []), ...(git?.reviews ?? [])].filter((p) => p.taskRefs.includes(task.id))
  const [busy, setBusy] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  const parent = task.parentId ? snapshot.tasks.find((t) => t.id === task.parentId) : null
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const links = snapshot.links
    .filter((l) => l.taskId === task.id && l.session)
    .map((l) => ({ ...l, live: byId.get(l.sessionId) }))
    .sort((a, b) => (b.live?.lastEventAt ?? b.session!.lastEventAt) - (a.live?.lastEventAt ?? a.session!.lastEventAt))
  const running = links.find((l) => l.live?.alive && (l.live.state === 'running' || l.live.state === 'waiting'))
  const latest = links[0]
  const summary = links.map((l) => snapshot.summaries[l.sessionId]).find(Boolean)
  const linkable = sessions.filter((s) => !links.some((l) => l.sessionId === s.id))
  const due = dueLabel(task.dueDate)

  const openSession = async (l: TaskLink) => {
    if (!byId.has(l.sessionId)) await window.workbench.reopenSession(l.sessionId)
    show({ kind: 'session', id: l.sessionId })
  }
  const start = async () => {
    setBusy(true)
    try {
      const s = await window.workbench.tasks.start(task.id)
      if (s) show({ kind: 'session', id: s.id })
    } finally {
      setBusy(false)
    }
  }
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

  const primary = running
    ? { label: 'Switch to running session', run: () => openSession(running) }
    : latest
      ? { label: latest.live ? 'Open tab' : 'Resume latest', run: () => openSession(latest) }
      : { label: 'Start session', run: start }

  return (
    <aside className="peek" aria-label="Task preview">
      <div className="peek-top">
        <StatusGlyph task={task} size={12} />
        <span className="peek-status">{task.statusName}</span>
        <span className="peek-tools">
          <button className="link-btn" title="Milestone or parent task with all its subtasks" onClick={() => openWorkstream(task.id)}>
            Workstream
          </button>
          <button
            className="link-btn"
            onClick={() => {
              const target = { kind: 'productive' as const, key: `task:${task.id}`, taskId: task.id, title: task.title }
              setDraft(target)
              void window.workbench.git.openDraft(target)
            }}
          >
            Comment…
          </button>
          <button className="link-btn" onClick={() => void window.workbench.openExternal(task.url)}>
            Open in Productive
          </button>
          <button className="icon-btn" aria-label="Close preview" onClick={onClose}>
            ×
          </button>
        </span>
      </div>

      <div className="peek-title">
        {parent && (
          <span className="peek-parent">
            {parent.milestone && <Diamond />} {parent.title}
          </span>
        )}
        <h2>{task.title}</h2>
      </div>

      <dl className="peek-facts">
        <dt>Where</dt>
        <dd>
          {task.projectName}
          {task.taskListName ? ` › ${task.taskListName}` : ''}
        </dd>
        <dt>Due</dt>
        <dd className={due?.late ? 'bad-text' : ''}>{due?.text ?? '—'}</dd>
        <dt>Last activity</dt>
        <dd>{ago(task.lastActivityAt)}</dd>
        <dt>Linked</dt>
        <dd className="peek-prs">
          {prs.length
            ? prs.map((p) => (
                <button
                  key={p.id}
                  className="link-btn mono"
                  title={p.title}
                  onClick={() => {
                    setTodayTab(git?.mine.includes(p) ? 'git' : 'reviews')
                    setFocusPr(p.id)
                  }}
                >
                  {prRef(p)}
                </button>
              ))
            : <span className="muted">No PRs</span>}
        </dd>
      </dl>

      <section className="peek-section">
        <span className="peek-label">
          Sessions <span className="mono muted">{links.length}</span>
          <button className="link-btn" onClick={() => setLinking(!linking)} disabled={!linkable.length}>
            Link a session…
          </button>
        </span>
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
                <span className={`sb-dot state-${s.state}`} />
                <span className="pop-text">{s.title}</span>
              </button>
            ))}
          </div>
        )}
        {links.map((l) => {
          const isLive = l.live?.alive && (l.live.state === 'running' || l.live.state === 'waiting')
          return (
            <div key={l.sessionId} className={`peek-session${isLive ? ' live' : ''}`}>
              <button className="peek-session-main" onClick={() => void openSession(l)}>
                <span className="peek-session-line">
                  {isLive && <span className="live-dot" />}
                  <span>{l.live?.title ?? l.session!.title}</span>
                  <span className="muted">{ago(l.live?.lastEventAt ?? l.session!.lastEventAt)}</span>
                  <span className="peek-cta">{l.live ? 'Open tab' : 'Resume'}</span>
                </span>
                {l.session!.firstPrompt && <span className="peek-prompt">{l.session!.firstPrompt}</span>}
                <span className="pop-note">linked via {l.via}</span>
              </button>
              <button className="icon-btn unlink" aria-label="Unlink session" title="Unlink" onClick={() => void window.workbench.tasks.unlink(l.sessionId, task.id)}>
                ×
              </button>
            </div>
          )
        })}
        {!links.length && <span className="muted">No sessions linked to this task yet.</span>}
      </section>

      {links.length > 0 && (
        <section className="peek-section">
          <span className="peek-label">
            Where I left off
            <button className="link-btn" disabled={busy} onClick={() => void summarize()}>
              {busy ? 'Summarizing…' : summary ? 'Refresh' : 'Summarize'}
            </button>
          </span>
          {summary ? (
            <span className="peek-summary">
              {summary.text}
              <span className="pop-note"> · {ago(summary.createdAt)}</span>
            </span>
          ) : (
            <span className="muted">Summarize runs claude -p with Haiku over the latest session's transcript.</span>
          )}
          {summaryError && <span className="bad-text">{summaryError}</span>}
        </section>
      )}

      <button className="primary peek-primary" disabled={busy} onClick={() => void primary.run()}>
        {primary.label}
      </button>
    </aside>
  )
}
