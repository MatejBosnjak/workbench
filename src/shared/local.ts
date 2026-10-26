export interface ServiceDef {
  name: string
  cwd: string
  command: string
  /** Checked with a TCP connect for health; omitted when the service has no port. */
  port?: number
  /** What "Open in browser" opens. */
  url?: string
  /** Extra shell panes next to the service's own output. */
  panes: number
  profiles: string[]
  /** Repo name in ~/.wtrc.json whose worktrees this service can switch between. */
  repo?: string
  env?: Record<string, string>
}

export type ServiceStatus = 'running' | 'stopping' | 'stopped' | 'crashed'

export interface ServiceState {
  name: string
  def: ServiceDef
  status: ServiceStatus
  exitCode: number | null
  startedAt: number | null
  /** null when the service has no port or isn't running. */
  healthy: boolean | null
  /** Where it runs now; differs from def.cwd after a worktree switch. */
  cwd: string
  branch: string | null
  /** The repo's default branch (origin/HEAD). */
  base: string | null
  /** Commits behind origin/<default branch>, from local refs only. */
  behind: number | null
  /** A "Run alongside" copy; removed once stopped. */
  transient: boolean
  /** Why it crashed, when it's something Workbench can tell, e.g. "AWS login expired". */
  note?: string | null
  /** Its terminal is open (a shell in its folder, or the command itself), whether or not the service runs. */
  terminal?: boolean
}

export interface Profile {
  id: string
  label: string
}

export interface LocalSnapshot {
  services: ServiceState[]
  profiles: Profile[]
  profile: string
  infra: InfraService[]
  /** The AWS SSO login the stack uses; null without an sso-session in ~/.aws/config. */
  aws: AwsLogin | null
}

export interface AwsLogin {
  /** The sso-session name in ~/.aws/config. */
  session: string
  /** `unknown`: couldn't tell (offline, aws missing); `login`: `aws sso login` is waiting for the browser. */
  status: 'ok' | 'expired' | 'unknown' | 'login'
  /** When the cached access token runs out (ms); the SDK refreshes it while the session lives. */
  until: number | null
  /** The device code `aws sso login` printed, to match in the browser. */
  code: string | null
}

export interface InfraService {
  name: string
  /** As brew reports it: started, stopped, none, error, … */
  status: string
}

export interface Worktree {
  path: string
  branch: string | null
  /** Last commit time of the branch, unix seconds. */
  ts: number
  /** The main checkout rather than a linked worktree. */
  base: boolean
  merged: boolean
  gone: boolean
  /** null until the (slower) dirty scan has run. */
  dirty: boolean | null
}

/** A branch of a service's base checkout; `remote` ones exist only on origin (`name` without the `origin/`). */
export interface Branch {
  name: string
  remote: boolean
  /** Last commit time, unix seconds. */
  ts: number
}

/**
 * Pane layout for a service: splits whose leaves are pty ids. `row` lays children side by side.
 * `sizes` maps child ids to percentages.
 */
export type PaneNode =
  | { type: 'leaf'; id: string }
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: PaneNode[]; sizes?: Record<string, number> }
