import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AwsLogin } from '@shared/local'
import { shellEnv, which } from '../shell-env'

const CHECK_MS = 60_000
/** The SDK refreshes a token this close to its end. */
const REFRESH_WINDOW_MS = 5 * 60_000

/** An AWS error in a service's output that means the SSO login is gone. */
export const AWS_EXPIRED = /ExpiredToken|InvalidSSOToken|Token is invalid and failed to refresh|Token (is|has) expired|SSO session .*expired|run 'aws sso login'|The security token included in the request is (expired|invalid)|UnrecognizedClientException/i

/** The first `[sso-session x]` in ~/.aws/config, its start URL and region, and a profile that uses it. */
export function readSsoSession(text: string): { session: string; startUrl: string; region: string | null; profile: string | null } | null {
  let section = ''
  const sessions = new Map<string, string>()
  const regions = new Map<string, string>()
  const users = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) section = head[1]!.trim()
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    if (section.startsWith('sso-session ') && kv[1] === 'sso_start_url') sessions.set(section.slice(12).trim(), kv[2]!.trim())
    if (section.startsWith('sso-session ') && kv[1] === 'sso_region') regions.set(section.slice(12).trim(), kv[2]!.trim())
    if (kv[1] === 'sso_session' && !users.has(kv[2]!.trim())) users.set(kv[2]!.trim(), section === 'default' ? 'default' : section.replace(/^profile\s+/, ''))
  }
  const [session, startUrl] = [...sessions][0] ?? []
  return session && startUrl ? { session, startUrl, region: regions.get(session) ?? null, profile: users.get(session) ?? null } : null
}

/**
 * The AWS SSO login behind the local stack: when its token runs out and a click to log in again. Checked the way the
 * api's Ruby SDK sees it: the session's token in ~/.aws/sso/cache, refreshed with its refresh token (SSO-OIDC) when
 * it is near its end, as the SDK would. Not `aws sts get-caller-identity`: the CLI answers from its own role
 * credentials in ~/.aws/cli/cache for hours after the SSO session died. Offline leaves it unknown.
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
      const token = readToken(sso.session)
      if (!token) return this.set({ session: sso.session, status: 'expired', until: null, code: null })
      if (token.until > Date.now() + REFRESH_WINDOW_MS) return this.set({ session: sso.session, status: 'ok', until: token.until, code: null })
      const r = await refresh(token, sso.region)
      const until = r === 'refreshed' ? (readToken(sso.session)?.until ?? null) : token.until
      const status = r === 'refreshed' || token.until > Date.now() ? 'ok' : r === 'denied' ? 'expired' : 'unknown'
      this.set({ session: sso.session, status, until, code: null })
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

interface CachedToken {
  file: string
  json: Record<string, unknown>
  until: number
}

/** The session's token as the SDKs cache it: ~/.aws/sso/cache/<sha1 of the sso-session name>.json. */
function readToken(session: string): CachedToken | null {
  const file = join(homedir(), '.aws/sso/cache', `${createHash('sha1').update(session, 'utf8').digest('hex')}.json`)
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const until = Date.parse(String(json.expiresAt))
    return json.accessToken && until ? { file, json, until } : null
  } catch {
    return null // missing, or another tool mid-write
  }
}

/** Refreshes the token the way the SDK does and writes it back. `denied`: no refresh token, or SSO refused it (session over). */
async function refresh(t: CachedToken, configRegion: string | null): Promise<'refreshed' | 'denied' | 'offline'> {
  const { clientId, clientSecret, refreshToken, registrationExpiresAt } = t.json
  const region = (t.json.region as string | undefined) ?? configRegion
  if (!clientId || !clientSecret || !refreshToken || !region) return 'denied'
  if (registrationExpiresAt && Date.parse(String(registrationExpiresAt)) < Date.now()) return 'denied'
  let res: Response
  try {
    res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, grantType: 'refresh_token', refreshToken }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return 'offline'
  }
  if (res.status >= 500) return 'offline'
  if (!res.ok) return 'denied'
  const r = (await res.json()) as { accessToken: string; expiresIn: number; refreshToken?: string }
  const json: Record<string, unknown> = { ...t.json, accessToken: r.accessToken, expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString().replace(/\.\d+Z$/, 'Z') }
  if (r.refreshToken) json.refreshToken = r.refreshToken
  else delete json.refreshToken
  const tmp = `${t.file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(json), { mode: 0o600 })
  renameSync(tmp, t.file)
  return 'refreshed'
}
