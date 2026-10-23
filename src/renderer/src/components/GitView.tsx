import { useEffect, useState } from 'react'
import type { Conversation, DraftTarget, GitSnapshot, GroupTone, Pr } from '@shared/git'
import { ageDays, groupMine, groupReviews, lastMessage, needsReply, prRef, verb } from '@shared/git'
import type { Task, TasksSnapshot } from '@shared/tasks'
import { useStore } from '../store'
import { RunAppButton } from './RunPr'

const TONE: Record<GroupTone, string> = { bad: 'var(--bad)', ok: 'var(--ok)', accent: 'var(--accent)', faint: 'var(--faint)' }
const CI_LABEL = { pass: 'CI passing', fail: 'CI failing', pending: 'CI running', none: 'No CI' }

function age(iso: string): string {
  const d = ageDays(iso)
  if (d <= 0) return 'today'
  return d < 60 ? `${d}d` : `${Math.round(d / 30)}mo`
}

function when(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return ageDays(iso) <= 0 && d.getDate() === new Date().getDate() ? `today ${time}` : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

function stateOf(p: Pr): [string, string] {
  if (p.draft) return ['Draft', 'var(--muted)']
  if (p.reviewDecision === 'CHANGES_REQUESTED') return ['Changes requested', 'var(--bad)']
  if (p.conflict) return ['Conflicts', 'var(--bad)']
  if (p.reviewDecision === 'APPROVED') return ['Approved', 'var(--ok)']
  return ['Review required', 'var(--text-3)']
}

function usePref(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? initial : s === '1'
    } catch {
      return initial
    }
  })
  return [
    v,
    (next) => {
      setV(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // not important
      }
    },
  ]
}

/** My tasks a PR refers to (branch or body). */
const tasksOf = (p: Pr, tasks: TasksSnapshot | null): Task[] => (tasks?.tasks ?? []).filter((t) => !t.context && p.taskRefs.includes(t.id))

export const draftTarget = (p: Pr, c: Conversation): DraftTarget =>
  c.kind === 'thread' ? { kind: 'gh-thread', key: c.key, repo: p.repo, number: p.number, threadId: c.targetId, path: c.path } : { kind: 'gh-pr', key: c.key, repo: p.repo, number: p.number }

