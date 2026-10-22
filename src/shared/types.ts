export type SessionState = 'running' | 'waiting' | 'failed' | 'idle'

export interface Session {
  id: string
  cwd: string
  title: string
  state: SessionState
  /** A pty is attached and the claude process is alive. */
  alive: boolean
  external: boolean
  startedAt: number
  lastEventAt: number
}

/** Main → renderer pushes over a session's MessagePort. */
export type PortMessage = { type: 'data'; data: string } | { type: 'reset' }

/** Renderer → main over a session's MessagePort. */
export type PortInput = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }

/** Posted to the page by the preload, carrying a session's MessagePort. */
export const SESSION_PORT_MESSAGE = 'workbench:session-port'

export type MenuCommand =
  | { type: 'new-session' }
  | { type: 'new-session-in' }
  | { type: 'close-tab' }
  | { type: 'select-tab'; index: number }
  | { type: 'cycle-tab'; delta: 1 | -1 }

export interface WorkbenchApi {
  listSessions(): Promise<Session[]>
  createSession(opts?: { cwd?: string; pick?: boolean }): Promise<Session | null>
  /** Spawns the pty if needed (resuming a stored session) and delivers its port. */
  openSession(id: string, size: { cols: number; rows: number }): Promise<void>
  closeSession(id: string): Promise<void>
  setTitle(id: string, title: string): Promise<void>
  reorderSessions(ids: string[]): Promise<void>
  onSessionsChanged(cb: (sessions: Session[]) => void): () => void
  onMenuCommand(cb: (cmd: MenuCommand) => void): () => void
}
