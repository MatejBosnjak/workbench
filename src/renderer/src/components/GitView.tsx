import { useEffect, useState } from 'react'
import type { Conversation, DraftTarget, GitSnapshot, GroupTone, Pr } from '@shared/git'
import { ageDays, groupMine, groupReviews, lastMessage, needsReply, prRef, shortRepo, verb } from '@shared/git'
import type { Task, TasksSnapshot } from '@shared/tasks'
import { useKeyTarget } from '../keys'
import { openInPane, useStore } from '../store'
import { RunAppButton, runPr } from './RunPr'

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

/** A row click: the PR in the pane, selected; ⌘-click opens the browser. */
function openRow(p: Pick<Pr, 'id' | 'url'>, external: boolean): void {
  if (external) return void window.workbench.openExternal(p.url)
  useStore.getState().setSelPr(p.id)
  openInPane(p.url)
}

/** j / k through the rows on screen, ⏎ opens the PR in the pane, r runs a frontend PR in the app, m marks its threads seen. */
function useRowKeys(prs: Pr[]) {
  const { selPr, setSelPr, git } = useStore()
  useKeyTarget(
    {
      move: (d) => {
        const i = selPr ? prs.findIndex((p) => p.id === selPr) : -1
        const next = prs[i < 0 ? 0 : Math.max(0, Math.min(prs.length - 1, i + d))]
        if (!next) return
        setSelPr(next.id)
        document.getElementById(`pr-${next.id}`)?.scrollIntoView({ block: 'nearest' })
      },
      open: () => {
        const p = prs.find((x) => x.id === selPr)
        if (p) openRow(p, false)
      },
      key: (k) => {
        if (k !== 'm') return false
        const p = prs.find((x) => x.id === selPr)
        for (const c of p?.conversations ?? []) {
          const last = lastMessage(c)
          if (last && git && needsReply(c, git.viewer, git.seen)) void window.workbench.git.markSeen(c.key, last.id)
        }
        return true
      },
      run: () => {
        const p = prs.find((x) => x.id === selPr)
        if (p?.repo === 'productiveio/frontend') void runPr(p.number)
      },
    },
    true,
  )
  return selPr
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
  if (!t) return <span className="pr-task" />
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
  const sel = useRowKeys(groups.flatMap((g) => g.prs))

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
        <OpenedGroup git={git} />
        {groups.map((g) => (
          <section key={g.title} className="group">
            <GroupHead title={g.title} tone={g.tone} count={g.prs.length} />
            {g.prs.map((p) => (
              <PrRow key={p.id} p={p} git={git} tasks={tasks} focused={focus === p.id} selected={sel === p.id} />
            ))}
          </section>
        ))}
      </div>
    </>
  )
}

/** PRs opened from a link that are in neither list; they stay until the app restarts. */
function OpenedGroup({ git }: { git: GitSnapshot }) {
  const { openedPrs, selPr } = useStore()
  const known = new Set([...git.mine, ...git.reviews].map((p) => p.url))
  const extra = openedPrs.filter((o) => !known.has(o.url))
  const [info, setInfo] = useState<Record<string, { title: string; state: string }>>({})
  useEffect(() => {
    for (const o of extra) {
      if (info[o.url]) continue
      void window.workbench.prInfo(o.url).then((pr) => pr && setInfo((cur) => ({ ...cur, [o.url]: { title: pr.title, state: pr.isDraft ? 'Draft' : pr.state.toLowerCase() } })))
    }
  }, [extra.map((o) => o.url).join()])
  if (!extra.length) return null
  return (
    <section className="group">
      <GroupHead title="Opened" tone="faint" count={extra.length} />
      {extra.map((o) => {
        const m = /github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/.exec(o.url)
        return (
          <div key={o.url} id={`pr-${o.url}`} className={`pr-wrap${selPr === o.url ? ' sel' : ''}`}>
            <div className="pr-row rev">
              <button className="pr-main" onClick={(e) => openRow({ id: o.url, url: o.url }, e.metaKey)}>
                <span className="pr-ref mono">{m ? `${shortRepo(m[1]!)} #${m[2]}` : 'PR'}</span>
                <span className="pr-title-wrap">
                  <span className="pr-title">{info[o.url]?.title ?? '…'}</span>
                  <span className="pr-branch">{info[o.url]?.state ?? ''}</span>
                </span>
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function PrRow({ p, git, tasks, focused, selected }: { p: Pr; git: GitSnapshot; tasks: TasksSnapshot | null; focused: boolean; selected: boolean }) {
  const setDraft = useStore((s) => s.setDraft)
  const [state, stateColor] = stateOf(p)
  const open = p.conversations.filter((c) => needsReply(c, git.viewer, git.seen))
  const latest = [...p.conversations].sort((a, b) => (lastMessage(b)?.at ?? '').localeCompare(lastMessage(a)?.at ?? ''))[0]
  const talk = open.length ? 'reply needed' : latest ? (lastMessage(latest)?.author === git.viewer ? 'replied' : 'seen') : ''

  const [drafting, setDrafting] = useState<string | null>(null)
  /** Claude's text (or nothing, for writing by hand) goes into GitHub's own reply box in the pane; GitHub's Comment button posts it. */
  const reply = async (c: Conversation, withClaude: boolean) => {
    const last = lastMessage(c)!
    const url = last.url || p.url
    const st = useStore.getState()
    st.setSelPr(p.id)
    openInPane(url)
    if (!withClaude) return void window.workbench.pane.fill(url, '')
    setDrafting(c.key)
    st.setPaneNote('Claude is drafting a reply…')
    try {
      const text = await window.workbench.git.compose(draftTarget(p, c), '')
      const filled = await window.workbench.pane.fill(url, text)
      st.setPaneNote(filled ? "Claude's draft is in GitHub's reply box. Edit it and press Comment to post." : "Couldn't find the reply box; the draft is on the clipboard. Paste it into the thread's reply box.")
    } catch (e) {
      st.setPaneNote(`Drafting failed: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
    } finally {
      setDrafting(null)
    }
  }

  return (
    <div id={`pr-${p.id}`} className={`pr-wrap${open.length ? ' needs' : ''}${focused ? ' focus' : ''}${selected ? ' sel' : ''}`}>
      <div className="pr-row">
        <button className="pr-main" title="Open here · ⌘-click opens the browser" onClick={(e) => openRow(p, e.metaKey)}>
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
              <button className="link-btn accent" disabled={drafting === c.key} onClick={() => void reply(c, true)}>
                {drafting === c.key ? 'Drafting…' : 'Draft reply with Claude'}
              </button>
              <button className="link-btn" onClick={() => void reply(c, false)}>
                Write reply
              </button>
              <button className="link-btn" title="⌘-click opens the browser" onClick={(e) => (e.metaKey ? void window.workbench.openExternal(last.url || p.url) : openInPane(last.url || p.url))}>
                Open thread
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
  const sel = useRowKeys(groups.flatMap((g) => g.prs))

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
                <div key={p.id} id={`pr-${p.id}`} className={`pr-wrap${focus === p.id ? ' focus' : ''}${sel === p.id ? ' sel' : ''}`}>
                  <div className="pr-row rev">
                    <button className="pr-main" title="Open here · ⌘-click opens the browser" onClick={(e) => openRow(p, e.metaKey)}>
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

