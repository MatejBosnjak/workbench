import { useEffect, useState } from 'react'
import type { Conversation, DraftTarget, GitSnapshot, GroupTone, MergeCheck, Pr, PrGroup, Reviewer } from '@shared/git'
import { age as ago } from '@shared/time'
import { ageDays, askedForChanges, groupByStage, groupReviews, lastMessage, mergeChecks, needsReply, prRef, prRepo, shortRepo } from '@shared/git'
import { prTasks } from '@shared/links'
import { runTarget } from '@shared/runpr'
import type { TasksSnapshot } from '@shared/tasks'
import { useKeyTarget } from '../keys'
import { openInPane, useStore } from '../store'
import { Box } from './Box'
import { CiLink, TaskChip } from './Chips'
import { RunAppButton, runPr } from './RunPr'
import { useShallow } from 'zustand/react/shallow'

const TONE: Record<GroupTone, string> = { bad: 'var(--bad)', ok: 'var(--ok)', accent: 'var(--accent)', info: 'var(--info)', faint: 'var(--faint)' }

const age = (iso: string) => ago(iso)

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

export const draftTarget = (p: Pr, c: Conversation): DraftTarget =>
  c.kind === 'thread' ? { kind: 'gh-thread', key: c.key, repo: p.repo, number: p.number, threadId: c.targetId, path: c.path } : { kind: 'gh-pr', key: c.key, repo: p.repo, number: p.number }

