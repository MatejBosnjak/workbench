import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { candidates, MARK_LABEL, placeMarks, stepMark, type Mark } from '@shared/marks'
import type { Session } from '@shared/types'
import { onTerms, termFor } from './TermView'

interface Placed {
  mark: Mark
  line: number
}

interface Layout {
  placed: Placed[]
  /** The buffer's height in lines: scrollback plus the screen. */
  total: number
  /** Marks older than the first one still in the scrollback. */
  earlier: Mark[]
  wide: boolean
}

const EMPTY: Layout = { placed: [], total: 1, earlier: [], wide: true }
/** Below this the rail hides (28 rem); ⌘[ / ⌘] still work. */
const MIN_WIDTH = 448
const MEASURE_MS = 150

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const nameOf = (m: Mark) => `${MARK_LABEL[m.kind]} at ${time(m.at)}: ${m.text}`
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function measure(t: XTerm, marks: Mark[]): Layout {
  const b = t.buffer.active
  const line = (i: number) => b.getLine(i)?.translateToString(true) ?? ''
  const at = placeMarks(marks, candidates(b.length, line))
  const placed = marks.flatMap((mark) => (at.has(mark.id) ? [{ mark, line: at.get(mark.id)! }] : []))
  const first = placed[0] ? marks.indexOf(placed[0].mark) : marks.length
  return { placed, total: Math.max(1, b.length), earlier: marks.slice(0, first), wide: (t.element?.clientWidth ?? 0) >= MIN_WIDTH }
}

/** Briefly outlines the line a jump landed on. */
function flash(t: XTerm, line: number): void {
  const b = t.buffer.active
  const marker = t.registerMarker(line - (b.baseY + b.cursorY))
  if (!marker) return
  const deco = t.registerDecoration({ marker, width: t.cols, layer: 'top' })
  deco?.onRender((el) => el.classList.add('mark-flash'))
  setTimeout(() => {
    deco?.dispose()
    marker.dispose()
  }, 1200)
}

let stepActive: ((dir: 1 | -1) => void) | null = null
/** ⌘[ / ⌘]: the previous / next bookmark in the session on screen. */
export function stepMarks(dir: 1 | -1): void {
  stepActive?.(dir)
}

/** The bookmark rail beside a session's terminal: one mark per prompt, Subagent result and question. */
export function MarkRail({ session }: { session: Session }) {
  const term = useSyncExternalStore(onTerms, () => termFor(session.id))
  const [marks, setMarks] = useState<Mark[]>([])
  const [layout, setLayout] = useState<Layout>(EMPTY)
  const [hover, setHover] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [stop, setStop] = useState(0)
  const keyFocus = useRef(false)
  const btns = useRef<(HTMLButtonElement | null)[]>([])
  // The mark last jumped to and where that left the viewport: stepping goes on from it until the user scrolls.
  const from = useRef<{ index: number; top: number } | null>(null)

  // The transcript grows on every hook event (lastEventAt moves with it) and while output streams.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!term) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const sub = term.onWriteParsed(() => (timer ??= setTimeout(() => ((timer = undefined), setTick((n) => n + 1)), 2000)))
    return () => {
      clearTimeout(timer)
      sub.dispose()
    }
  }, [term])
  useEffect(() => {
    let live = true
    void window.workbench.sessionMarks(session.id).then((m) => live && setMarks((old) => (old.length === m.length && old.at(-1)?.id === m.at(-1)?.id ? old : m)))
    return () => void (live = false)
  }, [session.id, session.lastEventAt, session.state, tick])

  useEffect(() => {
    from.current = null
    setStop(0)
  }, [session.id])

  useEffect(() => {
    if (!term) return setLayout(EMPTY)
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = ''
    const run = () => {
      timer = undefined
      const next = measure(term, marks)
      const key = `${next.total}|${next.wide}|${next.earlier.length}|${next.placed.map((p) => `${p.mark.id}:${p.line}`).join(',')}`
      if (key !== last) {
        last = key
        setLayout(next)
      }
    }
    const soon = () => (timer ??= setTimeout(run, MEASURE_MS))
    run()
    const subs = [term.onWriteParsed(soon), term.onResize(soon)]
    return () => {
      clearTimeout(timer)
      subs.forEach((s) => s.dispose())
    }
  }, [term, marks])

  const { placed, total, earlier, wide } = layout

  const jump = (i: number) => {
    const p = placed[i]
    if (!term || !p) return
    term.scrollToLine(Math.max(0, p.line - 1))
    if (!reducedMotion()) flash(term, p.line)
    from.current = { index: i, top: term.buffer.active.viewportY }
    setStop(i)
  }

  const step = (dir: 1 | -1) => {
    if (!term) return
    const top = term.buffer.active.viewportY
    const held = from.current && from.current.top === top ? from.current.index : null
    const i = stepMark(
      placed.map((p) => p.line),
      top,
      dir,
      held,
    )
    if (i !== null) jump(i)
  }
  const stepRef = useRef(step)
  stepRef.current = step
  useEffect(() => {
    const fn = (dir: 1 | -1) => stepRef.current(dir)
    stepActive = fn
    return () => {
      if (stepActive === fn) stepActive = null
    }
  }, [])

  if (!placed.length || !wide) return null

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? placed.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const j = Math.max(0, Math.min(placed.length - 1, to))
    keyFocus.current = true
    setStop(j)
    btns.current[j]?.focus()
  }
  const tip = hover ?? focus
  const shown = placed.findIndex((p) => p.mark.id === tip)
  const top = (line: number) => `calc(8px + (100% - 16px) * ${Math.min(1, line / total)})`

  return (
    <nav className="marks" aria-label="Bookmarks">
      {earlier.length > 0 && (
        <span className="marks-earlier" title={`${earlier.length} earlier, past the scrollback:\n${earlier.map((m) => `${time(m.at)}  ${m.text}`).join('\n')}`}>
          +{earlier.length}
        </span>
      )}
      <div role="toolbar" aria-orientation="vertical" aria-label="Bookmarks" className="marks-bar">
        {placed.map((p, i) => (
          <button
            key={p.mark.id}
            ref={(el) => void (btns.current[i] = el)}
            className={`mark mark-${p.mark.kind}${keyFocus.current ? ' key' : ''}`}
            style={{ top: top(p.line) }}
            tabIndex={i === Math.min(stop, placed.length - 1) ? 0 : -1}
            aria-label={nameOf(p.mark)}
            onMouseEnter={() => setHover(p.mark.id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setFocus(p.mark.id)}
            onBlur={() => {
              setFocus(null)
              keyFocus.current = false
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              jump(i)
              // A click hands the keyboard back to the terminal; Enter on a focused mark keeps it here.
              if (e.detail > 0) term?.focus()
            }}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span aria-hidden="true" />
          </button>
        ))}
      </div>
      {shown >= 0 && (
        <div className="mark-tip" aria-hidden="true" style={{ top: top(placed[shown]!.line) }}>
          <div className="mark-tip-text">{placed[shown]!.mark.text}</div>
          <div className="mark-tip-meta">
            {MARK_LABEL[placed[shown]!.mark.kind]} · {time(placed[shown]!.mark.at)}
          </div>
        </div>
      )}
    </nav>
  )
}
