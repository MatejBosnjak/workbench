import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Ci, Pr } from '@shared/git'
import { MARK_GLYPH, MARK_WORD, type LinkedSession, type Mark } from '@shared/links'
import { statusVivid, type Task } from '@shared/tasks'
import { openPrLink, useStore } from '../store'

/** The marks every view uses for a task, a PR and a session, and the button that starts a session on a task. */

/** Grows only after the pointer rests this long, so passing over a list doesn't flash. */
const GROW_DELAY = 120

export function ProductiveIcon() {
  return (
    <svg className="chip-icon" width="14" height="12" viewBox="3.5 4.5 25 20.5" aria-hidden="true">
      <path d="m8.695 22.806-4.563-7.712a.946.946 0 0 1 .332-1.296l3.603-2.132a.947.947 0 0 1 1.296.332l2.567 4.34 2.662-4.582c3.33-5.458 6.776.574 5.206 3.138l-4.581 7.886a2.206 2.206 0 0 1-1.9 1.098l-2.716.011a2.207 2.207 0 0 1-1.906-1.083z" fill="#9A3CFF" />
      <path d="M27.992 17.015a3.423 3.423 0 1 1-6.846 0 3.423 3.423 0 0 1 6.846 0zm-14.202 2.47c.752 1.276 2.599 1.27 3.342-.01l2.667-4.59c1.39-2.268 2.962-3.481 4.926-3.749.476-.064.942-.173 1.07-.89l.728-4.09A.96.96 0 0 0 25.584 5c-3.58 0-7.743 1.42-10.99 6.744l-2.665 4.583 1.861 3.157z" fill="#B565FF" />
    </svg>
  )
}

/** A link with a slash through it: takes something off a session. */
export function UnlinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4 8M8 12h3M4 4l16 16" />
    </svg>
  )
}

