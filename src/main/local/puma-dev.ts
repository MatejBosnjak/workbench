import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// puma-dev serves the api: ~/.puma-dev/api.productive.io is a symlink to the checkout it boots.

const DIR = join(homedir(), '.puma-dev')
const NAME = 'api.productive.io'

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** The puma-dev link for the api: api.productive.io, else any link into the base checkout. */
export function pumaLink(base: string): string | null {
  const named = join(DIR, NAME)
  if (isLink(named)) return named
  if (!existsSync(DIR)) return null
  for (const f of readdirSync(DIR)) {
    const p = join(DIR, f)
    if (isLink(p) && readlinkSync(p).replace(/\/$/, '') === base) return p
  }
  return null
}

export const linkTarget = (link: string): string => readlinkSync(link).replace(/\/$/, '')

/** Repoints the link in one rename, so puma-dev never sees it missing. */
export function repoint(link: string, to: string): void {
  const tmp = join(dirname(link), `.${basename(link)}.workbench`)
  rmSync(tmp, { force: true })
  symlinkSync(to, tmp)
  renameSync(tmp, link)
}

/** Where the link answers over HTTP (puma-dev runs with -d localhost here). */
export const pumaUrl = (link: string): string => `http://${basename(link)}.localhost/`

/** Gitignored files an api worktree needs from the base checkout; symlinked so edits there carry over. */
export const API_LOCAL_FILES = ['config/application.yml', 'tmp/cloudfront-signing-key', '.bundle/config']

/** True once the api answers (puma-dev holds the request while it boots; 5xx is a failed boot or puma-dev itself). */
export async function apiAnswers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' })
    return r.status < 500
  } catch {
    return false
  }
}
