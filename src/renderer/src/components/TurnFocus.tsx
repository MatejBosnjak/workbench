import { useEffect, useLayoutEffect, useState } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { Mark } from '@shared/marks'
import type { Session } from '@shared/types'
import { sessionStyle } from './SessionMark'

/** Where each session was when you left its tab: the first line of claude's input box, and when.
 *  New output starts there, after the blank line claude leaves above each block, so the marker sits in that blank line. */
const left = new Map<string, { line: number; at: number }>()

const RULE = /^\s*─{8,}/
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** The top border of claude's input box (the second rule from the bottom): new output lands above it. */
export function inputTop(t: XTerm): number {
  const b = t.buffer.active
  let seen = 0
  for (let i = b.length - 1; i >= Math.max(0, b.length - 60); i--) {
    if (RULE.test(b.getLine(i)?.translateToString(true) ?? '') && ++seen === 2) return i
  }
  return b.baseY + b.cursorY
}

/** Rows a prompt takes: claude indents its continuation lines and ends the prompt with a blank line. */
function promptRows(t: XTerm, line: number): number {
  const b = t.buffer.active
  let n = 1
  while (n < 12 && /^\s{2}\S/.test(b.getLine(line + n)?.translateToString(true) ?? '')) n++
  return n
}

interface Geo {
  left: number
  top: number
  width: number
  cell: number
  rows: number
  /** First buffer line on screen. */
  view: number
  atBottom: boolean
  inputTop: number
}

function measure(t: XTerm): Geo | null {
  const screen = t.element?.querySelector<HTMLElement>('.xterm-screen')
  const main = screen?.closest('.main')
  if (!screen || !main || !t.rows) return null
  const r = screen.getBoundingClientRect()
  const m = main.getBoundingClientRect()
  const b = t.buffer.active
  return { left: r.left - m.left, top: r.top - m.top, width: r.width, cell: r.height / t.rows, rows: t.rows, view: b.viewportY, atBottom: b.viewportY >= b.baseY, inputTop: inputTop(t) }
}

/**
 * Keeps the current turn in front: turns before your last prompt step back, the prompt gets a rail in the session colour,
 * a "new since you left" line marks where you stopped reading, and "you asked …" pins the prompt once it scrolls off the top.
 */
export function TurnFocus({ session, term, prompt }: { session: Session; term: XTerm; prompt: { mark: Mark; line: number } | null }) {
  const [geo, setGeo] = useState<Geo | null>(null)
  const [since, setSince] = useState(() => {
    const l = left.get(session.id)
    return l && session.lastEventAt > l.at ? l : null
  })
  const [hoverOld, setHoverOld] = useState(false)
  const [selecting, setSelecting] = useState(false)

  // Leaving the tab (switching away, or to Today) records where the new output will start.
  useEffect(() => () => void left.set(session.id, { line: inputTop(term), at: Date.now() }), [session.id, term])

  useLayoutEffect(() => {
    let frame = 0
    const run = () => {
      frame = 0
      const next = measure(term)
      setGeo((old) => (old && next && JSON.stringify(old) === JSON.stringify(next) ? old : next))
    }
    const soon = () => (frame ||= requestAnimationFrame(run))
    run()
    const screen = term.element?.querySelector('.xterm-screen')
    const ro = new ResizeObserver(soon)
    if (screen) ro.observe(screen)
    const subs = [
      term.onScroll(soon),
      term.onWriteParsed(soon),
      term.onResize(soon),
      term.onSelectionChange(() => setSelecting(term.hasSelection())),
      // Sending a prompt means you've caught up.
      term.onData((d) => d.includes('\r') && setSince(null)),
    ]
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      subs.forEach((s) => s.dispose())
    }
  }, [term])

  // Dimmed rows of the screen: everything above your last prompt, while you're at the bottom.
  const dimRows = geo && prompt && geo.atBottom ? Math.max(0, Math.min(geo.rows, prompt.line - geo.view)) : 0

  // Pointing into the dimmed part brings it back.
  useEffect(() => {
    const el = term.element
    if (!el || !geo || !dimRows) return setHoverOld(false)
    const move = (e: MouseEvent) => {
      const screen = el.querySelector('.xterm-screen')!.getBoundingClientRect()
      setHoverOld(e.clientY >= screen.top && e.clientY < screen.top + dimRows * geo.cell)
    }
    const out = () => setHoverOld(false)
    el.addEventListener('mousemove', move)
    el.addEventListener('mouseleave', out)
    return () => {
      el.removeEventListener('mousemove', move)
      el.removeEventListener('mouseleave', out)
    }
  }, [term, geo, dimRows])

  if (!geo) return null
  const row = (line: number) => line - geo.view
  const onScreen = (line: number) => row(line) >= 0 && row(line) < geo.rows
  const y = (line: number) => geo.top + row(line) * geo.cell

  const pRow = prompt ? row(prompt.line) : -1
  const pRows = prompt ? promptRows(term, prompt.line) : 0
  const sinceShown = since && since.line < geo.inputTop && onScreen(since.line)
  const pinned = prompt && pRow < 0

  return (
    <div className="turn-focus" style={sessionStyle(session)} aria-hidden={!pinned}>
      {dimRows > 0 && !hoverOld && !selecting && <div className="turn-dim" style={{ left: geo.left - 26, width: geo.width + 26, top: geo.top - 12, height: dimRows * geo.cell + 12 }} />}
      {prompt && pRow + pRows > 0 && pRow < geo.rows && (
        <div className="turn-rail" style={{ left: geo.left - 12, top: Math.max(geo.top, y(prompt.line)), height: (Math.min(pRow + pRows, geo.rows) - Math.max(pRow, 0)) * geo.cell }} />
      )}
      {sinceShown && (
        <div className="turn-since" style={{ left: geo.left - 12, width: geo.width + 12, top: y(since.line) - geo.cell / 2 - 7 }}>
          <span>new since you left · {time(since.at)}</span>
        </div>
      )}
      {pinned && (
        <button
          className="turn-pin"
          style={{ left: geo.left - 26, width: geo.width + 26, top: geo.top - 12 }}
          title={`Your prompt at ${time(prompt.mark.at)}: jump to it`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            term.scrollToLine(Math.max(0, prompt.line - 1))
            term.focus()
          }}
        >
          <span className="turn-pin-k">you asked</span>
          <span className="turn-pin-t">{prompt.mark.text}</span>
          <span className="turn-pin-j">↑ jump</span>
        </button>
      )}
    </div>
  )
}
