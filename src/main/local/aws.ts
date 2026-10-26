import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AwsLogin } from '@shared/local'
import { shellEnv, which } from '../shell-env'

const CHECK_MS = 60_000

/** An AWS error in a service's output that means the SSO login is gone. */
export const AWS_EXPIRED = /ExpiredToken|Token (is|has) expired|SSO session .*expired|run 'aws sso login'|The security token included in the request is (expired|invalid)|UnrecognizedClientException/i

/** The first `[sso-session x]` in ~/.aws/config, its start URL, and a profile that uses it. */
export function readSsoSession(text: string): { session: string; startUrl: string; profile: string | null } | null {
  let section = ''
  const sessions = new Map<string, string>()
  const users = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) section = head[1]!.trim()
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    if (section.startsWith('sso-session ') && kv[1] === 'sso_start_url') sessions.set(section.slice(12).trim(), kv[2]!.trim())
    if (kv[1] === 'sso_session' && !users.has(kv[2]!.trim())) users.set(kv[2]!.trim(), section === 'default' ? 'default' : section.replace(/^profile\s+/, ''))
  }
  const [session, startUrl] = [...sessions][0] ?? []
  return session && startUrl ? { session, startUrl, profile: users.get(session) ?? null } : null
}

/**
 * The AWS SSO login behind the local stack: when its token runs out and a click to log in again. The access token in
 * ~/.aws/sso/cache lasts an hour and the SDK refreshes it while the session is alive, so a past expiry alone isn't
 * proof: then `aws sts get-caller-identity` decides (it refreshes if it can). Offline or other errors leave it unknown.
 */
export class Aws {
  private state: AwsLogin | null = null
  private login: ChildProcess | null = null
  private timer: NodeJS.Timeout
  private checking = false

  constructor(private changed: () => void) {
    this.timer = setInterval(() => void this.check(), CHECK_MS)
    // Not synchronously: check() may report before the owner has finished constructing (Supervisor's snapshot reads this.aws).
    setTimeout(() => void this.check(), 0)
  }

  get(): AwsLogin | null {
    return this.state
  }

  /** Re-reads now, e.g. after a service crashed with an expired-token error. */
  async check(): Promise<void> {
    if (this.checking || this.login) return
    this.checking = true
    try {
      const cfg = join(homedir(), '.aws/config')
      const sso = existsSync(cfg) ? readSsoSession(readFileSync(cfg, 'utf8')) : null
      if (!sso) return this.set(null)
      const until = cachedExpiry(sso.startUrl)
      if (until && until > Date.now()) return this.set({ session: sso.session, status: 'ok', until, code: null })
      const r = await run(['sts', 'get-caller-identity', ...(sso.profile ? ['--profile', sso.profile] : [])])
      if (r.ok) return this.set({ session: sso.session, status: 'ok', until: cachedExpiry(sso.startUrl), code: null })
      const expired = AWS_EXPIRED.test(r.err) || /sso|token|login/i.test(r.err)
      this.set({ session: sso.session, status: expired ? 'expired' : 'unknown', until, code: null })
    } finally {
      this.checking = false
    }
  }

  /** `aws sso login --sso-session <s>`: the browser opens; the device code shows on the chip until it's done. A second click cancels. */
  async startLogin(): Promise<void> {
    if (this.login) {
      this.login.kill()
      return
    }
    const s = this.state
    if (!s) return
    const env = await shellEnv()
    const aws = which('aws', env)
    if (!aws) return this.set({ ...s, status: 'unknown', code: null })
    const p = spawn(aws, ['sso', 'login', '--sso-session', s.session], { env })
    this.login = p
    this.set({ ...s, status: 'login', code: null })
    const read = (d: Buffer) => {
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(d.toString())?.[1]
      if (code && this.state) this.set({ ...this.state, code })
    }
    p.stdout.on('data', read)
    p.stderr.on('data', read)
    const killer = setTimeout(() => p.kill(), 5 * 60_000)
    p.on('close', () => {
      clearTimeout(killer)
      this.login = null
      if (this.state) this.state = { ...this.state, status: 'unknown', code: null }
      void this.check()
    })
  }

  dispose(): void {
    clearInterval(this.timer)
    this.login?.kill()
  }

  private set(s: AwsLogin | null): void {
    if (JSON.stringify(s) === JSON.stringify(this.state)) return
    this.state = s
    this.changed()
  }
}

/** The newest token expiry cached for this start URL, or null. */
function cachedExpiry(startUrl: string): number | null {
  const dir = join(homedir(), '.aws/sso/cache')
  if (!existsSync(dir)) return null
  let best: number | null = null
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { startUrl?: string; expiresAt?: string; accessToken?: string }
      if (d.startUrl !== startUrl || !d.accessToken || !d.expiresAt) continue
      const t = Date.parse(d.expiresAt)
      if (t && (!best || t > best)) best = t
    } catch {
      // another tool mid-write
    }
  }
  return best
}

async function run(args: string[]): Promise<{ ok: boolean; err: string }> {
  const env = await shellEnv()
  const aws = which('aws', env)
  if (!aws) return { ok: false, err: 'aws not found' }
  return new Promise((done) => {
    const p = spawn(aws, args, { env, timeout: 20_000 })
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', (e) => done({ ok: false, err: e.message }))
    p.on('close', (code) => done({ ok: code === 0, err }))
  })
}
