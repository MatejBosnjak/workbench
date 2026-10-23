import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { statusColors, type Person, type Task, type TaskComment, type TaskDetail } from '@shared/tasks'
import { Box } from './Box'

/**
 * Task details by id, shared by the card's status select and the Productive section. Shows the last fetch at once
 * while a fresh one loads; a write's result replaces it for both.
 */
const cache = new Map<string, TaskDetail>()
const listeners = new Set<() => void>()
const put = (id: string, d: TaskDetail) => {
  cache.set(id, d)
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The task's detail, fetched fresh each time the task is shown. */
function useTaskDetail(taskId: string): {
  detail: TaskDetail | null
  error: string | null
} {
  const detail = useSyncExternalStore(subscribe, () => cache.get(taskId) ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setError(null)
    window.workbench.tasks.detail(taskId).then(
      (d) => put(taskId, d),
      (e) => live && setError(clean(e)),
    )
    return () => {
      live = false
    }
  }, [taskId])
  return { detail, error }
}

/** Runs a write (which asks for a confirm in main); null means it was cancelled. */
function useWrite(taskId: string) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const write = async (key: string, run: () => Promise<TaskDetail | null>) => {
    setBusy(key)
    setError(null)
    try {
      const d = await run()
      if (d) put(taskId, d)
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, write }
}

