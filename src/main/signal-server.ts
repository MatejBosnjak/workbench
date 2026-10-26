import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname } from 'node:path'

export interface HookPayload {
  hook_event_name: string
  session_id: string
  cwd: string
  transcript_path?: string
  permission_mode?: string
  effort?: { level?: string }
  model?: string
  source?: string
  message?: string
  prompt?: string
  [k: string]: unknown
}

export interface StatuslinePayload {
  session_id: string
  cwd: string
  transcript_path?: string
  session_name?: string
  model?: { id?: string; display_name?: string }
  effort?: { level?: string }
  context_window?: { used_percentage?: number | null; context_window_size?: number }
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | undefined>
  [k: string]: unknown
}

/** wbId is the tab id from WORKBENCH_SESSION_ID; empty for sessions started outside Workbench. */
export type Signal =
  | { kind: 'hook'; wbId: string | null; payload: HookPayload }
  | { kind: 'statusline'; wbId: string | null; payload: StatuslinePayload }

const MAX_BYTES = 4 * 1024 * 1024

/** One connection carries one message: a header line `<kind> <wbId>` and then the JSON body. */
export function parseMessage(raw: string): Signal | null {
  const nl = raw.indexOf('\n')
  if (nl < 0) return null
  const [kind, wbId] = raw.slice(0, nl).trim().split(/\s+/)
  if (kind !== 'hook' && kind !== 'statusline') return null
  let payload: unknown
  try {
    payload = JSON.parse(raw.slice(nl + 1))
  } catch {
    return null
  }
  if (!payload || typeof (payload as { session_id?: unknown }).session_id !== 'string') return null
  return { kind, wbId: wbId || null, payload } as Signal
}

/** A `wb` command from inside a session: one line, `cmd <wbId> <name> <args…>`, answered with text. */
export function parseCommand(line: string): { wbId: string; name: string; args: string[] } | null {
  const [kind, wbId, name, ...args] = line.trim().split(/\s+/)
  return kind === 'cmd' && wbId && name ? { wbId, name, args } : null
}

export type CommandHandler = (wbId: string, name: string, args: string[]) => Promise<string>

export function startSignalServer(socket: string, onSignal: (s: Signal) => void, onCommand?: CommandHandler): Server {
  mkdirSync(dirname(socket), { recursive: true })
  if (existsSync(socket)) unlinkSync(socket) // stale from a crash
  // Half-open: a client that closes its side after sending (nc) still gets the reply.
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    const chunks: Buffer[] = []
    let size = 0
    let answered = false
    conn.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_BYTES) return conn.destroy()
      chunks.push(d)
      // A command is answered as soon as its line is in; the client (nc) waits for the reply and the close.
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!answered && onCommand && raw.startsWith('cmd ') && raw.includes('\n')) {
        answered = true
        const c = parseCommand(raw.slice(0, raw.indexOf('\n')))
        const reply = c ? onCommand(c.wbId, c.name, c.args) : Promise.resolve('error: bad command line')
        void reply
          .catch((e: Error) => `error: ${e.message}`)
          .then((text) => conn.end(text.endsWith('\n') ? text : text + '\n'))
      }
    })
    conn.on('end', () => {
      if (answered) return
      conn.end()
      const sig = parseMessage(Buffer.concat(chunks).toString('utf8'))
      if (sig) onSignal(sig)
    })
    conn.on('error', () => {})
  })
  server.listen(socket, () => chmodSync(socket, 0o600))
  return server
}

export function stopSignalServer(server: Server, socket: string): void {
  server.close()
  try {
    unlinkSync(socket)
  } catch {
    // already gone
  }
}
