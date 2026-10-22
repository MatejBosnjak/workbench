import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Worktree } from '@shared/local'

function git(cwd: string, args: string[], timeout = 15_000): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => done(err ? null : stdout))
  })
}

export async function currentBranch(cwd: string): Promise<string | null> {
  return (await git(cwd, ['branch', '--show-current']))?.trim() || null
}

export async function defaultBranch(cwd: string): Promise<string> {
  const ref = (await git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']))?.trim()
  if (ref) return ref.replace('refs/remotes/origin/', '')
  for (const cand of ['develop', 'main', 'master']) {
    if ((await git(cwd, ['rev-parse', '--verify', '--quiet', `origin/${cand}`])) !== null) return cand
  }
  return 'develop'
}

/** Commits on origin/<default> that HEAD lacks. Local refs only; never fetches. */
export async function behindDefault(cwd: string): Promise<{ base: string; behind: number | null }> {
  const base = await defaultBranch(cwd)
  const n = (await git(cwd, ['rev-list', '--count', `HEAD..origin/${base}`]))?.trim()
  return { base, behind: n ? parseInt(n, 10) : null }
}

// --- worktrees, following worktree-mngr's rules (~/Productive/worktree-mngr) ---

interface Wtrc {
  reposDir?: string | string[]
  worktreesDir?: string | string[]
  commands?: Record<string, string>
}

export function readWtrc(file = join(homedir(), '.wtrc.json')): { reposDirs: string[]; worktreesDirs: string[]; commands: Record<string, string> } {
  if (!existsSync(file)) return { reposDirs: [], worktreesDirs: [], commands: {} }
  const c = JSON.parse(readFileSync(file, 'utf8')) as Wtrc
  const base = resolve(file, '..')
  const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((d) => (isAbsolute(d) ? d : join(base, d)))
  return { reposDirs: list(c.reposDir), worktreesDirs: list(c.worktreesDir), commands: c.commands ?? {} }
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(out: string): { path: string; branch: string | null; bare: boolean }[] {
  return out
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      const path = lines.find((l) => l.startsWith('worktree '))?.slice(9)
      const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '') ?? null
      return path ? { path, branch, bare: lines.includes('bare') } : null
    })
    .filter((w): w is { path: string; branch: string | null; bare: boolean } => !!w && !w.bare && !w.path.includes('/T/'))
}

/**
 * All worktrees of a repo across every checkout of it (the repos named `repo` under each
 * reposDir, plus `extraRoots` such as a service's own clone), newest commit first.
 */
export async function listWorktrees(repo: string, extraRoots: string[] = []): Promise<Worktree[]> {
  const { reposDirs } = readWtrc()
  const roots = [...new Set([...reposDirs.map((d) => join(d, repo)), ...extraRoots])].filter((r) => existsSync(join(r, '.git')))
  const seen = new Set<string>()
  const out: Worktree[] = []
  for (const root of roots) {
    const list = await git(root, ['worktree', 'list', '--porcelain'])
    if (!list) continue
    const base = await defaultBranch(root)
    const refs = await git(root, ['for-each-ref', '--format=%(refname:short)|%(committerdate:unix)|%(upstream:track)', 'refs/heads'])
    const merged = new Set(
      ((await git(root, ['branch', '--merged', `origin/${base}`, '--format=%(refname:short)'])) ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
    )
    const info = new Map<string, { ts: number; gone: boolean }>()
    for (const line of (refs ?? '').split('\n')) {
      const [name, ts, track] = line.split('|')
      if (name) info.set(name, { ts: parseInt(ts ?? '0', 10) || 0, gone: (track ?? '').includes('gone') })
    }
    parseWorktreeList(list).forEach((w, i) => {
      if (seen.has(w.path)) return
      seen.add(w.path)
      const ref = w.branch ? info.get(w.branch) : undefined
      out.push({
        path: w.path,
        branch: w.branch,
        ts: ref?.ts ?? 0,
        base: i === 0,
        // The base checkout sits on the default branch; calling it merged would only invite removing it.
        merged: i !== 0 && !!w.branch && merged.has(w.branch),
        gone: ref?.gone ?? false,
        dirty: null,
      })
    })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

/** Tracked changes only (`-uno`): fast, and `git worktree remove` still refuses on untracked files. */
export async function isDirty(path: string): Promise<boolean> {
  return !!(await git(path, ['status', '--porcelain', '-uno']))?.trim()
}

/** Plain `git worktree remove` (no --force): git refuses when the worktree has changes. */
export async function removeWorktree(path: string): Promise<string | null> {
  // Run from the main checkout: <main>/.git is the common dir of every linked worktree.
  const common = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim()
  if (!common) return 'Not a git worktree'
  return new Promise((done) => {
    execFile('git', ['worktree', 'remove', path], { cwd: dirname(common) }, (err, _out, stderr) => done(err ? stderr.trim() || err.message : null))
  })
}

/** Repos (folders with a .git) under the .wtrc reposDirs, by name, first match wins. */
export function repoRoots(): Map<string, string> {
  const out = new Map<string, string>()
  for (const dir of readWtrc().reposDirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) if (!out.has(name) && existsSync(join(dir, name, '.git'))) out.set(name, join(dir, name))
  }
  return out
}

export interface WorktreePlan {
  root: string
  path: string
  branch: string
  base: string
  commands: string[]
}

/**
 * Where a new worktree for a task goes: `<worktrees>/<repo>-<taskId>-<slug>` on `feature/<taskId>-<slug>`,
 * branched from origin/<default>. The worktrees folder is the one next to the repo's reposDir when .wtrc lists it.
 */
export async function planWorktree(repo: string, taskId: string, slug: string): Promise<WorktreePlan | null> {
  const root = repoRoots().get(repo)
  if (!root) return null
  const { worktreesDirs } = readWtrc()
  const sibling = join(dirname(dirname(root)), 'worktrees')
  const dir = worktreesDirs.find((d) => d === sibling) ?? worktreesDirs[0] ?? sibling
  const base = await defaultBranch(root)
  const name = `${taskId}-${slug}`.replace(/-+$/, '')
  const path = join(dir, `${repo}-${name}`)
  const branch = `feature/${name}`
  return {
    root,
    path,
    branch,
    base,
    commands: [`git -C ${root} fetch origin ${base}`, `git -C ${root} worktree add -b ${branch} ${path} origin/${base}`],
  }
}

export async function createWorktree(p: WorktreePlan): Promise<string | null> {
  const run = (args: string[]) =>
    new Promise<string | null>((done) => execFile('git', args, { cwd: p.root, timeout: 120_000 }, (err, _o, stderr) => done(err ? stderr.trim() || err.message : null)))
  return (await run(['fetch', 'origin', p.base])) ?? (await run(['worktree', 'add', '-b', p.branch, p.path, `origin/${p.base}`]))
}
