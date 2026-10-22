import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { PortInput, PortMessage, Session } from '@shared/types'
import { onPort } from '../ports'
import { PrCard, type CardAnchor } from './PrCard'
import { xtermTheme } from '../xterm-theme'

interface Props {
  session: Session
  active: boolean
}

const URL_RE = /https?:\/\/[^\s"'<>()\[\]{}]+[^\s"'<>()\[\]{}.,;:!?]/g
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

// Claude prefixes its terminal title with a status glyph (✳ or a spinner frame).
const cleanTitle = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, '').trim()

export function Terminal({ session, active }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm>(null)
  const fit = useRef<FitAddon>(null)
  const alive = useRef(session.alive)
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

    const off = onPort(session.id, (p) => {
      port?.close()
      port = p
      p.onmessage = ({ data }: MessageEvent<PortMessage>) => {
        if (data.type === 'reset') t.reset()
        else t.write(data.data)
      }
      post({ type: 'resize', cols: t.cols, rows: t.rows })
    })

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Claude reads ESC+CR as a newline in the prompt.
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
    // Optimistic: input typed before main reports the pty alive must not be dropped.
    const open = () => {
      alive.current = true
      void window.workbench.openSession(session.id, { cols: t.cols, rows: t.rows })
    }
    t.onData((data) => {
      if (alive.current) post({ type: 'input', data })
      else if (data === '\r') open()
    })
    t.onResize(({ cols, rows }) => post({ type: 'resize', cols, rows }))
    let lastTitle = ''
    t.onTitleChange((raw) => {
      const title = cleanTitle(raw)
      if (title && title !== lastTitle) {
        lastTitle = title
        void window.workbench.setTitle(session.id, title)
      }
    })

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
            activate: (_e: MouseEvent, url: string) => void window.workbench.openExternal(url),
            hover: pr ? (e: MouseEvent, url: string) => setCard({ url, x: e.clientX, y: e.clientY }) : undefined,
            leave: pr ? () => setCard(null) : undefined,
          }
        })
        callback(links.length ? links : undefined)
      },
    })

    const ro = new ResizeObserver(() => {
      if (el.current?.offsetParent !== null) f.fit()
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
      open()
      if (active) t.focus()
    })

    return () => {
      disposed = true
      ro.disconnect()
      off()
      port?.close()
      t.dispose()
    }
    // One terminal per session for its whole life.
  }, [session.id])

  useEffect(() => {
    const t = term.current
    if (alive.current && !session.alive && t) {
      t.write(`\r\n\x1b[2m[${session.state === 'failed' ? 'claude exited with an error' : 'claude exited'} · press Enter to resume]\x1b[0m\r\n`)
    }
    alive.current = session.alive
  }, [session.alive, session.state])

  useEffect(() => {
    if (!active) return
    fit.current?.fit()
    term.current?.focus()
  }, [active])

  return (
    <>
      <div className="term" hidden={!active} ref={el} />
      {active && card && <PrCard anchor={card} />}
    </>
  )
}