/** The card's status line: a select over the task's workflow, in Productive's colours. Plain text until the statuses load. */
export function StatusSelect({ task }: { task: Task }) {
  const { detail } = useTaskDetail(task.id)
  const { busy, error, write } = useWrite(task.id)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const root = useRef<HTMLSpanElement>(null)
  const statuses = detail?.statuses ?? []
  const current = statuses.find((s) => s.id === detail?.statusId)
  const [bg, fg] = current ? statusColors(current) : statusColors({ colorId: task.statusColorId })

  // Closes on a click anywhere else.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const choose = (id: string) => {
    setOpen(false)
    if (id !== detail?.statusId) void write('status', () => window.workbench.tasks.setStatus(task.id, id))
  }
  const toggle = () => {
    if (!statuses.length || busy) return
    setAt(Math.max(0, statuses.findIndex((s) => s.id === detail?.statusId)))
    setOpen(!open)
  }

  return (
    <span className="status-select" ref={root}>
      <button
        className="ss-button"
        style={{ background: bg, color: fg }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Status: ${current?.name ?? task.statusName}`}
        disabled={!!busy}
        onClick={toggle}
        onKeyDown={(e) => {
          // The button's own keys; ⏎ here must not also reach the screen's ⏎ (open the task).
          if (!open) {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), toggle())
            return
          }
          e.stopPropagation()
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : statuses.length - 1)) % statuses.length)
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            choose(statuses[at]!.id)
          } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false)
        }}
      >
        {busy ? 'saving…' : (current?.name ?? task.statusName)}
        {statuses.length > 0 && <span aria-hidden="true"> ▾</span>}
      </button>
      {open && (
        <span className="ss-menu" role="listbox" aria-label="Status">
          {statuses.map((s, i) => {
            const [b, f] = statusColors(s)
            return (
              <button
                key={s.id}
                role="option"
                aria-selected={s.id === detail?.statusId}
                className={`ss-option${i === at ? ' at' : ''}`}
                tabIndex={-1}
                onMouseEnter={() => setAt(i)}
                onClick={() => choose(s.id)}
              >
                <span style={{ background: b, color: f }}>{s.name}</span>
                {s.id === detail?.statusId && <span className="faint">✓</span>}
              </button>
            )
          })}
        </span>
      )}
      {error && <span className="bad-text">{error}</span>}
    </span>
  )
}

/** Plain text with its URLs as links that open in the browser. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(p))}>
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

const when = (iso: string) => {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return new Date().toDateString() === d.toDateString() ? `today ${time}` : `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

/** A comment's text: tags in the accent colour, URLs as links. */
function CommentBody({ c }: { c: TaskComment }) {
  const names = [...new Set(c.mentions)].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!names.length) return <Linked text={c.body} />
  const re = new RegExp(`(${names.map((n) => `@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join('|')})`, 'g')
  return (
    <>
      {c.body.split(re).map((part, i) =>
        i % 2 ? (
          <span key={i} className="td-mention">
            {part}
          </span>
        ) : (
          <Linked key={i} text={part} />
        ),
      )}
    </>
  )
}

/** People are the same for every task; loaded on the first @. */
let people: Promise<Person[]> | null = null

/** The @query being typed just before the caret, if any. */
const tagQuery = (before: string) => /(?:^|\s)@([^\s@]*(?: [^\s@]*)?)$/u.exec(before)?.[1] ?? null

/** Writing a comment: @ tags people (they get notified), ⌘⏎ posts after the confirm, or Claude drafts it. */
function Composer({ detail }: { detail: TaskDetail }) {
  const taskId = detail.task.id
  const [text, setText] = useState('')
  const [tagged, setTagged] = useState<Person[]>([])
  const [all, setAll] = useState<Person[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [pick, setPick] = useState(0)
  const [state, setState] = useState<'idle' | 'posting' | 'drafting'>('idle')
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText('')
    setTagged([])
    setQuery(null)
    setError(null)
  }, [taskId])

  const q = query?.toLowerCase() ?? ''
  const matches = query === null ? [] : all.filter((p) => p.name.toLowerCase().split(' ').some((w, i, ws) => ws.slice(i).join(' ').startsWith(q))).slice(0, 6)

  const onInput = (value: string, caret: number) => {
    setText(value)
    const found = tagQuery(value.slice(0, caret))
    setQuery(found)
    setPick(0)
    if (found !== null && !people) people = window.workbench.tasks.people()
    if (found !== null) void people!.then(setAll, () => (people = null))
  }

  const tag = (p: Person) => {
    const el = box.current!
    const caret = el.selectionStart
    const before = text.slice(0, caret).replace(/@[^\s@]*(?: [^\s@]*)?$/u, `@${p.name} `)
    const next = before + text.slice(caret)
    setText(next)
    setTagged((t) => (t.some((x) => x.id === p.id) ? t : [...t, p]))
    setQuery(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }

  const post = async () => {
    if (!text.trim() || state !== 'idle') return
    setState('posting')
    setError(null)
    try {
      const d = await window.workbench.tasks.comment(taskId, text, tagged.filter((p) => text.includes(`@${p.name}`)))
      if (d) {
        put(taskId, d)
        setText('')
        setTagged([])
      }
    } catch (e) {
      setError(clean(e))
    } finally {
      setState('idle')
    }
  }

  const draft = async () => {
    setState('drafting')
    setError(null)
    try {
      setText(await window.workbench.git.compose({ kind: 'productive', key: `task:${taskId}`, taskId, title: detail.task.title }, text))
    } catch (e) {
      setError(clean(e))
    } finally {
      setState('idle')
    }
  }

  return (
    <div className="td-compose">
      <textarea
        ref={box}
        rows={3}
        aria-label="New comment"
        placeholder="Write a comment… @ to tag"
        value={text}
        disabled={state !== 'idle'}
        onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              tag(matches[pick]!)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setQuery(null)
              return
            }
          }
          if (e.key === 'Enter' && e.metaKey) {
            e.preventDefault()
            void post()
          }
        }}
      />
      {matches.length > 0 && (
        <div className="td-people" role="listbox" aria-label="People">
          {matches.map((p, i) => (
            <button key={p.id} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), tag(p))}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="td-compose-bar">
        <button className="key-btn primary-key" disabled={!text.trim() || state !== 'idle'} onClick={() => void post()}>
          {state === 'posting' ? 'posting…' : '⌘⏎ post'}
        </button>
        <button className="link-btn" disabled={state !== 'idle'} onClick={() => void draft()}>
          {state === 'drafting' ? 'drafting…' : 'draft with Claude'}
        </button>
        <span className="faint">@ tags · asks before posting</span>
      </div>
      {error && <span className="bad-text">{error}</span>}
    </div>
  )
}

/** The task as Productive has it: description, to-dos and comments. Every write asks first. */
export function TaskDetails({ taskId, withTitle = false }: { taskId: string; withTitle?: boolean }) {
  const { detail, error: loadError } = useTaskDetail(taskId)
  const { busy, error, write } = useWrite(taskId)
  const open = detail?.todos.filter((t) => !t.closed).length ?? 0

  return (
    <Box title="Productive" className="peek task-details">
      {!detail && !loadError && <span className="faint">loading…</span>}
      {(loadError || error) && <span className="bad-text">{loadError || error}</span>}
      {detail && (
        <>
          {withTitle && (
            <div className="peek-head">
              <h2 className="peek-title">
                <a href={detail.task.url} title="Open in Productive" style={{ textDecorationColor: statusColors({ colorId: detail.task.statusColorId })[1] }} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(detail.task.url))}>
                  {detail.task.title}
                </a>
              </h2>
              <StatusSelect task={detail.task} />
            </div>
          )}

          <div className="peek-sub">description</div>
          {detail.description ? (
            <div className="td-desc">
              <Linked text={detail.description} />
            </div>
          ) : (
            <span className="faint">none</span>
          )}

          <div className="peek-sub">
            to-dos{' '}
            {detail.todos.length > 0 && (
              <span className="faint">
                {detail.todos.length - open}/{detail.todos.length}
              </span>
            )}
          </div>
          {detail.todos.length === 0 && <span className="faint">none</span>}
          {detail.todos.map((t) => (
            <label key={t.id} className={`td-todo${t.closed ? ' done' : ''}${busy === `t:${t.id}` ? ' busy' : ''}`}>
              <input type="checkbox" checked={t.closed} disabled={!!busy} onChange={() => void write(`t:${t.id}`, () => window.workbench.tasks.setTodo(taskId, t.id, !t.closed))} />
              <span>
                <Linked text={t.text} />
              </span>
            </label>
          ))}

          <div className="peek-sub">
            comments {detail.comments.length > 0 && <span className="faint">{detail.comments.length}</span>}
          </div>
          {detail.comments.map((c) => (
            <div key={c.id} className="td-comment">
              <div>
                <span className="td-author">{c.author}</span> <span className="faint">· {when(c.at)}</span>
              </div>
              <div className="td-comment-body">
                <CommentBody c={c} />
              </div>
            </div>
          ))}
          <Composer detail={detail} />
        </>
      )}
    </Box>
  )
}
