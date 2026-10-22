import type { AgentSettings, ApplyResult } from './agent'
import type { DraftTarget, GitSnapshot } from './git'
import type { LocalSnapshot, Worktree } from './local'
import type { TasksSnapshot } from './tasks'

export type SessionState = 'running' | 'waiting' | 'failed' | 'idle'

export interface Session {
  id: string
  cwd: string
  title: string
  state: SessionState
  /** A pty is attached and the claude process is alive. */
  alive: boolean
  external: boolean
  /** An external session queued to be resumed here when its terminal copy exits. */
  takeOver?: boolean
  startedAt: number
  lastEventAt: number
  /** Flags the session was started with; null means claude's own default. */
  model: string | null
  effort: string | null
  permissionMode: string | null
}

/** Live data from the statusline, per session. */
export interface SessionStatus {
  model?: string
  modelId?: string
  effort?: string
  contextPct?: number | null
  contextSize?: number
  name?: string
  /** As reported by the last hook event. */
  permissionMode?: string
}

export interface Limit {
  pct: number
  /** Unix seconds. */
  resetsAt?: number
}

export interface Usage {
  fiveHour?: Limit
  sevenDay?: Limit
  at: number
}

export interface StatusSnapshot {
  sessions: Record<string, SessionStatus>
  usage: Usage | null
}

export interface HooksStatus {
  hooks: boolean
  statusline: boolean
}

/** Main → renderer pushes over a session's MessagePort. */
export type PortMessage = { type: 'data'; data: string } | { type: 'reset' }

/** Renderer → main over a session's MessagePort. */
export type PortInput = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }

export interface CaffeinateState {
  mode: 'off' | 'on' | 'lid'
  scope: 'session' | 'all'
  /** The session a 'session'-scoped mode follows. */
  sessionId: string | null
  /** Lid-closed mode needs AC power and an external display. */
  lidAvailable: boolean
  /** Why the mode last changed by itself, if it did. */
  note: string | null
}

export interface RecentSession {
  id: string
  title: string
  cwd: string
  lastEventAt: number
}

export interface PrInfo {
  url: string
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  reviewDecision: string | null
  /** Rolled-up CI: SUCCESS, FAILURE, PENDING, or null when there are no checks. */
  checks: 'SUCCESS' | 'FAILURE' | 'PENDING' | null
  repo: string
}

/** Posted to the page by the preload, carrying a session's MessagePort. */
export const SESSION_PORT_MESSAGE = 'workbench:session-port'

export type MenuCommand =
  | { type: 'new-session' }
  | { type: 'new-session-in' }
  | { type: 'close-tab' }
  | { type: 'select-tab'; index: number }
  | { type: 'cycle-tab'; delta: 1 | -1 }
  | { type: 'palette' }

/** Where a notification click (or an in-app PR link) takes you. */
export type NavigateTarget = { kind: 'session'; id: string } | { kind: 'git' | 'reviews'; prId: string | null }

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
  /** Types into the session's pty. */
  writeSession(id: string, data: string): Promise<boolean>
  configureSession(id: string, change: Partial<AgentSettings>): Promise<ApplyResult>
  getDefaults(): Promise<AgentSettings>
  setDefaults(d: AgentSettings): Promise<void>
  recentSessions(): Promise<RecentSession[]>
  reopenSession(id: string): Promise<void>
  /** Resumes an external session inside Workbench once its terminal copy has exited. */
  takeOver(id: string): Promise<'now' | 'waiting'>
  cancelTakeOver(id: string): Promise<void>
  getCaffeinate(): Promise<CaffeinateState>
  setCaffeinate(mode: CaffeinateState['mode'], scope: CaffeinateState['scope'], sessionId: string | null): Promise<CaffeinateState>
  onCaffeinate(cb: (s: CaffeinateState) => void): () => void
  prInfo(url: string): Promise<PrInfo | null>
  openExternal(url: string): Promise<void>
  tasks: {
    snapshot(): Promise<TasksSnapshot>
    onChanged(cb: (s: TasksSnapshot) => void): () => void
    refresh(): Promise<void>
    /** Starts a session for the task (in its worktree when there is one) and links it. */
    start(taskId: string): Promise<Session | null>
    link(sessionId: string, taskId: string): Promise<void>
    unlink(sessionId: string, taskId: string): Promise<void>
    summarize(taskId: string): Promise<string>
  }
  git: {
    snapshot(): Promise<GitSnapshot>
    onChanged(cb: (s: GitSnapshot) => void): () => void
    refresh(): Promise<void>
    markSeen(key: string, messageId: string): Promise<void>
    /** The draft for a target, created empty if there is none. */
    openDraft(target: DraftTarget): Promise<number>
    /** Has Claude write the target's draft; the result arrives through onChanged. */
    generate(target: DraftTarget, instruction: string): Promise<void>
    saveDraft(id: number, body: string): Promise<void>
    discardDraft(id: number): Promise<void>
    /** Shows a confirm with the exact text and target, then posts. False when cancelled. */
    send(id: number, body: string): Promise<boolean>
  }
  onNavigate(cb: (t: NavigateTarget) => void): () => void
  /** Tells main which session is on screen, so its notifications can be skipped. */
  reportView(sessionId: string | null): void
  local: {
    snapshot(): Promise<LocalSnapshot>
    onChanged(cb: (s: LocalSnapshot) => void): () => void
    onPaneExit(cb: (id: string) => void): () => void
    setProfile(id: string): Promise<void>
    start(name: string): Promise<void>
    stop(name: string): Promise<void>
    restart(name: string): Promise<void>
    stopAll(): Promise<void>
    startMissing(profile: string): Promise<void>
    openPane(id: string, size: { cols: number; rows: number }): Promise<void>
    closePane(id: string): Promise<void>
    worktrees(name: string): Promise<Worktree[]>
    switchWorktree(name: string, path: string, run: boolean): Promise<void>
    runAlongside(name: string, path: string): Promise<string | null>
    removeWorktree(path: string): Promise<string>
    startInfra(name: string): Promise<void>
    refreshInfra(): Promise<void>
  }
  openInEditor(path: string): Promise<void>
  /** UI state kept in SQLite; keys start with "ui:". */
  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>
  getStatus(): Promise<StatusSnapshot>
  onStatus(cb: (s: StatusSnapshot) => void): () => void
  hooksStatus(): Promise<HooksStatus>
  onHooksChanged(cb: (s: HooksStatus) => void): () => void
  /** Both show a confirm dialog in main first. */
  installHooks(): Promise<HooksStatus>
  uninstallHooks(): Promise<HooksStatus>
}
