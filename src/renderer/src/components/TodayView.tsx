import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MARK_WORD, taskSessions, type LinkedSession } from '@shared/links'
import { FE_REPO } from '@shared/runpr'
import { groupByStatus, groupTasks, statusCounts, statusVivid, treeShapes, type StatusCount, type Task, type TasksSnapshot } from '@shared/tasks'
import type { GitSnapshot } from '@shared/git'
import type { Session } from '@shared/types'
import { useKeyTarget } from '../keys'
import { needsBreakdown, needsYou, tomorrowMorning, UNTIL_CHANGED, type NeedItem } from '../needs'
import { navigate, openInPane, openWorkstream, useStore, type TodayTab } from '../store'
import { Box } from './Box'
import { MarkGlyph, NewSessionButton } from './Chips'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { DraftPanel } from './DraftPanel'
import { GitPane } from './GitPane'
import { GitView, ReviewsView } from './GitView'
import { runPr } from './RunPr'
import { NeedPreview } from './NeedPreview'
import { Avatar, TaskDetails } from './TaskDetails'
import { SevenSeg } from './SevenSeg'
import { statusCode, type ThemeId } from '@shared/theme'
import { TaskTrail } from './TaskTrail'
import { TaskPreview, taskPrimary } from './TaskPreview'
import { useShallow } from 'zustand/react/shallow'

// Productive workflow status colours, approximated with theme tokens.
/** The status's bright colour, as task rails, labels and glyphs draw it. */
export const statusColor = (t: Pick<Task, 'statusColorId'>) => statusVivid({ colorId: t.statusColorId })

const isBugProject = (name: string) => /bug/i.test(name)
const GROUP_KEY = 'workbench.taskGroup'

/** A status as task rows and chips print it: MU/TH/UR prints three-letter codes, the rest the name in lower case. */
export const statusText = (name: string | null | undefined, theme: ThemeId) => (theme === 'muthur' ? statusCode(name) : (name || 'No status').toLowerCase())

/** A counter's number: seven-segment digits on the Ops console, two digits on MU/TH/UR, VFD digits over unlit 88 on Night drive, else as is. */
function CounterNumber({ value, lead, theme }: { value: string; lead: boolean; theme: ThemeId }) {
  if (theme === 'console') return <SevenSeg value={value} height={lead ? 38 : 28} />
  if (theme === 'night' && /^\d+$/.test(value)) {
    return (
      <span className="vfd-num" role="img" aria-label={value}>
        {[...value.padStart(2, '0')].map((d, i) => (
          <i key={i}>{d}</i>
        ))}
      </span>
    )
  }
  return <>{theme === 'muthur' && /^\d$/.test(value) ? `0${value}` : value}</>
}

export function dueLabel(d: string | null): { text: string; late: boolean } | null {
  if (!d) return null
  const date = new Date(`${d}T23:59:59`)
  return { text: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), late: date.getTime() < Date.now() }
}

