import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type { PortInput, PortMessage } from '@shared/types'

const FLUSH_MS = 8
const FLUSH_BYTES = 64 * 1024
/** Replay history per pty, in characters (UTF-16 units, so up to twice that in bytes). Callers pick by kind. */
const HISTORY_CHARS = 1_000_000
/** History is kept in chunks of about this size, so a long-lived pty holds dozens of strings, not millions. */
const CHUNK_CHARS = 64 * 1024

interface Entry {
  proc: pty.IPty
  port?: MessagePortMain
  pending: string
  timer?: NodeJS.Timeout
  // Kept so a reloaded renderer can rebuild the screen.
  history: string[]
  historyChars: number
  historyCap: number
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
  /** How much output to keep for replay; defaults to HISTORY_CHARS. */
  historyChars?: number
}

export class PtyHost {
  private entries = new Map<string, Entry>()

  constructor(
    private onExit: (id: string, code: number) => void,
    /** Typed input, after it's written to the pty. */
    private onInput?: (id: string, data: string) => void,
    private onOutput?: (id: string, data: string) => void,
  ) {}

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Each live pty's process and how much replay history it holds (characters). */
  processes(): { id: string; pid: number; historyChars: number }[] {
    return [...this.entries].map(([id, e]) => ({ id, pid: e.proc.pid, historyChars: e.historyChars }))
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
    const e: Entry = { proc, pending: '', history: [], historyChars: 0, historyCap: o.historyChars ?? HISTORY_CHARS, exited: new Promise((r) => (onExited = r)), size: { cols: o.cols, rows: o.rows } }
    this.entries.set(id, e)

    proc.onData((data) => {
      this.onOutput?.(id, data)
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
      if (data.type === 'input') {
        e.proc.write(data.data)
        this.onInput?.(id, data.data)
      } else if (data.type === 'resize' && data.cols > 0 && data.rows > 0) {
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

  /**
   * Stops a process tree the way Ctrl+C would, escalating: each signal goes to the whole
   * process group (the pty child is its session leader) and waits before the next.
   */
  async stopGroup(id: string, steps: [NodeJS.Signals, number][] = [['SIGINT', 5000], ['SIGTERM', 3000], ['SIGKILL', 1000]]): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    for (const [sig, ms] of steps) {
      try {
        process.kill(-e.proc.pid, sig)
      } catch {
        e.proc.kill(sig)
      }
      const exited = await Promise.race([e.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
      if (exited) return
    }
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
    const last = e.history.length - 1
    if (last >= 0 && e.history[last]!.length < CHUNK_CHARS) e.history[last] += data
    else e.history.push(data)
    e.historyChars += data.length
    // Drop whole chunks from the front while the rest still covers the cap.
    while (e.history.length > 1 && e.historyChars - e.history[0]!.length > e.historyCap) {
      e.historyChars -= e.history.shift()!.length
    }
  }
}