export function GitHubIcon() {
  return (
    <svg className="chip-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

/** Claude's spark: stands for "session" on buttons. */
export const Spark = () => (
  <span className="spark" aria-hidden="true">
    ✻
  </span>
)

export const MarkGlyph = ({ mark }: { mark: Mark }) => <span className={`mk-${mark}`}>{MARK_GLYPH[mark]}</span>

const CI_WORD: Record<Ci, string> = { pass: 'CI passing', fail: 'CI failing', pending: 'CI running', none: 'no CI' }

export async function goToSession(s: Pick<LinkedSession, 'id' | 'open'>): Promise<void> {
  if (!s.open) await window.workbench.reopenSession(s.id)
  useStore.getState().show({ kind: 'session', id: s.id })
}

export async function startSession(taskId: string): Promise<void> {
  const s = await window.workbench.tasks.start(taskId)
  if (s) useStore.getState().show({ kind: 'session', id: s.id })
}

export function peekTask(t: Pick<Task, 'id'>): void {
  const st = useStore.getState()
  st.setTodayTab('tasks')
  st.setPeekTask(t.id)
}

/**
 * A link chip. When its title is cut short, resting on it grows the same chip out to the full title plus `extra`
 * (the state in words), drawn above the page so no list or strip clips it.
 */
export function Chip({
  className = '',
  style,
  label,
  onClick,
  children,
  extra,
}: {
  className?: string
  style?: CSSProperties
  label: string
  onClick(e: MouseEvent): void
  children: ReactNode
  extra?: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [at, setAt] = useState<{ top: number; left?: number; right?: number; from: number } | null>(null)

  const cut = () => [...(ref.current?.querySelectorAll<HTMLElement>('.chip-t') ?? [])].some((t) => t.scrollWidth > t.clientWidth + 1)
  const enter = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const el = ref.current
      if (!el || !cut()) return
      const r = el.getBoundingClientRect()
      // Near the right edge it grows leftwards instead.
      const leftwards = r.left > window.innerWidth / 2
      setAt({ top: r.top, from: r.width, ...(leftwards ? { right: window.innerWidth - r.right } : { left: r.left }) })
    }, GROW_DELAY)
  }
  const leave = (e: MouseEvent | React.FocusEvent) => {
    clearTimeout(timer.current)
    const to = e.relatedTarget as Node | null
    if (to && (to as HTMLElement).closest?.('.chip-full')) return
    setAt(null)
  }
  useEffect(() => {
    if (!at) return
    const close = () => setAt(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [at])
  useEffect(() => () => clearTimeout(timer.current), [])

  const click = (e: MouseEvent) => {
    e.stopPropagation()
    setAt(null)
    onClick(e)
  }

  return (
    <>
      <button ref={ref} type="button" className={`chip ${className}`} style={style} title={label} aria-label={label} onClick={click} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}>
        {children}
      </button>
      {at &&
        createPortal(
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className={`chip chip-full ${className}${at.right !== undefined ? ' leftwards' : ''}`}
            style={{ ...style, top: at.top, left: at.left, right: at.right, '--from': `${at.from}px` } as CSSProperties}
            onClick={click}
            onMouseLeave={(e) => (e.relatedTarget === ref.current ? undefined : setAt(null))}
          >
            {children}
            {extra}
          </button>,
          document.body,
        )}
    </>
  )
}

/** ▍(status) Productive logo, title. Click shows it in My tasks; ⌘-click opens Productive. */
export function TaskChip({ task, onClick, className = '' }: { task: Task; onClick?: (t: Task) => void; className?: string }) {
  return (
    <Chip
      className={`task ${className}`}
      style={{ '--st': statusVivid({ colorId: task.statusColorId }) } as CSSProperties}
      label={`${task.title} · ${task.statusName}`}
      onClick={(e) => (e.metaKey ? void window.workbench.openExternal(task.url) : (onClick ?? peekTask)(task))}
      extra={<span className="chip-st">{(task.statusName || 'no status').toLowerCase()}</span>}
    >
      <span className="chip-rail" />
      <ProductiveIcon />
      <span className="chip-t">{task.title}</span>
    </Chip>
  )
}

/** GitHub logo, title, CI dot. Click opens it in the GitHub pane; ⌘-click in the browser. */
export function PrChip({ pr, className = '' }: { pr: Pick<Pr, 'url' | 'title' | 'ci'>; className?: string }) {
  return (
    <Chip className={`pr ${className}`} label={`${pr.title} · ${CI_WORD[pr.ci]}`} onClick={(e) => openPrLink(pr.url, e.metaKey)} extra={<span className={`chip-ci ci-text-${pr.ci}`}>{CI_WORD[pr.ci]}</span>}>
      <GitHubIcon />
      <span className="chip-t">{pr.title}</span>
      <span className={`chip-dot ci-${pr.ci}`} />
    </Chip>
  )
}

/** The tab's state dot, title. Click switches to it, reopening a closed one. */
export function SessionChip({ s, className = '' }: { s: LinkedSession; className?: string }) {
  return (
    <Chip className={`sess ${className}`} label={`${s.title} · ${MARK_WORD[s.mark]}`} onClick={() => void goToSession(s)} extra={<span className={`mk-${s.mark}`}>{MARK_WORD[s.mark]}</span>}>
      <MarkGlyph mark={s.mark} />
      <span className="chip-t">{s.title}</span>
    </Chip>
  )
}

/** + new ✻: always a new session on the task, named after it, prompt prefilled, linked. */
export function NewSessionButton({ taskId, short = false, hint = false, inRow = false }: { taskId: string; short?: boolean; hint?: boolean; inRow?: boolean }) {
  const label = (
    <>
      +{short ? ' ' : ' new '}
      <Spark />
      {hint && <span className="faint">s</span>}
    </>
  )
  const start = (e: MouseEvent) => (e.stopPropagation(), void startSession(taskId))
  // Inside a row that is itself a button it can't be a button; the row's `s` key does the same.
  if (inRow)
    return (
      <span className="new-sess in-row" title="New session for this task (s)" onClick={start}>
        {label}
      </span>
    )
  return (
    <button type="button" className="new-sess" title="New session for this task (s)" aria-label="New session for this task" onClick={start}>
      {label}
    </button>
  )
}
