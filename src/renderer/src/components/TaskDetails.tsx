import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { statusColors, type Person, type Task, type TaskComment, type TaskDetail } from '@shared/tasks'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
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

/** A URL as it reads best: a GitHub PR or issue as "frontend PR" (the number is in the tooltip), anything else without its scheme. */
export function shortUrl(url: string): string {
  const gh = url.match(/^https?:\/\/github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)\/?$/)
  return gh ? `${gh[1]} ${url.includes('/issues/') ? 'issue' : 'PR'}` : url.replace(/^https?:\/\/(www\.)?/, '')
}

/** Plain text with its URLs as links that open in the browser. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} title={p} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(p))}>
            {shortUrl(p)}
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

const loadPeople = () => (people ??= window.workbench.tasks.people().catch((e) => ((people = null), Promise.reject(e))))

/** Whether a name has a word starting the (lowercase) query, so "bos" and "matej b" both find Matej Bosnjak. */
const nameMatches = (name: string, q: string) => name.toLowerCase().split(' ').some((_, i, ws) => ws.slice(i).join(' ').startsWith(q))

const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

/** Productive's photo, or initials when there's none or it fails to load; a dashed ring when nobody's assigned. */
export function Avatar({ name, url, mine }: { name: string | null; url?: string | null; mine?: boolean }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  const cls = `avatar${mine ? ' mine' : ''}`
  if (!name) return <span className="avatar none" aria-hidden="true" />
  if (url && !broken) return <img className={cls} src={url} alt="" onError={() => setBroken(true)} />
  return (
    <span className={cls} aria-hidden="true">
      {initials(name)}
    </span>
  )
}

