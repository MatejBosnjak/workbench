import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { FigmaMark } from './FigmaMark'
import { MARK_WORD, taskSessions, type LinkedSession } from '@shared/links'
import { FE_REPO, runTarget } from '@shared/runpr'
import { groupByStatus, groupTasks, statusCounts, statusVivid, treeShapes, type StatusCount, type Task, type TasksSnapshot } from '@shared/tasks'
import { groupReviews, type GitSnapshot } from '@shared/git'
import type { Session } from '@shared/types'
import { useKeyTarget } from '../keys'
import { needsBreakdown, needsYou, needWhen, todoLater, tomorrowMorning, UNTIL_CHANGED, withNext, type NeedItem } from '../needs'
import { exact } from '@shared/time'
import { dayText, isoDay, parseCapture, type MyTodo } from '@shared/todos'
import { sessionStyle } from './SessionMark'
import { TodoPreview } from './TodoPreview'
import { openInPane, openWorkstream, useStore, type TodayTab } from '../store'
import { Box } from './Box'
import { goToSession, MarkGlyph, NewSessionButton } from './Chips'
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
    paneOpen,
  } = useStore(useShallow((s) => ({ todayTab: s.todayTab, setTodayTab: s.setTodayTab, draft: s.draft, paneFull: s.paneFull, theme: s.theme, paneOpen: !!s.pane?.url })))
  // The pane's state is needed before a GitPane is mounted: with no PR open, the list takes the whole width.
  useEffect(() => {
    void window.workbench.pane.state().then((p) => useStore.getState().setPane(p))
    return window.workbench.pane.onChanged((p) => useStore.getState().setPane(p))
  }, [])
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const snoozed = useStore((st) => st.snoozed)
  const myTodos = useStore((st) => st.myTodos)
  const allNeeds = useMemo(() => needsYou(git, snapshot, myTodos), [git, snapshot, myTodos])
  const now = Date.now()
  const asleep = (n: NeedItem) => snoozed[n.key]! > now || todoLater(n)
  const { items: needs, next } = withNext(allNeeds.filter((n) => !asleep(n)))
  const sleeping = allNeeds.filter(asleep)
  const mine = snapshot?.tasks.filter((t) => !t.context) ?? []
  // Each counter's number is the part I can act on; the total is a faint "of n" under it.
  const started = mine.filter((t) => t.statusCategory === 2)
  const working = started.filter((t) => /work|progress|doing/i.test(t.statusName))
  const moving = working.length ? working : started
  const movingWord = working.length ? 'working' : 'started'
  const replies = new Set(needs.filter((n) => n.kind === 'reply needed').map((n) => n.pr!.id)).size
  const waitingReviews = git?.reviews.filter((p) => p.requested !== false && !p.authorBot) ?? []
  const fresh = groupReviews(waitingReviews).find((g) => g.title === 'New this week')?.prs.length ?? 0

  const counters: { id: string; title: string; value: string; unit?: string; note: string; tone?: string; to?: TodayTab }[] = [
    {
      id: 'needs',
      title: 'Needs you',
      value: String(needs.length),
      note: needsBreakdown(needs) + (sleeping.length ? ` · ${sleeping.length} sleeping` : ''),
      tone: needs.length ? 'var(--accent)' : undefined,
      to: 'needs',
    },
    { id: 'tasks', title: 'My tasks', value: snapshot?.fetchedAt ? String(moving.length) : '—', note: `${movingWord} · of ${mine.length}`, to: 'tasks' },
    { id: 'prs', title: 'My PRs', value: git?.fetchedAt ? String(replies) : '—', note: `${replies === 1 ? 'needs' : 'need'} a reply · of ${git?.mine.length ?? 0}`, to: 'git' },
    {
      id: 'reviews',
      title: 'Reviews',
      // Reviews waiting on me (PRs where I asked for changes are the author's move); new this week first.
      value: git?.fetchedAt ? String(fresh) : '—',
      note: `new this week · of ${waitingReviews.length}`,
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
                  <span key={part} className={part.startsWith('of ') ? 'counter-of' : undefined}>
                    {part}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
      {tab === 'needs' || tab === 'tasks' ? (
        <div className="today-body">
          <main className="today-main">
            <Home view={tab} snapshot={snapshot} git={git} needs={needs} next={next} sleeping={sleeping} active={active} />
          </main>
          <aside className="today-side">{draft && git ? <DraftPanel target={draft} git={git} /> : snapshot && <Peek snapshot={snapshot} tab={tab} needs={needs} />}</aside>
        </div>
      ) : !paneOpen ? (
        <div className="today-body">
          <main className="today-main">{list}</main>
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
  if (n.todo) return void openTodo(n.todo)
  const { sessions, show } = useStore.getState()
  if (n.task && snapshot) void taskPrimary(n.task, snapshot, sessions, show)
}

/** A to-do opens the session it was captured from (resumed if its tab is closed); without one there's nothing to open. */
export async function openTodo(t: MyTodo): Promise<void> {
  if (!t.sessionId) return
  const open = useStore.getState().sessions.some((s) => s.id === t.sessionId)
  await goToSession({ id: t.sessionId, open })
}

/** Ticks a to-do off; the undo line in Needs you puts it back. */
export function finishTodo(t: MyTodo): void {
  void window.workbench.todos.update(t.id, { doneAt: Date.now() })
  useStore.setState({ todoUndo: t })
}

/** The right sidebar: the Needs you item shown (a PR card or the task), or the selected task. */
function Peek({ snapshot, tab, needs }: { snapshot: TasksSnapshot; tab: TodayTab; needs: NeedItem[] }) {
  const { peekTask, setPeekTask, peekNeed, setPeekNeed } = useStore(useShallow((s) => ({ peekTask: s.peekTask, setPeekTask: s.setPeekTask, peekNeed: s.peekNeed, setPeekNeed: s.setPeekNeed })))
  const item = tab === 'needs' ? needs.find((n) => n.key === peekNeed) : undefined
  if (item?.pr) return <NeedPreview item={item} tasks={snapshot} onOpen={() => openNeedItem(item, snapshot)} onClose={() => setPeekNeed(null)} />
  if (item?.todo) return <TodoPreview item={item} onClose={() => setPeekNeed(null)} />
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

/** The row's kind; a to-do's carries a box that ticks it off. The row to start with is marked NEXT. */
function NeedKind({ n, next = false }: { n: NeedItem; next?: boolean }) {
  const tag = next && <span className="need-next">next</span>
  if (!n.todo)
    return (
      <span className={`need-kind need-${n.kind.replace(' ', '-')}`}>
        {tag}
        {n.kind}
      </span>
    )
  const t = n.todo
  return (
    <span className="need-kind need-to-do">
      {tag}
      <button className="todo-check" aria-label={`Done: ${t.text}`} title="Done (x)" onClick={(e) => (e.stopPropagation(), finishTodo(t))} />
      to-do
    </span>
  )
}

/** The PR's repo, `task`, or for a to-do the session it came from in that session's colour (`me` without one). */
function NeedRef({ n, sessions }: { n: NeedItem; sessions: Session[] }) {
  const s = n.todo?.sessionId ? sessions.find((x) => x.id === n.todo!.sessionId) : undefined
  if (!n.todo?.sessionId) return <span className="need-ref">{n.ref}</span>
  return (
    <span className="need-ref todo-sess" style={s ? sessionStyle(s) : undefined} title={s ? s.title : `${n.ref} (closed; ⏎ resumes it)`}>
      {s?.title ?? n.ref}
    </span>
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
  next,
  sleeping,
  active,
}: {
  view: 'needs' | 'tasks'
  snapshot: TasksSnapshot | null
  git: GitSnapshot | null
  needs: NeedItem[]
  next: { key: string; why: string } | null
  sleeping: NeedItem[]
  active: boolean
}) {
  const { sessions, peekTask, setPeekTask, setTodayTab, show, snooze, snoozed, theme } = useStore(
    useShallow((s) => ({ sessions: s.sessions, peekTask: s.peekTask, setPeekTask: s.setPeekTask, setTodayTab: s.setTodayTab, show: s.show, snooze: s.snooze, snoozed: s.snoozed, theme: s.theme })),
  )
  const sleep = (n: NeedItem, forever = false) => snooze(n.key, forever ? UNTIL_CHANGED : tomorrowMorning())
  const setPane = (v: 'needs' | 'tasks') => setTodayTab(v)
  const [needIdx, setNeedIdx] = useState(0)
  const addRef = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState('')
  const todoUndo = useStore((st) => st.todoUndo)
  useEffect(() => {
    if (!todoUndo) return
    const t = setTimeout(() => useStore.setState({ todoUndo: null }), 6000)
    return () => clearTimeout(t)
  }, [todoUndo])
  const addTodo = async () => {
    const { text, due } = parseCapture(adding)
    if (!text) return
    setAdding('')
    await window.workbench.todos.add({ text, due, sessionId: null, sessionTitle: null })
  }
  const addParsed = parseCapture(adding)
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
  const [showSleeping, setShowSleeping] = useState(false)

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
        const target = p && runTarget(p.repo)
        if (p && target) return void runPr(p.number, { target })
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
        if (pane !== 'needs') return false
        if (k === 'a') {
          addRef.current?.focus()
          return true
        }
        if (k === 'x' || k === 'e') {
          const n = needs[needIdx]
          if (!n?.todo) return false
          if (k === 'x') {
            finishTodo(n.todo)
            setNeedIdx((i) => Math.max(0, Math.min(needs.length - 2, i)))
          } else {
            previewNeed(n)
            setTimeout(() => document.querySelector<HTMLInputElement>('.todo-title')?.focus(), 0)
          }
          return true
        }
        if (k !== 'z' && k !== 'Z') return false
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
            <div key={n.key} className={`need-item${next?.key === n.key ? ' next' : ''}`}>
            <div
              className={`need-row${i === needIdx ? ' sel' : ''}${peekNeed === n.key ? ' shown' : ''}`}
              role="button"
              tabIndex={-1}
              onClick={() => (setNeedIdx(i), previewNeed(n))}
              onDoubleClick={() => openNeed(n)}
            >
              <NeedKind n={n} next={next?.key === n.key} />
              <NeedRef n={n} sessions={sessions} />
              <span className="need-text">
                {n.text}
                {n.quote && <span className="need-said">“{n.quote}”</span>}
              </span>
              <span className={`need-detail${(n.todo?.due && n.todo.due < isoDay(new Date())) || n.kind === 'overdue' ? ' bad-text' : ''}`} title={n.at ? exact(n.at) : undefined}>
                {needWhen(n)}
              </span>
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
            {next?.key === n.key && next.why && <div className="need-why">{next.why}</div>}
            </div>
          ))}
          {todoUndo && (
            <div className="todo-undo">
              <span className="ok-text">✓</span> <span className="faint">{todoUndo.text}</span>
              <button className="link-btn" onClick={() => (void window.workbench.todos.update(todoUndo.id, { doneAt: null }), useStore.setState({ todoUndo: null }))}>
                undo
              </button>
            </div>
          )}
          <label className="todo-add">
            <span className="accent-text">+</span>
            <input
              ref={addRef}
              value={adding}
              aria-label="Add a to-do"
              placeholder="add a to-do (a) · a day word at the end sets a date · from anywhere ⌥⌘T"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addTodo()
                if (e.key === 'Escape') (setAdding(''), (e.target as HTMLInputElement).blur())
              }}
            />
            {addParsed.due && adding.trim() && <span className="faint">⏎ add · due {dayText(addParsed.due)}</span>}
          </label>
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
                      {t.design && <FigmaMark design={t.design} />}
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

      {pane === 'needs' && sleeping.length > 0 && (
        <Box
          title={
            <button className="fold-btn" aria-expanded={showSleeping} onClick={() => setShowSleeping(!showSleeping)}>
              {showSleeping ? '▾' : '▸'} Sleeping ({sleeping.length})
            </button>
          }
          className={showSleeping ? undefined : 'folded'}
        >
          {!showSleeping && (
            <button className="fold-line" onClick={() => setShowSleeping(true)}>
              {sleeping.map((n) => n.text).join(' · ')}
            </button>
          )}
          {showSleeping && sleeping.map((n) => (
            <div key={n.key} className="need-row asleep">
              <NeedKind n={n} />
              <NeedRef n={n} sessions={sessions} />
              <span className="need-text">{n.text}</span>
              <span className="need-detail">
                until{' '}
                {!(snoozed[n.key]! > Date.now()) && n.todo?.due
                  ? dayText(n.todo.due)
                  : snoozed[n.key]! >= UNTIL_CHANGED
                    ? 'it changes'
                    : new Date(snoozed[n.key]!).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
              <button
                className="need-sleep wake"
                title="Wake it now"
                onClick={() => (snoozed[n.key]! > Date.now() ? snooze(n.key, null) : n.todo && void window.workbench.todos.update(n.todo.id, { due: isoDay(new Date()) }))}
              >
                wake
              </button>
            </div>
          ))}
        </Box>
      )}
    </div>
  )
}