export function ago(iso: string | number | null): string {
  if (!iso) return '—'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 60) return `${Math.max(0, m)}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** ● for started statuses, ○ for not started, in the status colour. */
export function StatusGlyph({ task, size }: { task: Pick<Task, 'statusName' | 'statusCategory' | 'statusColorId'>; size?: number }) {
  return (
    <span className="glyph" title={task.statusName} role="img" aria-label={task.statusName} style={{ color: statusColor(task), fontSize: size ? Math.max(10, size) : undefined }}>
      {task.statusCategory === 2 ? '●' : '○'}
    </span>
  )
}

export function Diamond({ hollow = false }: { hollow?: boolean }) {
  return (
    <span className="diamond" role="img" aria-label="Milestone">
      {hollow ? '◇' : '◆'}
    </span>
  )
}

/** The frontend PR a task refers to, for `r` and ▶ Run app. */
export function taskFePr(task: Pick<Task, 'id'>, git: GitSnapshot | null): number | null {
  const pr = [...(git?.mine ?? []), ...(git?.reviews ?? [])].find((p) => p.repo === FE_REPO && p.taskRefs.includes(task.id))
  return pr?.number ?? null
}

export const TodayView = memo(function TodayView({ snapshot, git, active }: { snapshot: TasksSnapshot | null; git: GitSnapshot | null; active: boolean }) {
  // Nothing from status: it changes on every statusline tick and would re-render all of Today.
  const {
    todayTab: tab,
    setTodayTab,
    draft,
    paneFull,
    theme,
  } = useStore(useShallow((s) => ({ todayTab: s.todayTab, setTodayTab: s.setTodayTab, draft: s.draft, paneFull: s.paneFull, theme: s.theme })))
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const snoozed = useStore((st) => st.snoozed)
  const allNeeds = useMemo(() => needsYou(git, snapshot), [git, snapshot])
  const now = Date.now()
  const needs = allNeeds.filter((n) => !(snoozed[n.key]! > now))
  const sleeping = allNeeds.filter((n) => snoozed[n.key]! > now)
  const mine = snapshot?.tasks.filter((t) => !t.context) ?? []
  const byStatus = new Map<string, number>()
  for (const t of mine) if (t.statusCategory === 2) byStatus.set(t.statusName, (byStatus.get(t.statusName) ?? 0) + 1)
  const topStatuses = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, n]) => `${n} ${name.toLowerCase()}`)
    .join(' · ')
  const replies = new Set(needs.filter((n) => n.kind === 'reply needed').map((n) => n.pr!.id)).size
  const drafts = git?.mine.filter((p) => p.draft).length ?? 0
  const bots = git?.reviews.filter((p) => p.authorBot).length ?? 0
  const asked = git?.reviews.filter((p) => p.requested === false && !p.authorBot).length ?? 0

  const counters: { id: string; title: string; value: string; unit?: string; note: string; tone?: string; to?: TodayTab }[] = [
    {
      id: 'needs',
      title: 'Needs you',
      value: String(needs.length),
      note: needsBreakdown(needs) + (sleeping.length ? ` · ${sleeping.length} sleeping` : ''),
      tone: needs.length ? 'var(--accent)' : undefined,
      to: 'needs',
    },
    { id: 'tasks', title: 'My tasks', value: snapshot?.fetchedAt ? String(mine.length) : '—', note: topStatuses || 'nothing started', to: 'tasks' },
    { id: 'prs', title: 'My PRs', value: git?.fetchedAt ? String(git.mine.length) : '—', note: `${replies} need a reply · ${drafts} drafts`, to: 'git' },
    {
      id: 'reviews',
      title: 'Reviews',
      // Only reviews waiting on me; PRs where I asked for changes are the author's move.
      value: git?.fetchedAt ? String(git.reviews.filter((p) => p.requested !== false && !p.authorBot).length) : '—',
      note: [asked && `${asked} waiting on authors`, `${bots} bot PRs hidden`].filter(Boolean).join(' · '),
      to: 'reviews',
    },
  ]

  const splitKey = 'workbench.gitSplit'
  const splitLayout = (() => {
    try {
      return JSON.parse(localStorage.getItem(splitKey) ?? 'null') as Record<string, number> | null
    } catch {
      return null
    }
  })()
  const list =
    tab === 'git' && git ? (
      <Box title={`My PRs (${git.mine.length})`} active aside={<Sync src={git} onRefresh={() => void window.workbench.git.refresh()} />}>
        <GitView git={git} tasks={snapshot} />
      </Box>
    ) : tab === 'reviews' && git ? (
      <ReviewsView git={git} tasks={snapshot} aside={<Sync src={git} onRefresh={() => void window.workbench.git.refresh()} />} />
    ) : null

  return (
    <div className="today" hidden={!active}>
      {!(tab !== 'tasks' && paneFull) && (
        <div className="counters">
          {counters.map((c) => (
            // Active = the counter whose view is shown.
            <button key={c.id} className={`counter${c.id === 'needs' ? ` lead${needs.length ? ' hot' : ''}` : ''}${c.to === tab ? ' on' : ''}`} disabled={!c.to} onClick={() => c.to && setTodayTab(c.to)}>
              <span className="box-title">{c.title}</span>
              <span className="counter-value" style={c.tone ? ({ color: c.tone, '--glow': c.tone } as CSSProperties) : undefined}>
                <CounterNumber value={c.value} lead={c.id === 'needs'} theme={theme} />
                {c.unit && <span className="counter-unit">{c.unit}</span>}
              </span>
              <span className="counter-note">
                {c.note.split(' · ').map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
      {tab === 'needs' || tab === 'tasks' ? (
        <div className="today-body">
          <main className="today-main">
            <Home view={tab} snapshot={snapshot} git={git} needs={needs} sleeping={sleeping} active={active} />
          </main>
          <aside className="today-side">{draft && git ? <DraftPanel target={draft} git={git} /> : snapshot && <Peek snapshot={snapshot} tab={tab} needs={needs} />}</aside>
        </div>
      ) : paneFull ? (
        <div className="today-body full">
          <GitPane active={active} />
        </div>
      ) : (
        <div className="today-body split">
          <Group
            orientation="horizontal"
            defaultLayout={splitLayout ?? { list: 45, pane: 55 }}
            onLayoutChanged={(sizes) => {
              try {
                localStorage.setItem(splitKey, JSON.stringify(sizes))
              } catch {
                // not important
              }
            }}
          >
            <Panel id="list" minSize="25">
              <main className="today-main">{list}</main>
            </Panel>
            <Separator className="pane-sep row" />
            <Panel id="pane" minSize="30">
              <GitPane active={active} />
            </Panel>
          </Group>
        </div>
      )}
    </div>
  )
})

/** The My tasks strip: the mix of statuses as a bar, chips that filter by status, and the grouping switch. */
function TaskStrip({
  statuses,
  only,
  setOnly,
  groupBy,
  setGroupBy,
}: {
  statuses: StatusCount[]
  only: string[]
  setOnly(v: string[]): void
  groupBy: 'project' | 'status'
  setGroupBy(g: 'project' | 'status'): void
}) {
  const theme = useStore((st) => st.theme)
  const total = statuses.reduce((n, s) => n + s.count, 0) || 1
  const on = (name: string) => !only.length || only.includes(name)
  const toggle = (name: string) => setOnly(only.includes(name) ? only.filter((x) => x !== name) : [...only, name])
  return (
    <div className="task-strip">
      <div className="task-strip-bar">
        {statuses.map((s) => (
          <button
            key={s.name}
            title={`${s.name} ${s.count} · click to filter`}
            aria-label={`Filter: ${s.name} (${s.count})`}
            aria-pressed={only.includes(s.name)}
            style={{ width: `${(s.count / total) * 100}%`, background: s.color, opacity: on(s.name) ? 1 : 0.25 }}
            onClick={() => toggle(s.name)}
          />
        ))}
      </div>
      <div className="task-strip-row">
        {statuses.map((s) => {
          const picked = only.includes(s.name)
          return (
            <button key={s.name} className={`fchip status-chip${picked ? ' picked' : ''}`} style={{ '--st': s.color } as CSSProperties} aria-pressed={picked} onClick={() => toggle(s.name)}>
              <span className="status-swatch" />
              {theme === 'muthur' && <span className="status-code">{statusCode(s.name)}</span>}
              {s.name} <b>{s.count}</b>
            </button>
          )
        })}
        {only.length > 0 && (
          <button className="link-btn" onClick={() => setOnly([])}>
            clear
          </button>
        )}
        <span className="task-group">
          group by
          <span className="seg-pair">
            <button aria-pressed={groupBy === 'project'} onClick={() => setGroupBy('project')}>
              project
            </button>
            <button aria-pressed={groupBy === 'status'} onClick={() => setGroupBy('status')}>
              status
            </button>
          </span>
        </span>
      </div>
    </div>
  )
}

function Sync({ src, onRefresh }: { src: { loading: boolean; error: string | null; fetchedAt: number | null }; onRefresh(): void }) {
  return (
    <span className="sync">
      {src.error ? (
        <span className="bad-text" title={src.error}>
          couldn't load: {src.error.slice(0, 60)}
        </span>
      ) : src.loading ? (
        'refreshing…'
      ) : (
        `updated ${ago(src.fetchedAt)}`
      )}
      <button className="link-btn" disabled={src.loading} onClick={onRefresh}>
        refresh
      </button>
    </span>
  )
}

/** Opens a Needs you item: a PR (or its thread) in the GitHub pane, a task into its session. */
function openNeedItem(n: NeedItem, snapshot: TasksSnapshot | null): void {
  if (n.pr) return openInPane(n.conversation?.messages.at(-1)?.url || n.pr.url)
  const { sessions, show } = useStore.getState()
  if (n.task && snapshot) void taskPrimary(n.task, snapshot, sessions, show)
}

/** The right sidebar: the Needs you item shown (a PR card or the task), or the selected task. */
function Peek({ snapshot, tab, needs }: { snapshot: TasksSnapshot; tab: TodayTab; needs: NeedItem[] }) {
  const { peekTask, setPeekTask, peekNeed, setPeekNeed } = useStore(useShallow((s) => ({ peekTask: s.peekTask, setPeekTask: s.setPeekTask, peekNeed: s.peekNeed, setPeekNeed: s.setPeekNeed })))
  const item = tab === 'needs' ? needs.find((n) => n.key === peekNeed) : undefined
  if (item?.pr) return <NeedPreview item={item} tasks={snapshot} onOpen={() => openNeedItem(item, snapshot)} onClose={() => setPeekNeed(null)} />
  const task = tab === 'needs' ? (item?.task ?? null) : snapshot.tasks.find((t) => t.id === peekTask)
  const close = () => (tab === 'needs' ? setPeekNeed(null) : setPeekTask(null))
  return task ? (
    <TaskTrail baseId={task.id} onClose={close}>
      <TaskPreview task={task} snapshot={snapshot} onClose={close} />
      <TaskDetails taskId={task.id} />
    </TaskTrail>
  ) : (
    <Box title={tab === 'needs' ? 'Preview' : 'Task'}>
      <span className="faint">{tab === 'needs' ? 'Click an item or press ⏎ to see it here; ⏎ again or a double-click opens it.' : 'Select a task with j / k or a click.'}</span>
    </Box>
  )
}

/** Today's home: Needs you, my tasks by project (Bugs on their own), Threads. */
const VIEWS = ['needs', 'tasks', 'git', 'reviews'] as const

/** Needs you (what's waiting on me, plus the threads to answer) or My tasks (only the task lists). */
function Home({
  view: pane,
  snapshot,
  git,
  needs,
  sleeping,
  active,
}: {
  view: 'needs' | 'tasks'
  snapshot: TasksSnapshot | null
  git: GitSnapshot | null
  needs: NeedItem[]
  sleeping: NeedItem[]
  active: boolean
}) {
  const { sessions, peekTask, setPeekTask, setTodayTab, show, snooze, snoozed, theme } = useStore(
    useShallow((s) => ({ sessions: s.sessions, peekTask: s.peekTask, setPeekTask: s.setPeekTask, setTodayTab: s.setTodayTab, show: s.show, snooze: s.snooze, snoozed: s.snoozed, theme: s.theme })),
  )
  const sleep = (n: NeedItem, forever = false) => snooze(n.key, forever ? UNTIL_CHANGED : tomorrowMorning())
  const setPane = (v: 'needs' | 'tasks') => setTodayTab(v)
  const [needIdx, setNeedIdx] = useState(0)
  const [filter, setFilter] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  // My tasks: group by project (with the parent/subtask tree) or by status; the strip's chips filter by status.
  const [groupBy, setGroupBy] = useState<'project' | 'status'>(() => {
    try {
      return localStorage.getItem(GROUP_KEY) === 'status' ? 'status' : 'project'
    } catch {
      return 'project'
    }
  })
  const pickGroup = (g: 'project' | 'status') => {
    setGroupBy(g)
    try {
      localStorage.setItem(GROUP_KEY, g)
    } catch {
      // per-viewer convenience only
    }
  }
  const [only, setOnly] = useState<string[]>([])

  const sessionsByTask = useMemo(() => {
    const m = new Map<string, LinkedSession[]>()
    for (const t of snapshot?.tasks ?? []) m.set(t.id, taskSessions(t.id, snapshot, sessions))
    return m
  }, [snapshot, sessions])

  const statuses = useMemo(() => statusCounts(snapshot?.tasks ?? []), [snapshot?.tasks])
  const byId = useMemo(() => new Map((snapshot?.tasks ?? []).map((t) => [t.id, t])), [snapshot?.tasks])
  const groups = useMemo(() => {
    const q = filter?.trim().toLowerCase()
    const shown = (snapshot?.tasks ?? []).filter(
      (t) => t.context || ((!q || t.title.toLowerCase().includes(q) || String(t.number ?? '').includes(q)) && (!only.length || only.includes(t.statusName || 'No status'))),
    )
    return groupBy === 'status' ? groupByStatus(shown) : groupTasks(shown)
  }, [snapshot?.tasks, filter, only, groupBy])
  const order = groups.flatMap((g) => g.lines.filter((l) => !l.header).map((l) => l.task.id))
  const threads = needs.filter((n) => n.kind === 'reply needed')

  // A click or ⏎ shows an item in the sidebar; ⏎ again on the same item, a double-click or the sidebar's open button opens it.
  const peekNeed = useStore((st) => st.peekNeed)
  const setPeekNeed = useStore((st) => st.setPeekNeed)
  const previewNeed = (n: NeedItem) => setPeekNeed(n.key)
  const openNeed = (n: NeedItem) => openNeedItem(n, snapshot)

  useKeyTarget(
    {
      move: (d) => {
        if (pane === 'needs') return setNeedIdx((i) => Math.max(0, Math.min(needs.length - 1, i + d)))
        const i = peekTask ? order.indexOf(peekTask) : -1
        const next = order[i < 0 ? 0 : Math.max(0, Math.min(order.length - 1, i + d))]
        if (next) {
          setPeekTask(next)
          document.getElementById(`task-${next}`)?.scrollIntoView({ block: 'nearest' })
        }
      },
      open: () => {
        if (pane === 'needs') {
          const n = needs[needIdx]
          if (n) (peekNeed === n.key ? openNeed : previewNeed)(n)
          return
        }
        const t = snapshot?.tasks.find((x) => x.id === peekTask)
        if (t && snapshot) void taskPrimary(t, snapshot, sessions, show)
      },
      nextPane: () => setTodayTab(VIEWS[(VIEWS.indexOf(pane) + 1) % VIEWS.length]!),
      run: () => {
        const p = pane === 'needs' ? needs[needIdx]?.pr : null
        if (p && p.repo === FE_REPO) return void runPr(p.number)
        const t = snapshot?.tasks.find((x) => x.id === peekTask)
        const pr = t ? taskFePr(t, git) : null
        if (pr) void runPr(pr)
      },
      newSession: () => {
        if (!peekTask || pane !== 'tasks') return false
        void window.workbench.tasks.start(peekTask).then((s) => s && show({ kind: 'session', id: s.id }))
        return true
      },
      key: (k) => {
        if ((k !== 'z' && k !== 'Z') || pane !== 'needs') return false
        const n = needs[needIdx]
        if (n) {
          sleep(n, k === 'Z')
          setNeedIdx((i) => Math.max(0, Math.min(needs.length - 2, i)))
        }
        return true
      },
      filter: () => {
        setFilter((f) => f ?? '')
        setPane('tasks')
        setTimeout(() => filterRef.current?.focus(), 0)
      },
    },
    active,
  )

  if (!snapshot) return null
  const activeGroup = peekTask ? groups.find((g) => g.lines.some((l) => l.task.id === peekTask))?.id : groups[0]?.id

  return (
    <div className="home">
      {pane === 'needs' && (
        <Box title={`Needs you (${needs.length})`} active>
          {needs.length === 0 && <span className="faint">Nothing waiting on you.</span>}
          {needs.map((n, i) => (
            <div
              key={n.key}
              className={`need-row${i === needIdx ? ' sel' : ''}${peekNeed === n.key ? ' shown' : ''}`}
              role="button"
              tabIndex={-1}
              onClick={() => (setNeedIdx(i), previewNeed(n))}
              onDoubleClick={() => openNeed(n)}
            >
              <span className={`need-kind need-${n.kind.replace(' ', '-')}`}>{n.kind}</span>
              <span className="need-ref">{n.ref}</span>
              <span className="need-text">{n.text}</span>
              <span className="need-detail">{n.detail}</span>
              <button
                className="need-sleep"
                title="Sleep until tomorrow 08:00 (z). Comes back sooner if something new happens. ⇧-click (⇧Z): sleep until something new happens."
                aria-label="Sleep until tomorrow"
                onClick={(e) => {
                  e.stopPropagation()
                  sleep(n, e.shiftKey)
                }}
              >
                zz
              </button>
            </div>
          ))}
        </Box>
      )}

      {pane === 'tasks' && filter !== null && (
        <label className="filter-line">
          <span className="faint">/</span>
          <input
            ref={filterRef}
            value={filter}
            placeholder="filter tasks"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter(null)
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
            }}
          />
          <button className="link-btn" onClick={() => setFilter(null)}>
            clear
          </button>
        </label>
      )}

      {snapshot.fetchedAt === null && snapshot.loading && <span className="faint">Loading your tasks from Productive…</span>}
      {snapshot.error && (
        <span className="bad-text">
          Couldn't load tasks: {snapshot.error}
          <button className="link-btn" onClick={() => void window.workbench.tasks.refresh()}>
            retry
          </button>
        </span>
      )}

      {pane === 'tasks' && statuses.length > 0 && <TaskStrip statuses={statuses} only={only} setOnly={setOnly} groupBy={groupBy} setGroupBy={pickGroup} />}

      {pane === 'tasks' &&
        groups.map((g, gi) => (
          <Box
            key={g.id}
            title={
              groupBy === 'status' ? (
                <span style={{ color: statuses.find((s) => s.name === g.name)?.color }}>
                  ■ {g.name} ({g.count})
                </span>
              ) : isBugProject(g.name) ? (
                `${g.name} (${g.count})`
              ) : (
                `My tasks › ${g.name} (${g.count})`
              )
            }
            active={pane === 'tasks' && g.id === activeGroup}
            aside={gi === 0 ? <Sync src={snapshot} onRefresh={() => void window.workbench.tasks.refresh()} /> : undefined}
          >
            {(() => {
              const shapes = treeShapes(g.lines)
              return g.lines.map((l, li) => {
                const t = l.task
                const shape = shapes[li]!
                const tree = shape.joint && (
                  <span className="tree" aria-hidden="true">
                    {shape.through.map((on, k) => (
                      <span key={k} className={`tree-g${on ? ' pipe' : ''}`} />
                    ))}
                    <span className={`tree-g ${shape.joint}`} />
                  </span>
                )
                if (l.header)
                  return (
                    <div key={t.id} className="task-line ctx">
                      {tree}
                      <span className="task-mark ctx-mark" aria-hidden="true" />
                      <button className="ctx-open" title="Open workstream" onClick={() => openWorkstream(t.id)}>
                        {t.title}
                      </button>
                      <span className="faint">{l.header === 'milestone' ? ' (not assigned to you)' : ' (filtered out)'}</span>
                    </div>
                  )
                const linked = sessionsByTask.get(t.id) ?? []
                const due = dueLabel(t.dueDate)
                const sel = peekTask === t.id
                // A subtask shown without its parent above it names the parent instead of drawing a tree mark.
                const parent = l.depth === 0 && t.parentId ? byId.get(t.parentId) : undefined
                return (
                  <button
                    key={t.id}
                    id={`task-${t.id}`}
                    className={`task-line row${shape.kids ? ' parent' : ''}${t.myTodos ? ' todo-only' : ''}${sel ? ' sel' : ''}`}
                    style={{ '--st': statusColor(t) } as CSSProperties}
                    data-code={theme === 'muthur' ? statusCode(t.statusName) : undefined}
                    title={t.myTodos ? `${t.statusName} · assigned to ${t.assignedTo?.name}; ${t.myTodos === 1 ? 'one open to-do is' : `${t.myTodos} open to-dos are`} yours` : t.statusName}
                    onClick={() => (setPane('tasks'), setPeekTask(sel ? null : t.id))}
                    onDoubleClick={() => void taskPrimary(t, snapshot, sessions, show)}
                  >
                    {tree}
                    <span className={`task-mark${t.milestone ? ' milestone' : t.statusCategory === 1 ? ' not-started' : ''}`} aria-hidden="true" />
                    <span className="task-name">
                      {t.title}
                      {shape.kids > 0 && <span className="task-kids">{shape.kids}</span>}
                      {parent && <span className="faint">{`  ${parent.milestone ? '◆' : '◇'} ${parent.title}`}</span>}
                    </span>
                    {!!t.myTodos && <span className="task-todos">☐ {t.myTodos === 1 ? '1 to-do' : `${t.myTodos} to-dos`}</span>}
                    <span className="task-status">{statusText(t.statusName, theme)}</span>
                    <span className={`task-due${due?.late ? ' late' : ''}`}>{due?.text ?? ''}</span>
                    <span className="task-sess">
                      {linked[0] ? (
                        <span title={`${linked.length} session${linked.length > 1 ? 's' : ''} · ${linked[0].title} ${MARK_WORD[linked[0].mark]}`}>
                          <MarkGlyph mark={linked[0].mark} /> {linked.length}
                        </span>
                      ) : (
                        <NewSessionButton taskId={t.id} short inRow />
                      )}
                    </span>
                    <span className="task-who">{!!t.myTodos && <Avatar name={t.assignedTo?.name ?? null} url={t.assignedTo?.avatarUrl} />}</span>
                  </button>
                )
              })
            })()}
          </Box>
        ))}

      {pane === 'needs' && threads.length > 0 && (
        <Box title={`Threads (${threads.length})`}>
          {threads.slice(0, 6).map((n) => {
            const last = n.conversation!.messages.at(-1)!
            return (
              <button key={n.key} className={`thread${peekNeed === n.key ? ' shown' : ''}`} onClick={() => (setNeedIdx(needs.indexOf(n)), previewNeed(n))} onDoubleClick={() => openNeed(n)}>
                <span className="thread-head">
                  <span className="warn-text">reply</span>
                  <span className="need-ref">{n.ref}</span>
                  <span>
                    {last.author}
                    {n.conversation!.path ? ` · ${n.conversation!.path.split('/').pop()}` : ''}
                  </span>
                </span>
                <span className="thread-quote">{last.body.replace(/\s+/g, ' ').slice(0, 220) || '(no text)'}</span>
              </button>
            )
          })}
          {threads.length > 6 && (
            <button className="link-btn" onClick={() => navigate({ kind: 'git', prId: null })}>
              {threads.length - 6} more in My PRs
            </button>
          )}
        </Box>
      )}
      {pane === 'needs' && sleeping.length > 0 && (
        <Box title={`Sleeping (${sleeping.length})`}>
          {sleeping.map((n) => (
            <div key={n.key} className="need-row asleep">
              <span className={`need-kind need-${n.kind.replace(' ', '-')}`}>{n.kind}</span>
              <span className="need-ref">{n.ref}</span>
              <span className="need-text">{n.text}</span>
              <span className="need-detail">until {snoozed[n.key]! >= UNTIL_CHANGED ? 'it changes' : new Date(snoozed[n.key]!).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <button className="need-sleep wake" title="Wake it now" onClick={() => snooze(n.key, null)}>
                wake
              </button>
            </div>
          ))}
        </Box>
      )}
    </div>
  )
}
