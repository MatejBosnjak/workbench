import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type { PortInput, PortMessage } from '@shared/types'

const FLUSH_MS = 8
const FLUSH_BYTES = 64 * 1024
const SCROLLBACK_BYTES = 4 * 1024 * 1024

interface Entry {
  proc: pty.IPty
  port?: MessagePortMain
  pending: string
  timer?: NodeJS.Timeout
  // Kept so a reloaded renderer can rebuild the screen.
  history: string[]
  historyBytes: number
  exited: Promise<void>
  size: { cols: number; rows: number }
  wc?: WebContents
}

export interface SpawnOpts {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export class PtyHost {
  private entries = new Map<string, Entry>()

  constructor(private onExit: (id: string, code: number) => void) {}

  has(id: string): boolean {
    return this.entries.has(id)
  }

  spawn(id: string, o: SpawnOpts): void {
    const proc = pty.spawn(o.file, o.args, {
      name: 'xterm-256color',
      cwd: o.cwd,
      env: o.env,
      cols: o.cols,
      rows: o.rows,
    })
    let onExited!: () => void
    const e: Entry = { proc, pending: '', history: [], historyBytes: 0, exited: new Promise((r) => (onExited = r)), size: { cols: o.cols, rows: o.rows } }
    this.entries.set(id, e)

    proc.onData((data) => {
      e.pending += data
      this.remember(e, data)
      if (e.pending.length >= FLUSH_BYTES) this.flush(e)
      else e.timer ??= setTimeout(() => this.flush(e), FLUSH_MS)
    })
    proc.onExit(({ exitCode }) => {
      this.flush(e)
      e.port?.close()
      this.entries.delete(id)
      this.onExit(id, exitCode)
      onExited()
    })
  }

  /** Hands the renderer a fresh port for this pty and replays scrollback into it. */
  attach(id: string, wc: WebContents): void {
    const e = this.entries.get(id)
    if (!e) return
    // Pending output is already in history; flush it to the old port so it isn't sent twice.
    this.flush(e)
    e.port?.close()
    const { port1, port2 } = new MessageChannelMain()
    e.port = port1
    e.wc = wc
    port1.on('message', ({ data }: { data: PortInput }) => {
      if (data.type === 'input') e.proc.write(data.data)
      else if (data.type === 'resize' && data.cols > 0 && data.rows > 0) {
        e.proc.resize(data.cols, data.rows)
        e.size = { cols: data.cols, rows: data.rows }
      }
    })
    port1.start()
    wc.postMessage('session:port', id, [port2])
    this.send(e, { type: 'reset' })
    if (e.history.length) this.send(e, { type: 'data', data: e.history.join('') })
  }

  /** Last known size and renderer, for respawning in place. */
  info(id: string): { size: { cols: number; rows: number }; wc?: WebContents } | null {
    const e = this.entries.get(id)
    return e ? { size: e.size, wc: e.wc } : null
  }

  write(id: string, data: string): boolean {
    const e = this.entries.get(id)
    e?.proc.write(data)
    return !!e
  }

  async killAndWait(id: string, timeoutMs = 5000): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    e.proc.kill('SIGHUP')
    const timer = setTimeout(() => e.proc.kill('SIGKILL'), timeoutMs)
    await e.exited
    clearTimeout(timer)
  }

  kill(id: string): void {
    this.entries.get(id)?.proc.kill('SIGHUP')
  }

  killAll(): void {
    for (const e of this.entries.values()) e.proc.kill('SIGHUP')
  }

  private flush(e: Entry): void {
    clearTimeout(e.timer)
    e.timer = undefined
    if (!e.pending) return
    this.send(e, { type: 'data', data: e.pending })
    e.pending = ''
  }

  private send(e: Entry, msg: PortMessage): void {
    e.port?.postMessage(msg)
  }

  private remember(e: Entry, data: string): void {
    e.history.push(data)
    e.historyBytes += data.length
    while (e.historyBytes > SCROLLBACK_BYTES && e.history.length > 1) {
      e.historyBytes -= e.history.shift()!.length
    }
  }
}
