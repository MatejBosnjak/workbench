import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { PortInput, PortMessage } from '@shared/types'
import { onPort } from '../ports'
import { openPrLink, useStore } from '../store'
import { xtermTheme } from '../xterm-theme'
import { PrCard, type CardAnchor } from './PrCard'

export interface TermViewProps {
  /** The pty id main streams over a MessagePort. */
  id: string
  /** Visible and focused. Hidden terminals stay mounted and keep their buffer. */
  active: boolean
  alive: boolean
  /** Asks main to attach (and spawn if needed); called once the terminal has a size. */
  open(size: { cols: number; rows: number }): void
  /** Enter in a dead terminal calls this; omit to ignore input while dead. */
  revive?(size: { cols: number; rows: number }): void
  /** Printed when the process exits. */
  exitMessage?: string
  onTitle?(title: string): void
  className?: string
  /** Hidden terminals use visibility (keeps their size); panes are always visible. */
  hideWhenInactive?: boolean
  /** Take focus when shown. Panes leave focus alone; a click focuses them. */
  autoFocus?: boolean
}

const URL_RE = /https?:\/\/[^\s"'<>()\[\]{}]+[^\s"'<>()\[\]{}.,;:!?]/g
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

function openLink(e: MouseEvent, url: string): void {
  if (PR_RE.test(url)) openPrLink(url, e.metaKey)
  else void window.workbench.openExternal(url)
}

export function TermView(props: TermViewProps) {
  const { id, active, alive, exitMessage, className = 'term', hideWhenInactive = true, autoFocus = true } = props
  const el = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm>(null)
  const fit = useRef<FitAddon>(null)
  const aliveRef = useRef(alive)
  // Callbacks change identity every render; the terminal is created once.
  const cb = useRef(props)
  cb.current = props
  const [card, setCard] = useState<CardAnchor | null>(null)

  useEffect(() => {
    const t = new XTerm({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: xtermTheme(),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    term.current = t
    fit.current = f

    let port: MessagePort | null = null
    const post = (m: PortInput) => port?.postMessage(m)
    const size = () => ({ cols: t.cols, rows: t.rows })

    const off = onPort(id, (p) => {
      port?.close()
      port = p
      p.onmessage = ({ data }: MessageEvent<PortMessage>) => {
        if (data.type === 'reset') t.reset()
        else t.write(data.data)
      }
      post({ type: 'resize', ...size() })
    })

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Claude reads ESC+CR as a newline in the prompt; shells ignore it.
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        post({ type: 'input', data: '\x1b\r' })
        return false
      }
      if (e.key === 'c' && e.metaKey && t.hasSelection()) {
        void navigator.clipboard.writeText(t.getSelection())
        return false
      }
      return true
    })
    t.onData((data) => {
      if (aliveRef.current) post({ type: 'input', data })
      else if (data === '\r' && cb.current.revive) {
        // Optimistic: input typed before main reports the pty alive must not be dropped.
        aliveRef.current = true
        cb.current.revive(size())
      }
    })
    t.onResize(({ cols, rows }) => post({ type: 'resize', cols, rows }))
    t.onTitleChange((title) => cb.current.onTitle?.(title))

    // Links: any http(s) URL opens in the browser; GitHub PR links also get a hover card.
    t.registerLinkProvider({
      provideLinks(y, callback) {
        const text = t.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const links = [...text.matchAll(URL_RE)].map((m) => {
          const pr = PR_RE.exec(m[0])?.[0]
          return {
            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
            text: pr ?? m[0],
            decorations: { underline: true, pointerCursor: true },
            activate: (e: MouseEvent, url: string) => openLink(e, url),
            hover: pr ? (e: MouseEvent, url: string) => setCard({ url, x: e.clientX, y: e.clientY }) : undefined,
            leave: pr ? () => setCard(null) : undefined,
          }
        })
        callback(links.length ? links : undefined)
      },
    })

    const ro = new ResizeObserver(() => {
      if (el.current && el.current.offsetParent !== null && el.current.clientWidth > 0) f.fit()
    })

    let disposed = false
    void document.fonts.load("13px 'JetBrains Mono'").finally(() => {
      if (disposed || !el.current) return
      t.open(el.current)
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => gl.dispose())
        t.loadAddon(gl)
      } catch {
        // falls back to the DOM renderer
      }
      f.fit()
      ro.observe(el.current)
      // A revivable terminal spawns on open; treat it as alive so early typing isn't dropped.
      if (cb.current.revive) aliveRef.current = true
      cb.current.open(size())
      if (cb.current.active && cb.current.autoFocus !== false) t.focus()
    })

    return () => {
      disposed = true
      ro.disconnect()
      off()
      port?.close()
      t.dispose()
    }
  }, [id])

  useEffect(() => {
    const t = term.current
    if (aliveRef.current && !alive && t && exitMessage) t.write(`\r\n\x1b[2m[${exitMessage}]\x1b[0m\r\n`)
    aliveRef.current = alive
  }, [alive, exitMessage])

  const showTick = useStore((s) => s.showTick)
  useEffect(() => {
    if (!active) return
    fit.current?.fit()
    if (autoFocus) term.current?.focus()
  }, [active, autoFocus, showTick])

  return (
    <>
      <div className={className} hidden={hideWhenInactive && !active} ref={el} onMouseDown={() => term.current?.focus()} />
      {card && <PrCard anchor={card} />}
    </>
  )
}