/** An avatar that opens a searchable list of people, Unassigned first, as in Productive. */
function PersonPicker({ id, name, disabled, onPick }: { id: string | null; name: string | null; disabled?: boolean; onPick(p: Person | null): void }) {
  const [all, setAll] = useState<Person[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const root = useRef<HTMLSpanElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = all.find((p) => p.id === id)

  useEffect(() => void loadPeople().then(setAll, () => {}), [])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useEffect(() => list.current?.children[at]?.scrollIntoView({ block: 'nearest' }), [at])

  const q = query.trim().toLowerCase()
  const options: (Person | null)[] = [...(q ? [] : [null]), ...all.filter((p) => !q || nameMatches(p.name, q))]
  const pick = (p: Person | null) => {
    setOpen(false)
    if ((p?.id ?? null) !== id) onPick(p)
  }

  return (
    <span className="person-picker" ref={root}>
      <button
        className="pp-button"
        type="button"
        title={name ?? 'Unassigned'}
        aria-label={`Assignee: ${name ?? 'unassigned'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery('')
          setAt(0)
          setOpen(!open)
        }}
      >
        <Avatar name={name} url={current?.avatarUrl} />
      </button>
      {open && (
        <span className="pp-menu">
          <input
            autoFocus
            aria-label="Search people"
            placeholder="Search people…"
            value={query}
            onChange={(e) => (setQuery(e.target.value), setAt(0))}
            onKeyDown={(e) => {
              // Its keys stay here; ⏎ must not also reach the screen's ⏎ (open the task).
              e.stopPropagation()
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (options.length) setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (options[at] !== undefined) pick(options[at]!)
              } else if (e.key === 'Escape') setOpen(false)
            }}
          />
          <div className="pp-list" role="listbox" aria-label="People" ref={list}>
            {options.map((p, i) => (
              <button
                key={p?.id ?? 'none'}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={(p?.id ?? null) === id}
                className={`pp-option${i === at ? ' at' : ''}`}
                onMouseEnter={() => setAt(i)}
                onClick={() => pick(p)}
              >
                <Avatar name={p?.name ?? null} url={p?.avatarUrl} />
                <span>{p?.name ?? 'Unassigned'}</span>
                {(p?.id ?? null) === id && <span className="faint">✓</span>}
              </button>
            ))}
            {!options.length && <span className="faint pp-empty">{all.length ? 'nobody matches' : 'loading…'}</span>}
          </div>
        </span>
      )}
    </span>
  )
}

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
  const [focused, setFocused] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  // One line until it's in use: focused, holding text, or posting/drafting.
  const expanded = focused || !!text || state !== 'idle'

  useEffect(() => {
    setText('')
    setTagged([])
    setQuery(null)
    setError(null)
  }, [taskId])

  const q = query?.toLowerCase() ?? ''
  const matches = query === null ? [] : all.filter((p) => nameMatches(p.name, q)).slice(0, 6)

  const onInput = (value: string, caret: number) => {
    setText(value)
    const found = tagQuery(value.slice(0, caret))
    setQuery(found)
    setPick(0)
    if (found !== null) void loadPeople().then(setAll, () => {})
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
    <div
      className={`td-compose${expanded ? '' : ' collapsed'}`}
      // Clicking the bar's buttons blurs the box; keep focus state until the click lands.
      onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}
    >
      <textarea
        ref={box}
        rows={expanded ? 3 : 1}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
      {expanded && (
      <div className="td-compose-bar">
        <button className="key-btn primary-key" disabled={!text.trim() || state !== 'idle'} onClick={() => void post()}>
          {state === 'posting' ? 'posting…' : '⌘⏎ post'}
        </button>
        <button className="link-btn" disabled={state !== 'idle'} onClick={() => void draft()}>
          {state === 'drafting' ? 'drafting…' : 'draft with Claude'}
        </button>
        <span className="faint">@ tags · asks before posting</span>
      </div>
      )}
      {error && <span className="bad-text">{error}</span>}
    </div>
  )
}

/** A new to-do: its text and, optionally, who it's for. ⏎ adds after the confirm, esc cancels. */
function AddTodo({ detail, done }: { detail: TaskDetail; done(): void }) {
  const [text, setText] = useState('')
  const [assignee, setAssignee] = useState<Person | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const d = await window.workbench.tasks.addTodo(detail.task.id, text, assignee)
      if (d) {
        put(detail.task.id, d)
        done()
      }
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="td-new-todo">
      <input
        autoFocus
        aria-label="New to-do"
        placeholder="New to-do"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add()
          if (e.key === 'Escape') done()
        }}
      />
      <PersonPicker id={assignee?.id ?? null} name={assignee?.name ?? null} disabled={busy} onPick={setAssignee} />
      <button className="key-btn primary-key" disabled={!text.trim() || busy} onClick={() => void add()}>
        {busy ? 'adding…' : '⏎ add'}
      </button>
      {error && <span className="bad-text">{error}</span>}
    </div>
  )
}

/** The task as Productive has it: description, to-dos and comments. Comments and to-do adds and ticks ask first. */
export function TaskDetails({ taskId, withTitle = false }: { taskId: string; withTitle?: boolean }) {
  const { detail, error: loadError } = useTaskDetail(taskId)
  const { busy, error, write } = useWrite(taskId)
  const open = detail?.todos.filter((t) => !t.closed).length ?? 0
  const { hideDone, setHideDone } = useStore(useShallow((s) => ({ hideDone: s.hideDoneTodos, setHideDone: s.setHideDoneTodos })))
  const done = (detail?.todos.length ?? 0) - open
  // On someone else's task, my open to-dos are why it's in my list: they stand out.
  const mineHere = (t: { assigneeId?: string | null; closed: boolean }) => !!detail && !t.closed && t.assigneeId === detail.me && !!detail.task.assignedTo && detail.task.assignedTo.id !== detail.me
  const [adding, setAdding] = useState(false)
  useEffect(() => setAdding(false), [taskId])

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
            <button className="td-add" aria-label="Add a to-do" title="Add a to-do" aria-expanded={adding} onClick={() => setAdding(!adding)}>
              +
            </button>
            {done > 0 && (
              <button className="td-toggle" aria-pressed={!hideDone} title={hideDone ? 'Show completed to-dos' : 'Hide completed to-dos'} onClick={() => setHideDone(!hideDone)}>
                {hideDone ? `show ${done} done` : 'hide done'}
              </button>
            )}
          </div>
          {adding && <AddTodo detail={detail} done={() => setAdding(false)} />}
          {detail.todos.length === 0 && !adding && <span className="faint">none</span>}
          {detail.todos.length > 0 && hideDone && open === 0 && <span className="faint">all done</span>}
          {detail.todos.filter((t) => !(hideDone && t.closed)).map((t) => (
            <div key={t.id} className={`td-todo${t.closed ? ' done' : ''}${mineHere(t) ? ' mine' : ''}${busy === `t:${t.id}` ? ' busy' : ''}`}>
              <label>
                <input type="checkbox" checked={t.closed} disabled={!!busy} onChange={() => void write(`t:${t.id}`, () => window.workbench.tasks.setTodo(taskId, t.id, !t.closed))} />
                <span>
                  <Linked text={t.text} />
                </span>
              </label>
              <PersonPicker
                id={t.assigneeId ?? null}
                name={t.assignee ?? null}
                disabled={!!busy}
                onPick={(p) => void write(`t:${t.id}`, () => window.workbench.tasks.assignTodo(taskId, t.id, p?.id ?? null))}
              />
            </div>
          ))}

          <div className="peek-sub">
            comments {detail.comments.length > 0 && <span className="faint">{detail.comments.length}</span>}
          </div>
          <Composer detail={detail} />
          {[...detail.comments].reverse().map((c) => (
            <div key={c.id} className="td-comment">
              <div>
                <span className="td-author">{c.author}</span> <span className="faint">· {when(c.at)}</span>
              </div>
              <div className="td-comment-body">
                <CommentBody c={c} />
              </div>
            </div>
          ))}
        </>
      )}
    </Box>
  )
}
