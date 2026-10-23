import type { Pr } from '@shared/git'
import { FE_REPO, type FePr } from '@shared/runpr'
import { gh } from './poller'

const TTL = 60_000
const prs = new Map<number, { at: number; pr: Promise<FePr | null> }>()
const branches = new Map<string, { at: number; n: Promise<number | null> }>()

export const fromPoller = (p: Pr): FePr => ({ number: p.number, title: p.title, url: p.url, branch: p.branch, headSha: p.headSha, fork: false, state: 'OPEN' })

/** A frontend PR by number, read-only through gh, cached for a minute. */
export function fePr(n: number): Promise<FePr | null> {
  const hit = prs.get(n)
  if (hit && Date.now() - hit.at < TTL) return hit.pr
  const pr = gh(['pr', 'view', String(n), '--repo', FE_REPO, '--json', 'number,title,url,headRefName,headRefOid,isCrossRepository,state'])
    .then((out) => {
      const d = JSON.parse(out) as { number: number; title: string; url: string; headRefName: string; headRefOid: string; isCrossRepository: boolean; state: FePr['state'] }
      return { number: d.number, title: d.title, url: d.url, branch: d.headRefName, headSha: d.headRefOid, fork: d.isCrossRepository, state: d.state }
    })
    .catch(() => null)
  prs.set(n, { at: Date.now(), pr })
  return pr
}

/** The open frontend PR whose head is this branch, cached for five minutes. */
export function fePrForBranch(branch: string): Promise<number | null> {
  const hit = branches.get(branch)
  if (hit && Date.now() - hit.at < 5 * TTL) return hit.n
  const n = gh(['pr', 'list', '--repo', FE_REPO, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'])
    .then((out) => (JSON.parse(out) as { number: number }[])[0]?.number ?? null)
    .catch(() => null)
  branches.set(branch, { at: Date.now(), n })
  return n
}
