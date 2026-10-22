import { execFile } from 'node:child_process'
import type { PrInfo } from '@shared/types'
import { shellEnv, which } from './shell-env'

export const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/

const TTL_MS = 60_000
const cache = new Map<string, { at: number; info: Promise<PrInfo | null> }>()

interface Check {
  conclusion?: string | null
  status?: string | null
  state?: string | null
}

/** Rolls the checks up the way GitHub's PR badge does: any failure wins, then anything unfinished. */
export function rollup(checks: Check[]): PrInfo['checks'] {
  if (!checks.length) return null
  const bad = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  const results = checks.map((c) => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (results.some((r) => bad.includes(r))) return 'FAILURE'
  if (results.some((r) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(r))) return 'PENDING'
  return 'SUCCESS'
}

/** Read-only lookup through `gh`; never posts anything. */
export function prInfo(url: string): Promise<PrInfo | null> {
  const m = PR_URL.exec(url)
  if (!m) return Promise.resolve(null)
  const key = m[0]
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info
  const info = fetchPr(key, `${m[1]}/${m[2]}`)
  cache.set(key, { at: Date.now(), info })
  return info
}

async function fetchPr(url: string, repo: string): Promise<PrInfo | null> {
  const env = await shellEnv()
  const gh = which('gh', env)
  if (!gh) return null
  return new Promise((resolve) => {
    execFile(
      gh,
      ['pr', 'view', url, '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup'],
      { env, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          const d = JSON.parse(stdout) as {
            number: number
            title: string
            state: PrInfo['state']
            isDraft: boolean
            reviewDecision: string | null
            statusCheckRollup: Check[] | null
          }
          resolve({
            url,
            repo,
            number: d.number,
            title: d.title,
            state: d.state,
            isDraft: d.isDraft,
            reviewDecision: d.reviewDecision || null,
            checks: rollup(d.statusCheckRollup ?? []),
          })
        } catch {
          resolve(null)
        }
      },
    )
  })
}
