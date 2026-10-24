import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskLink } from '@shared/tasks'
import type { Session } from '@shared/types'
import type { TimelineItem, Workstream, WsLink, WsPr, WsTask } from '@shared/workstream'
import { itemRepos, repoFromTitle, timeline } from '@shared/workstream'
import { shortRepo } from '@shared/git'
import { openPrLink, useStore } from '../store'
import { Box } from './Box'
import { DraftPanel } from './DraftPanel'
import { Diamond, StatusGlyph, ago } from './TodayView'
import { Avatar } from './TaskDetails'
import { useShallow } from 'zustand/react/shallow'

type Tab = 'timeline' | 'sessions' | 'prs' | 'notes'

const prLabel = (p: WsPr) => `${shortRepo(p.repoName)} #${p.number}`
const isLive = (s?: Session) => !!s?.alive && (s.state === 'running' || s.state === 'waiting')
const base = (p: string) => p.split('/').pop() ?? p

function duration(start: string | null, end: string | null): string {
  if (!start || !end) return ''
  const m = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function when(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}\n${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

/** A repo guess for a new worktree from the title's prefix (FE:, BE:, AI: …); frontend when it names none. */
function guessRepo(title: string, repos: string[]): string | null {
  const want = repoFromTitle(title) ?? 'frontend'
  return repos.includes(want) ? want : (repos[0] ?? null)
}

export function WorkstreamView({ rootId }: { rootId: string }) {
  const { sessions, tasks: snap, draft, setDraft, show, setTodayTab, setPeekTask } = useStore(useShallow((s) => ({ sessions: s.sessions, tasks: s.tasks, draft: s.draft, setDraft: s.setDraft, show: s.show, setTodayTab: s.setTodayTab, setPeekTask: s.setPeekTask })))
  const [ws, setWs] = useState<Workstream | null>(null)
  const [tab, setTab] = useState<Tab>('timeline')
  /** Timeline filter: 'all', a repo name, or 'other' for items no repo can be told for. */
  const [repo, setRepo] = useState('all')

  useEffect(() => {
    void window.workbench.ws.open(rootId).then(setWs)
    return window.workbench.ws.onChanged((w) => {
      if (w.rootId === rootId) setWs(w)
    })
  }, [rootId])

  // The timeline reads oldest to newest; land on the newest end once it has loaded.
  const main = useRef<HTMLElement>(null)
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !ws?.fetchedAt || tab !== 'timeline') return
    landed.current = true
    requestAnimationFrame(() => main.current?.scrollTo({ top: main.current.scrollHeight }))
  }, [ws?.fetchedAt, tab])

  const byId = useMemo(() => new Map((ws?.tasks ?? []).map((t) => [t.id, t])), [ws?.tasks])
  const liveById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const links: (TaskLink & { session: NonNullable<TaskLink['session']> })[] = useMemo(
    () => (snap?.links ?? []).filter((l): l is TaskLink & { session: NonNullable<TaskLink['session']> } => byId.has(l.taskId) && !!l.session),
    [snap?.links, byId],
  )
  const wsLinks: WsLink[] = links.map((l) => ({ sessionId: l.sessionId, taskId: l.taskId, startedAt: ws?.sessionMeta[l.sessionId]?.startedAt ? Date.parse(ws.sessionMeta[l.sessionId]!.startedAt!) : l.createdAt }))
  const items = ws ? timeline(ws, wsLinks) : []
  const root = byId.get(rootId) ?? (snap?.tasks.find((t) => t.id === rootId) as WsTask | undefined)

  const sessionsOf = (taskId: string) => [...new Set(links.filter((l) => l.taskId === taskId).map((l) => l.sessionId))]
  const prsOf = (taskId: string) => (ws?.prs ?? []).filter((p) => p.taskIds.includes(taskId))
  const latest = [...links].sort((a, b) => (liveById.get(b.sessionId)?.lastEventAt ?? b.session.lastEventAt) - (liveById.get(a.sessionId)?.lastEventAt ?? a.session.lastEventAt))
  const sessionIds = [...new Set(latest.map((l) => l.sessionId))]

  // Repo chips, most items first; an item can count for several repos (a task with PRs in two).
  const reposOf = (i: TimelineItem) => (ws ? itemRepos(i, ws) : [])
  const counts = new Map<string, number>()
  for (const i of items) for (const r of reposOf(i).length ? reposOf(i) : ['other']) counts.set(r, (counts.get(r) ?? 0) + 1)
  const repoChips = [...counts].filter(([r]) => r !== 'other').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = repo === 'all' ? items : items.filter((i) => (reposOf(i).length ? reposOf(i).includes(repo) : repo === 'other'))

  const open = async (sessionId: string) => {
    if (!liveById.has(sessionId)) await window.workbench.reopenSession(sessionId)
    show({ kind: 'session', id: sessionId })
  }
  const fork = async (sessionId: string) => {
    const s = await window.workbench.forkSession(sessionId)
    if (s) show({ kind: 'session', id: s.id })
  }
  const postUpdate = () => {
    if (!root) return
    const target = { kind: 'productive' as const, key: `task:${root.id}`, taskId: root.id, title: root.title }
    setDraft(target)
    void window.workbench.git.openDraft(target)
  }
  const git = useStore((s) => s.git)

  const SessionCard = ({ sessionId, taskId }: { sessionId: string; taskId: string }) => {
    const l = links.find((x) => x.sessionId === sessionId && x.taskId === taskId) ?? links.find((x) => x.sessionId === sessionId)!
    const live = liveById.get(sessionId)
    const meta = ws?.sessionMeta[sessionId]
    const summary = snap?.summaries[sessionId]?.text
    const t = byId.get(l.taskId)
    return (
      <div className={`ws-card${isLive(live) ? ' live' : ''}`}>
        <div className="ws-card-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 17l6-5-6-5" /><path d="M12 19h8" /></svg>
          <span className="ws-card-title">{live?.title ?? l.session.title}</span>
          {isLive(live) && (
            <span className="ws-live">
              <span className="live-dot" /> Running in a tab
            </span>
          )}
          <span className="ws-card-tags">
            {t && t.id !== rootId && (
              <span className="ws-sub">
                <StatusGlyph task={t} size={11} /> {t.title}
              </span>
            )}
            <span className="pop-note">linked via {l.via}</span>
          </span>
        </div>
        {summary ? <span className="ws-card-summary">{summary}</span> : l.session.firstPrompt && <span className="ws-card-prompt">“{l.session.firstPrompt}”</span>}
        <div className="ws-card-foot">
          <span className="mono muted">{meta ? [`${meta.lines.toLocaleString()} lines`, duration(meta.startedAt, meta.endedAt)].filter(Boolean).join(' · ') : 'no transcript'}</span>
          <span className="ws-card-actions">
            <button className="ghost" onClick={() => void open(sessionId)}>
              {live ? 'Open tab' : 'Resume'}
            </button>
            <button className="ghost" disabled={!meta} title="New tab with a copy of this conversation" onClick={() => void fork(sessionId)}>
              Fork with context
            </button>
          </span>
        </div>
      </div>
    )
  }

  const Item = ({ it }: { it: TimelineItem }) => (
    <div className="ws-item">
      <div className="ws-when mono">{when(it.at)}</div>
      <div className="ws-rail">
        <span className={it.kind === 'session' ? `ws-node${isLive(liveById.get(it.sessionId)) ? ' live' : ''}` : 'ws-node event'} />
      </div>
      {it.kind === 'session' ? (
        <SessionCard sessionId={it.sessionId} taskId={it.taskId} />
      ) : it.kind === 'pr' ? (
        <div className="ws-event">
          <span className="ws-chip">PR</span>
          <button className="link-btn" title="⌘-click opens the browser" onClick={(e) => openPrLink(it.pr.url, e.metaKey)}>
            {prLabel(it.pr)}
          </button>
          <span>
            {it.what} — {it.pr.title}
          </span>
        </div>
      ) : (
        <div className="ws-event">
          <span className="ws-chip">{it.chip}</span>
          <span>{it.text}</span>
        </div>
      )}
    </div>
  )

  return (
    <div className="ws">
      <div className="ws-head">
        <div className="ws-path">
          <button className="link-btn" onClick={() => show({ kind: 'today' })}>
            ‹ Today
          </button>
          <span>{root?.projectName ?? ''}</span>
          {root?.taskListName && (
            <>
              <span>›</span>
              <span>{root.taskListName}</span>
            </>
          )}
          {root?.milestone && (
            <span className="ws-ms">
              <Diamond /> Milestone
            </span>
          )}
        </div>
        <div className="ws-title-row">
          <h1>{root?.title ?? 'Loading…'}</h1>
          {root && (
            <span className="ws-status">
              <StatusGlyph task={root} size={14} /> {root.statusName}
            </span>
          )}
          <div className="ws-actions">
            <span className="muted ws-sync">{ws?.loading ? 'Loading…' : ws?.error ? <span className="bad-text" title={ws.error}>Couldn't load: {ws.error.slice(0, 60)}</span> : ws?.fetchedAt ? `Updated ${ago(ws.fetchedAt)}` : ''}</span>
            <button className="ghost" disabled={ws?.loading} onClick={() => void window.workbench.ws.refresh(rootId)}>
              Refresh
            </button>
            {root && (
              <button className="ghost" onClick={() => void window.workbench.openExternal(root.url)}>
                Open in Productive
              </button>
            )}
            <button className="ghost" disabled={!root} onClick={postUpdate}>
              Post update to task
            </button>
            <button className="primary" disabled={!latest[0]} onClick={() => latest[0] && void open(latest[0].sessionId)}>
              Resume last session
            </button>
          </div>
        </div>
        <div className="ws-tabs" role="tablist">
          {(
            [
              ['timeline', 'Timeline'],
              ['sessions', `Sessions · ${sessionIds.length}`],
              ['prs', `PRs · ${ws?.prs.length ?? 0}`],
              ['notes', 'Notes'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-body">
        <main className="ws-main" ref={main}>
          {tab === 'timeline' && (
            <>
              <div className="chips">
                <span className="muted ws-show">Show</span>
                <button className={`fchip${repo === 'all' ? ' on' : ''}`} onClick={() => setRepo('all')}>
                  All <span className="mono">{items.length}</span>
                </button>
                {repoChips.map(([r, n]) => (
                  <button key={r} className={`fchip${repo === r ? ' on' : ''}`} onClick={() => setRepo(r)}>
                    {r} <span className="mono">{n}</span>
                  </button>
                ))}
                {counts.has('other') && repoChips.length > 0 && (
                  <button className={`fchip${repo === 'other' ? ' on' : ''}`} title="Items whose task has no PR and no FE:/BE:/AI: prefix" onClick={() => setRepo('other')}>
                    other <span className="mono">{counts.get('other')}</span>
                  </button>
                )}
              </div>
              {ws?.fetchedAt === null && ws.loading && <div className="today-empty muted">Loading the workstream from Productive and GitHub…</div>}
              {ws?.fetchedAt !== null && shown.length === 0 && <div className="today-empty muted">Nothing here yet.</div>}
              <div className="ws-timeline">
                {shown.map((it, i) => (
                  <Item key={`${it.kind}:${i}`} it={it} />
                ))}
              </div>
            </>
          )}
          {tab === 'sessions' && (
            <div className="ws-list">
              {sessionIds.length === 0 && <div className="today-empty muted">No sessions linked to this workstream yet.</div>}
              {sessionIds.map((id) => (
                <SessionCard key={id} sessionId={id} taskId={latest.find((l) => l.sessionId === id)!.taskId} />
              ))}
            </div>
          )}
          {tab === 'prs' && (
            <div className="group ws-prs">
              {(ws?.prs ?? []).length === 0 && <div className="today-empty muted">No PRs mention these tasks.</div>}
              {[...(ws?.prs ?? [])].reverse().map((p) => (
                <button key={p.url} className="ws-pr" title="⌘-click opens the browser" onClick={(e) => openPrLink(p.url, e.metaKey)}>
                  <span className="pr-ref mono">{prLabel(p)}</span>
                  <span className="pr-title-wrap">
                    <span className="pr-title">{p.title}</span>
                    <span className="pr-branch mono">{p.branch}</span>
                  </span>
                  <span className="pop-note">{p.taskIds.map((id) => byId.get(id)?.title).filter(Boolean)[0] ?? ''}</span>
                  <span className={`ws-pr-state ${p.draft && p.state === 'OPEN' ? 'draft' : p.state.toLowerCase()}`}>{p.draft && p.state === 'OPEN' ? 'Draft' : p.state[0] + p.state.slice(1).toLowerCase()}</span>
                  <span className="pr-age mono">{ago(p.mergedAt ?? p.closedAt ?? p.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
          {tab === 'notes' && ws && <Notes rootId={rootId} initial={ws.note} />}
        </main>

        {draft && git ? (
          <DraftPanel target={draft} git={git} />
        ) : (
          <aside className="peek ws-side" aria-label="Linked work">
            <Structure
              ws={ws}
              sessionsOf={sessionsOf}
              prsOf={prsOf}
              live={(id) => sessionsOf(id).some((s) => isLive(liveById.get(s)))}
              onTask={(t) => {
                if (snap?.tasks.some((x) => x.id === t.id && !x.context)) {
                  setTodayTab('tasks')
                  setPeekTask(t.id)
                  show({ kind: 'today' })
                } else void window.workbench.openExternal(t.url)
              }}
            />
            <StartWork ws={ws} rootId={rootId} sessionsOf={sessionsOf} liveById={liveById} open={open} />
            <Box title="Where I left off" aside={latest[0] && <Summarize taskId={latest[0].taskId} />}>
              {sessionIds.filter((id) => snap?.summaries[id]).length ? (
                sessionIds
                  .filter((id) => snap?.summaries[id])
                  .slice(0, 2)
                  .map((id) => (
                    <span key={id} className="peek-summary">
                      <b>{byId.get(latest.find((l) => l.sessionId === id)!.taskId)?.title ?? ''}</b>: {snap!.summaries[id]!.text}
                      <span className="pop-note"> · {ago(snap!.summaries[id]!.createdAt)}</span>
                    </span>
                  ))
              ) : (
                <span className="muted">No summaries yet. Summarize reads the latest session's transcript with Haiku.</span>
              )}
            </Box>
          </aside>
        )}
      </div>
    </div>
  )
}

function Summarize({ taskId }: { taskId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <button
      className="link-btn"
      disabled={busy}
      title={err ?? undefined}
      onClick={async () => {
        setBusy(true)
        setErr(null)
        try {
          await window.workbench.tasks.summarize(taskId)
        } catch (e) {
          setErr((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? 'Summarizing…' : err ? 'Failed · retry' : 'Summarize latest'}
    </button>
  )
}

function Structure({ ws, sessionsOf, prsOf, live, onTask }: { ws: Workstream | null; sessionsOf(id: string): string[]; prsOf(id: string): WsPr[]; live(id: string): boolean; onTask(t: WsTask): void }) {
  const [showClosed, setShowClosed] = useState(false)
  if (!ws) return null
  const closed = ws.tasks.filter((t) => t.depth > 0 && t.closed)
  const rows = ws.tasks.filter((t) => t.depth === 0 || showClosed || !t.closed)
  return (
    <Box
      title={ws.tasks.length ? `Structure (${ws.tasks.length - 1})` : 'Structure'}
      aside={
        closed.length > 0 && (
          <button className="link-btn" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'hide closed' : `show ${closed.length} closed`}
          </button>
        )
      }
    >
      <div className="ws-tree">
        {rows.map((t) => {
          const n = sessionsOf(t.id).length
          const wt = ws.worktrees[t.id]
          return (
            <div key={t.id} className={`ws-node-row${t.closed ? ' closed' : ''}`} style={{ paddingLeft: 10 + t.depth * 16 }}>
              <button className="ws-node-main" title={t.assignee ? `${t.title} · ${t.assignee}` : t.title} onClick={() => onTask(t)}>
                <StatusGlyph task={t} size={13} />
                {t.milestone && <Diamond />}
                <span className={`ws-node-title${t.depth === 0 ? ' root' : ''}`}>{t.title}</span>
                <span className="ws-who" title={t.mine ? 'Assigned to you' : t.assignee ? `Assigned to ${t.assignee}` : 'Unassigned'}>
                  <Avatar name={t.assignee} url={t.assigneeAvatar} mine={t.mine} />
                </span>
              </button>
              {(prsOf(t.id).length > 0 || wt || n > 0) && (
                <div className="ws-node-chips">
                  {prsOf(t.id).map((p) => (
                    <span key={p.url} className={`ws-tag ${p.state === 'OPEN' ? (p.draft ? 'draft' : 'pr') : p.state === 'MERGED' ? 'merged' : 'draft'}`}>
                      {prLabel(p)}
                      {p.draft && p.state === 'OPEN' ? ' draft' : ''}
                    </span>
                  ))}
                  {wt && <span className="ws-tag wt">{base(wt)}</span>}
                  {n > 0 && <span className={`ws-tag ${live(t.id) ? 'live' : 'sess'}`}>{`${n} session${n > 1 ? 's' : ''}${live(t.id) ? ' · running' : ''}`}</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Box>
  )
}

function StartWork({ ws, rootId, sessionsOf, liveById, open }: { ws: Workstream | null; rootId: string; sessionsOf(id: string): string[]; liveById: Map<string, Session>; open(id: string): Promise<void> }) {
  const show = useStore((s) => s.show)
  const [repos, setRepos] = useState<string[]>([])
  const [picking, setPicking] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void window.workbench.ws.repos().then(setRepos)
  }, [])
  if (!ws) return null
  const mineOpen = ws.tasks.filter((t) => t.mine && !t.closed && (t.id !== rootId || ws.tasks.length === 1))

  const start = async (taskId: string, repo: string | null) => {
    setBusy(taskId)
    setErr(null)
    setPicking(null)
    try {
      const s = await window.workbench.ws.start(taskId, repo)
      if (s) show({ kind: 'session', id: s.id })
      void window.workbench.ws.refresh(rootId)
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Box title="Start work">
      {mineOpen.length === 0 && <span className="muted">Nothing open is assigned to you here.</span>}
      <div className="ws-start">
        {mineOpen.map((t) => {
          const running = sessionsOf(t.id).find((id) => isLive(liveById.get(id)))
          const wt = ws.worktrees[t.id]
          if (running)
            return (
              <button key={t.id} className="ws-start-btn live" onClick={() => void open(running)}>
                <span className="live-dot" />
                <span className="ws-start-title">{t.title} · running in a tab</span>
                <span className="pop-note">switch</span>
              </button>
            )
          return (
            <div key={t.id}>
              <button className="ws-start-btn" disabled={busy === t.id} onClick={() => (wt ? void start(t.id, null) : setPicking(picking === t.id ? null : t.id))}>
                <span className="ws-plus">+</span>
                <span className="ws-start-title">New session for {t.title}</span>
                <span className="pop-note">{busy === t.id ? 'starting…' : wt ? base(wt) : 'creates worktree'}</span>
              </button>
              {picking === t.id && (
                <div className="link-pick">
                  <span className="pop-note ws-pick-note">New worktree in:</span>
                  {[...repos].sort((a, b) => (a === guessRepo(t.title, repos) ? -1 : b === guessRepo(t.title, repos) ? 1 : a.localeCompare(b))).map((r) => (
                    <button key={r} className="pop-item" onClick={() => void start(t.id, r)}>
                      <span className="pop-text">{r}</span>
                    </button>
                  ))}
                  <button className="pop-item" onClick={() => void start(t.id, null)}>
                    <span className="pop-text">No worktree · default folder</span>
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {err && <span className="bad-text">{err}</span>}
    </Box>
  )
}

function Notes({ rootId, initial }: { rootId: string; initial: string }) {
  const [body, setBody] = useState(initial)
  const saved = useRef(initial)
  useEffect(() => {
    if (body === saved.current) return
    const t = setTimeout(() => {
      saved.current = body
      void window.workbench.ws.setNote(rootId, body)
    }, 500)
    return () => clearTimeout(t)
  }, [body, rootId])
  return (
    <div className="ws-notes">
      <textarea className="draft-text" placeholder="Notes for this workstream. Stored locally." value={body} onChange={(e) => setBody(e.target.value)} />
    </div>
  )
}