function useFocus(): string | null {
  const { focusPr, setFocusPr } = useStore()
  useEffect(() => {
    if (!focusPr) return
    document.getElementById(`pr-${focusPr}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = setTimeout(() => setFocusPr(null), 2500)
    return () => clearTimeout(t)
  }, [focusPr, setFocusPr])
  return focusPr
}

function RepoChips({ prs, repo, setRepo, extra }: { prs: Pr[]; repo: string; setRepo(r: string): void; extra?: React.ReactNode }) {
  const repos = [...new Set(prs.map((p) => p.repoName))].sort((a, b) => prs.filter((p) => p.repoName === b).length - prs.filter((p) => p.repoName === a).length)
  return (
    <>
      {extra}
      <button className={`fchip${repo === 'All' ? ' on' : ''}`} onClick={() => setRepo('All')}>
        All <span className="mono">{prs.length}</span>
      </button>
      {repos.map((r) => (
        <button key={r} className={`fchip${repo === r ? ' on' : ''}`} onClick={() => setRepo(r)}>
          {r} <span className="mono">{prs.filter((p) => p.repoName === r).length}</span>
        </button>
      ))}
    </>
  )
}

function Toggle({ on, label, set }: { on: boolean; label: string; set(v: boolean): void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  )
}

function GroupHead({ title, tone, count }: { title: string; tone: GroupTone; count: number }) {
  return (
    <div className="pr-group-head">
      <span className="tone-dot" style={{ background: TONE[tone] }} />
      <span className="group-name">{title}</span>
      <span className="mono muted">{count}</span>
    </div>
  )
}

function TaskRef({ p, tasks }: { p: Pr; tasks: TasksSnapshot | null }) {
  const { setTodayTab, setPeekTask } = useStore()
  const t = tasksOf(p, tasks)[0]
  if (!t) return <span />
  return (
    <button
      className="pr-task mono"
      title={t.title}
      onClick={() => {
        setTodayTab('tasks')
        setPeekTask(t.id)
      }}
    >
      #{t.number ?? t.id}
    </button>
  )
}

export function GitView({ git, tasks }: { git: GitSnapshot; tasks: TasksSnapshot | null }) {
  const [repo, setRepo] = useState('All')
  const [hideDrafts, setHideDrafts] = usePref('workbench.hideDrafts', false)
  const focus = useFocus()
  const open = (p: Pr) => p.conversations.some((c) => needsReply(c, git.viewer, git.seen))
  const shown = git.mine.filter((p) => !(hideDrafts && p.draft) || p.id === focus)
  const items = shown.filter((p) => (repo === 'All' ? true : repo === 'Reply needed' ? open(p) : p.repoName === repo))
  const groups = groupMine(items, git.viewer, git.seen)
  const replyCount = shown.filter(open).length

  return (
    <>
      <div className="chips">
        <RepoChips
          prs={shown}
          repo={repo}
          setRepo={setRepo}
          extra={
            <button className={`fchip${repo === 'Reply needed' ? ' on' : ''}`} onClick={() => setRepo('Reply needed')}>
              <span className="tone-dot" style={{ background: 'var(--accent)' }} /> Reply needed <span className="mono">{replyCount}</span>
            </button>
          }
        />
        <Toggle on={hideDrafts} label="Hide drafts" set={setHideDrafts} />
      </div>
      {git.fetchedAt === null && git.loading && <div className="today-empty muted">Loading your PRs from GitHub…</div>}
      {git.fetchedAt !== null && groups.length === 0 && <div className="today-empty muted">Nothing here.</div>}
      <div className="groups">
        {groups.map((g) => (
          <section key={g.title} className="group">
            <GroupHead title={g.title} tone={g.tone} count={g.prs.length} />
            {g.prs.map((p) => (
              <PrRow key={p.id} p={p} git={git} tasks={tasks} focused={focus === p.id} />
            ))}
          </section>
        ))}
      </div>
    </>
  )
}

function PrRow({ p, git, tasks, focused }: { p: Pr; git: GitSnapshot; tasks: TasksSnapshot | null; focused: boolean }) {
  const setDraft = useStore((s) => s.setDraft)
  const [state, stateColor] = stateOf(p)
  const open = p.conversations.filter((c) => needsReply(c, git.viewer, git.seen))
  const latest = [...p.conversations].sort((a, b) => (lastMessage(b)?.at ?? '').localeCompare(lastMessage(a)?.at ?? ''))[0]
  const talk = open.length ? 'reply needed' : latest ? (lastMessage(latest)?.author === git.viewer ? 'replied' : 'seen') : ''

  const startDraft = (c: Conversation, withClaude: boolean) => {
    const target = draftTarget(p, c)
    setDraft(target)
    void (withClaude ? window.workbench.git.generate(target, '') : window.workbench.git.openDraft(target))
  }

  return (
    <div id={`pr-${p.id}`} className={`pr-wrap${open.length ? ' needs' : ''}${focused ? ' focus' : ''}`}>
      <div className="pr-row">
        <button className="pr-main" title="Open on GitHub" onClick={() => void window.workbench.openExternal(p.url)}>
          <span className="pr-ref mono">{prRef(p)}</span>
          <span className="pr-title-wrap">
            <span className="pr-title">{p.title}</span>
            <span className="pr-branch mono">{p.branch}</span>
          </span>
        </button>
        <TaskRef p={p} tasks={tasks} />
        <span className="pr-state" style={{ color: stateColor }}>
          {state}
        </span>
        <span className={`ci-dot ci-${p.ci}`} role="img" aria-label={CI_LABEL[p.ci]} title={CI_LABEL[p.ci]} />
        <span className="pr-run">{p.repo === 'productiveio/frontend' && <RunAppButton n={p.number} />}</span>
        <span className={`pr-talk-label${open.length ? ' open' : ''}`}>{talk}</span>
        <span className="pr-age mono">{age(p.updatedAt)}</span>
      </div>
      {open.map((c) => {
        const last = lastMessage(c)!
        return (
          <div key={c.key} className="pr-quote">
            <span className="pr-quote-who">
              <b>{last.author}</b> {verb(c)} {c.path ? <span className="mono">{c.path}</span> : null} · {when(last.at)}
            </span>
            {last.body.trim() && <span className="pr-quote-text">{last.body.trim()}</span>}
            <span className="pr-quote-actions">
              <button className="link-btn accent" onClick={() => startDraft(c, true)}>
                Draft reply with Claude
              </button>
              <button className="link-btn" onClick={() => startDraft(c, false)}>
                Write reply
              </button>
              <button className="link-btn" onClick={() => void window.workbench.openExternal(last.url || p.url)}>
                Open on GitHub
              </button>
              <button className="link-btn muted-btn" onClick={() => void window.workbench.git.markSeen(c.key, last.id)}>
                Mark as seen
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ReviewsView({ git, tasks }: { git: GitSnapshot; tasks: TasksSnapshot | null }) {
  const [repo, setRepo] = useState('All')
  const [hideBots, setHideBots] = usePref('workbench.hideBots', true)
  const focus = useFocus()
  const bots = git.reviews.filter((p) => p.authorBot).length
  const shown = git.reviews.filter((p) => !(hideBots && p.authorBot) || p.id === focus)
  const groups = groupReviews(shown.filter((p) => repo === 'All' || p.repoName === repo))

  return (
    <>
      <div className="chips">
        <RepoChips prs={shown} repo={repo} setRepo={setRepo} />
        <Toggle on={hideBots} label={`Hide bots (${bots})`} set={setHideBots} />
      </div>
      {git.fetchedAt === null && git.loading && <div className="today-empty muted">Loading review requests from GitHub…</div>}
      {git.fetchedAt !== null && groups.length === 0 && <div className="today-empty muted">No reviews waiting on you.</div>}
      <div className="groups">
        {groups.map((g) => (
          <section key={g.title} className="group">
            <GroupHead title={g.title} tone={g.tone} count={g.prs.length} />
            {g.prs.map((p) => {
              const d = ageDays(p.createdAt)
              const mine = tasksOf(p, tasks)[0]
              return (
                <div key={p.id} id={`pr-${p.id}`} className={`pr-wrap${focus === p.id ? ' focus' : ''}`}>
                  <div className="pr-row rev">
                    <button className="pr-main" title="Open on GitHub" onClick={() => void window.workbench.openExternal(p.url)}>
                      <span className="pr-ref mono">{prRef(p)}</span>
                      <span className="pr-title-wrap">
                        <span className="pr-title">{p.title}</span>
                        <span className="pr-branch">
                          {p.author}
                          {p.authorBot ? ' · bot' : ''}
                          {!p.requested ? ' · you asked for changes' : ''}
                        </span>
                      </span>
                    </button>
                    <span className="pr-note">{mine ? `your task #${mine.number ?? mine.id}` : ''}</span>
                    <span className={`ci-dot ci-${p.ci}`} role="img" aria-label={CI_LABEL[p.ci]} title={CI_LABEL[p.ci]} />
                    <span className="pr-run">{p.repo === 'productiveio/frontend' && <RunAppButton n={p.number} />}</span>
                    <span className="pr-age mono" style={{ color: d > 14 ? 'var(--bad)' : d > 3 ? 'var(--warn)' : 'var(--faint)' }}>
                      {age(p.createdAt)}
                    </span>
                  </div>
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </>
  )
}