function useFocus(): string | null {
  const { focusPr, setFocusPr } = useStore(useShallow((s) => ({ focusPr: s.focusPr, setFocusPr: s.setFocusPr })))
  useEffect(() => {
    if (!focusPr) return
    document.getElementById(`pr-${focusPr}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = setTimeout(() => setFocusPr(null), 2500)
    return () => clearTimeout(t)
  }, [focusPr, setFocusPr])
  return focusPr
}

/**
 * Opens the conversation in the GitHub pane and fills its reply box: with Claude's text, or empty for writing by
 * hand. GitHub's own Comment button posts it.
 */
export async function replyInPane(p: Pr, c: Conversation, withClaude: boolean): Promise<void> {
  const last = lastMessage(c)!
  const url = last.url || p.url
  const st = useStore.getState()
  st.setSelPr(p.id)
  openInPane(url)
  if (!withClaude) return void window.workbench.pane.fill(url, '')
  st.setPaneNote('Claude is drafting a reply…')
  try {
    const text = await window.workbench.git.compose(draftTarget(p, c), '')
    const filled = await window.workbench.pane.fill(url, text)
    st.setPaneNote(filled ? "Claude's draft is in GitHub's reply box. Edit it and press Comment to post." : "Couldn't find the reply box; the draft is on the clipboard. Paste it into the thread's reply box.")
  } catch (e) {
    st.setPaneNote(`Drafting failed: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
  }
}

/** A row click: the PR in the pane, selected; ⌘-click opens the browser. */
function openRow(p: Pick<Pr, 'id' | 'url'>, external: boolean): void {
  if (external) return void window.workbench.openExternal(p.url)
  useStore.getState().setSelPr(p.id)
  openInPane(p.url)
}

/** j / k through the rows on screen, ⏎ opens the PR in the pane, r runs a frontend PR in the app, m marks its threads seen. */
function useRowKeys(prs: Pr[]) {
  const { selPr, setSelPr, git } = useStore(useShallow((s) => ({ selPr: s.selPr, setSelPr: s.setSelPr, git: s.git })))
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
      nextPane: () => {
        const order = ['needs', 'tasks', 'git', 'reviews'] as const
        const st = useStore.getState()
        st.setTodayTab(order[(order.indexOf(st.todayTab) + 1) % order.length]!)
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

function GroupHead({ title, tone, count, fold }: { title: string; tone: GroupTone; count: number; fold?: { open: boolean; set(v: boolean): void } }) {
  return (
    <div className="pr-group-head">
      <span className="tone-dot" style={{ background: TONE[tone] }} />
      {fold ? (
        <button className="fold-btn group-name" aria-expanded={fold.open} onClick={() => fold.set(!fold.open)}>
          {fold.open ? '▾' : '▸'} {title}
        </button>
      ) : (
        <span className="group-name">{title}</span>
      )}
      <span className="mono muted">{count}</span>
    </div>
  )
}

/** One line for folded drafts: all fine, or what's still running or open on them. */
function draftSummary(prs: Pr[], git: GitSnapshot): string {
  const running = prs.filter((p) => p.ci === 'pending').length
  const replies = prs.filter((p) => p.conversations.some((c) => needsReply(c, git.viewer, git.seen))).length
  const parts = [running && `${running} CI running`, replies && `${replies} with a reply waiting`].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'all ✓ · nothing waiting on you'
}

function TaskRef({ p, tasks }: { p: Pr; tasks: TasksSnapshot | null }) {
  const t = prTasks(p, tasks)[0]
  return <span className="pr-task">{t && <TaskChip task={t} />}</span>
}

export function GitView({ git, tasks }: { git: GitSnapshot; tasks: TasksSnapshot | null }) {
  const [repo, setRepo] = useState('All')
  const [draftsOpen, setDraftsOpen] = usePref('workbench.draftsOpen', false)
  const [newest, setNewest] = usePref('workbench.prsNewestFirst', false)
  const focus = useFocus()
  const shown = git.mine
  // Stages nearest to merge first; replies waiting on me live in Needs you, so here they're only a ↩ badge.
  const groups = groupByStage(shown.filter((p) => repo === 'All' || p.repoName === repo), newest ? 'opened' : 'progress')
  // Drafts fold to one line; one with something wrong (or the one a link points at) stays out of the fold.
  const inView = (g: PrGroup) => (g.title !== 'Draft' || draftsOpen ? g.prs : g.prs.filter((p) => p.id === focus || mergeChecks(p).some((c) => c.state === 'bad')))
  const sel = useRowKeys(groups.flatMap(inView))

  return (
    <>
      <div className="chips">
        <RepoChips prs={shown} repo={repo} setRepo={setRepo} />
        <Toggle on={newest} label="Newest first" set={setNewest} />
      </div>
      {git.fetchedAt === null && git.loading && <div className="today-empty muted">Loading your PRs from GitHub…</div>}
      {git.fetchedAt !== null && groups.length === 0 && <div className="today-empty muted">Nothing here.</div>}
      <div className="groups">
        <OpenedGroup git={git} />
        {groups.map((g) => {
          const rows = inView(g)
          const folded = g.prs.length - rows.length
          return (
            <section key={g.title} className="group">
              <GroupHead title={g.title} tone={g.tone} count={g.prs.length} fold={g.title === 'Draft' ? { open: draftsOpen, set: setDraftsOpen } : undefined} />
              {rows.map((p) => (
                <PrRow key={p.id} p={p} git={git} tasks={tasks} focused={focus === p.id} selected={sel === p.id} tone={g.tone} />
              ))}
              {folded > 0 && (
                <button className="fold-line pr-fold" onClick={() => setDraftsOpen(true)}>
                  ▸ {folded} {rows.length ? 'more' : folded === 1 ? 'draft' : 'drafts'} · {draftSummary(g.prs.filter((p) => !rows.includes(p)), git)}
                </button>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}

/** PRs opened from a link that are in neither list; they stay until the app restarts. */
function OpenedGroup({ git }: { git: GitSnapshot }) {
  const { openedPrs, selPr } = useStore(useShallow((s) => ({ openedPrs: s.openedPrs, selPr: s.selPr })))
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
                <span className="pr-ref mono">{m ? shortRepo(m[1]!) : 'PR'}</span>
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

const REVIEW_WORD: Record<Reviewer['state'], string> = { waiting: 'waiting', approved: 'approved', changes: 'changes', commented: 'commented' }

/** Who reviews the PR: avatar ringed by state, login, state. A PR that needs a review and has nobody asked says so. */
function Reviewers({ p, author }: { p: Pr; author?: boolean }) {
  const rs = p.reviewers ?? []
  if (!rs.length && !author) return p.draft || p.reviewDecision !== 'REVIEW_REQUIRED' ? null : <div className="pr-revs"><span className="rv-none">! no reviewer</span></div>
  return (
    <div className="pr-revs">
      {author && (
        <span className="rv rv-author">
          {p.authorAvatar ? <img className="rv-av" src={p.authorAvatar} alt="" /> : <span className="rv-av" />}
          {p.author} <span className="rv-state">{p.authorBot ? 'bot' : 'author'}</span>
        </span>
      )}
      {rs.map((r) => (
        <span key={r.login} className={`rv rv-${r.state}`}>
          <img className="rv-av" src={r.avatar} alt="" />
          {r.login} <span className="rv-state">{REVIEW_WORD[r.state]}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * What stands between the PR and merging: only the checks that aren't passing, one under another (short labels, the
 * full one as a tooltip); a single ✓ when all of them pass.
 */
function Checks({ checks, ciUrl }: { checks: MergeCheck[]; ciUrl: string | null }) {
  const open = checks.filter((c) => c.state !== 'ok')
  if (!open.length)
    return (
      <div className="pr-checks">
        <span className="pr-check ok" title={checks.map((c) => c.label).join(' · ')}>
          ✓
        </span>
      </div>
    )
  return (
    <div className="pr-checks">
      {open.map((c) => {
        const text = `${c.key === 'ci' ? (c.state === 'wait' ? 'CI running' : 'CI') : c.key === 'conflicts' ? (c.state === 'bad' ? 'conflict' : 'merge') : c.state === 'ok' ? 'threads' : c.label.replace(/ open/, '')} ${c.state === 'ok' ? '✓' : c.state === 'bad' ? '✕' : '·'}`
        return (
          <span key={c.key} className={`pr-check ${c.state}`} title={c.label}>
            {c.key === 'ci' && c.label !== 'no CI' ? <CiLink url={ciUrl}>{text}</CiLink> : text}
          </span>
        )
      })}
    </div>
  )
}

/**
 * A PR of mine in three columns: title with reviewers under it; the checks (CI, merge, threads) one under another;
 * the score with Run app under it. ↩ opens replies waiting on me in Needs you.
 */
function PrRow({ p, git, tasks, focused, selected, tone }: { p: Pr; git: GitSnapshot; tasks: TasksSnapshot | null; focused: boolean; selected: boolean; tone: GroupTone }) {
  const { setTodayTab, setPeekNeed } = useStore(useShallow((s) => ({ setTodayTab: s.setTodayTab, setPeekNeed: s.setPeekNeed })))
  const open = p.conversations.filter((c) => needsReply(c, git.viewer, git.seen))
  const checks = mergeChecks(p)
  const score = checks.filter((c) => c.state === 'ok').length
  const toNeeds = () => {
    const c = open[0]!
    setTodayTab('needs')
    setPeekNeed(`re:${c.key}:${lastMessage(c)!.id}`)
  }

  return (
    <div id={`pr-${p.id}`} className={`pr-wrap merge${score === 4 ? ' ready' : ''}${focused ? ' focus' : ''}${selected ? ' sel' : ''}`} style={{ '--rail': TONE[tone] } as React.CSSProperties}>
      <div className="pr-row">
        <button className="pr-main" title="Open here · ⌘-click opens the browser" onClick={(e) => openRow(p, e.metaKey)}>
          <span className="pr-ref mono" title={prRef(p)}>{prRepo(p)}</span>
          <span className="pr-title-wrap">
            <span className="pr-title">{p.title}</span>
          </span>
        </button>
        <TaskRef p={p} tasks={tasks} />
        <span className="pr-replies-slot">
          {open.length > 0 && (
            <button className="pr-replies" title={`${open.length} repl${open.length > 1 ? 'ies' : 'y'} waiting on you · open in Needs you`} onClick={toNeeds}>
              ↩ {open.length}
            </button>
          )}
        </span>
        <span className="pr-age mono">{age(p.updatedAt)}</span>
      </div>
      <Reviewers p={p} />
      <div className="pr-end">
        <Checks checks={checks.filter((c) => c.key !== 'reviews')} ciUrl={p.ciUrl} />
        <div className="pr-go">
          {runTarget(p.repo) && (
            <span className="pr-run">
              <RunAppButton repo={p.repo} n={p.number} compact />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Reviews: a box of PRs waiting on my review, and under it a box of PRs where I asked for changes and the author
 * hasn't come back yet. The repo chips and Hide bots filter both.
 */
export function ReviewsView({ git, tasks, aside }: { git: GitSnapshot; tasks: TasksSnapshot | null; aside?: React.ReactNode }) {
  const [repo, setRepo] = useState('All')
  const [hideBots, setHideBots] = usePref('workbench.hideBots', true)
  const focus = useFocus()
  const bots = git.reviews.filter((p) => p.authorBot).length
  const shown = git.reviews.filter((p) => !(hideBots && p.authorBot) || p.id === focus)
  const inRepo = shown.filter((p) => repo === 'All' || p.repoName === repo)
  const groups = groupReviews(inRepo)
  const asked = askedForChanges(inRepo)
  const sel = useRowKeys([...groups.flatMap((g) => g.prs), ...asked])
  const row = (p: Pr, tone: GroupTone) => <ReviewRow key={p.id} p={p} tasks={tasks} focused={focus === p.id} selected={sel === p.id} tone={tone} />

  return (
    <>
      <Box title={`Reviews (${groups.reduce((n, g) => n + g.prs.length, 0)})`} active aside={aside}>
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
              {g.prs.map((p) => row(p, g.tone))}
            </section>
          ))}
        </div>
      </Box>
      {asked.length > 0 && (
        <Box title={`You asked for changes (${asked.length})`} className="asked-box">
          <div className="faint asked-note">Waiting on the author; they come back up when your review is requested again.</div>
          <div className="groups">{asked.map((p) => row(p, 'bad'))}</div>
        </Box>
      )}
    </>
  )
}

/** A PR waiting on my review, laid out like my PRs: title with the author and other reviewers under it; CI and merge; Run app. */
function ReviewRow({ p, tasks, focused, selected, tone }: { p: Pr; tasks: TasksSnapshot | null; focused: boolean; selected: boolean; tone: GroupTone }) {
  const d = ageDays(p.createdAt)
  const mine = prTasks(p, tasks)[0]
  // Review requests don't load threads, so only CI and conflicts are known here.
  const checks = mergeChecks(p).filter((c) => c.key === 'ci' || c.key === 'conflicts')
  return (
    <div id={`pr-${p.id}`} className={`pr-wrap merge review${focused ? ' focus' : ''}${selected ? ' sel' : ''}`} style={{ '--rail': TONE[tone] } as React.CSSProperties}>
      <div className="pr-row">
        <button className="pr-main" title="Open here · ⌘-click opens the browser" onClick={(e) => openRow(p, e.metaKey)}>
          <span className="pr-ref mono" title={prRef(p)}>{prRepo(p)}</span>
          <span className="pr-title-wrap">
            <span className="pr-title">{p.title}</span>
          </span>
        </button>
        <span className="pr-note">
          {mine && (
            <>
              <span className="faint">your task</span>
              <TaskChip task={mine} />
            </>
          )}
        </span>
        <span className="pr-age mono" title="Opened" style={{ color: d > 14 ? 'var(--bad)' : d > 3 ? 'var(--warn)' : 'var(--faint)' }}>
          {age(p.createdAt)}
        </span>
      </div>
      <Reviewers p={p} author />
      <div className="pr-end">
        <Checks checks={checks} ciUrl={p.ciUrl} />
        <div className="pr-go">
          {runTarget(p.repo) && (
            <span className="pr-run">
              <RunAppButton repo={p.repo} n={p.number} compact />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

