import { useEffect, useMemo, useState } from 'react'
import { diskLow, gb, type CleanupRow, type Verdict } from '@shared/cleanup'
import { useStore } from '../store'

const GROUPS: { verdict: Verdict; label: string; why: string }[] = [
  { verdict: 'done', label: 'Done', why: 'PR merged (or the reviewed PR closed) · nothing uncommitted · nothing that isn’t on GitHub' },
  { verdict: 'maybe', label: 'Probably done', why: 'PR closed unmerged · no PR and task closed · no PR, no commit in 4 weeks · the branch is kept' },
  { verdict: 'keep', label: 'Keep', why: 'open PR or task · a tab or service uses it · uncommitted changes · recent work' },
]
/** Rows shown per group before "show all". */
const PAGE = 40
/** Rescan when the view opens and the last scan is older than this. */
const STALE_MS = 10 * 60_000

const short = (repo: string) => repo.split('/').pop() ?? repo
const shortName = (r: CleanupRow) => (r.name.startsWith(`${short(r.repo)}-`) ? r.name.slice(short(r.repo).length + 1) : r.name)

function ago(ms: number): string {
  const d = Math.max(0, (Date.now() - ms) / 86_400_000)
  if (d < 1) return 'today'
  if (d < 14) return `${Math.floor(d)} d`
  if (d < 60) return `${Math.floor(d / 7)} w`
  return `${Math.floor(d / 30)} mo`
}

export function WorktreeCleanup({ active }: { active: boolean }) {
  const snap = useStore((s) => s.cleanup)
  const [filter, setFilter] = useState('')
  const [repo, setRepo] = useState<string | null>(null)
  const [all, setAll] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [bySize, setBySize] = useState(false)

  useEffect(() => {
    if (active && snap && !snap.scanning && (!snap.scannedAt || Date.now() - snap.scannedAt > STALE_MS)) void window.workbench.cleanup.scan()
  }, [active, snap === null])

  const repos = useMemo(() => {
    const n = new Map<string, number>()
    for (const r of snap?.rows ?? []) n.set(short(r.repo), (n.get(short(r.repo)) ?? 0) + 1)
    return [...n].sort((a, b) => b[1] - a[1])
  }, [snap?.rows])

  if (!snap) return null
  const doneRows = snap.rows.filter((r) => r.verdict === 'done')
  const doneBytes = { n: doneRows.length, bytes: doneRows.reduce((n, r) => n + (r.bytes ?? 0), 0), partial: doneRows.some((r) => r.bytes === null) }
  const q = filter.trim().toLowerCase()
  const rows = snap.rows.filter(
    (r) => (!repo || short(r.repo) === repo) && (!q || `${r.name} ${r.branch ?? ''} ${r.task?.title ?? ''} ${r.pr?.title ?? ''} ${r.pr?.number ?? ''}`.toLowerCase().includes(q)),
  )
  if (bySize) rows.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
  const busy = snap.scanning || !!snap.removing
  const pickedNow = rows.filter((r) => r.verdict === 'maybe' && picked.has(r.path))

  return (
    <section className="wtc" aria-label="Worktrees">
      <div className="wtc-bar">
        <input className="wtc-filter" placeholder="filter: repo, branch, task, PR…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="wtc-repos">
          <button className="chip" aria-pressed={!repo} onClick={() => setRepo(null)}>
            all repos
          </button>
          {repos.map(([name, n]) => (
            <button key={name} className="chip" aria-pressed={repo === name} onClick={() => setRepo(repo === name ? null : name)}>
              {name} {n}
            </button>
          ))}
        </div>
        <div className="seg-switch wtc-sort" role="radiogroup" aria-label="Sort">
          <button role="radio" aria-checked={!bySize} onClick={() => setBySize(false)}>
            oldest
          </button>
          <button role="radio" aria-checked={bySize} onClick={() => setBySize(true)}>
            largest
          </button>
        </div>
        <span className="muted wtc-when">
          {snap.removing
            ? `removing ${snap.removing.done} of ${snap.removing.total}…`
            : snap.scanning
              ? 'checking worktrees, GitHub and Productive…'
              : snap.scannedAt
                ? `checked ${ago(snap.scannedAt) === 'today' ? new Date(snap.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ago(snap.scannedAt)}`
                : ''}
        </span>
        <button className="ghost" disabled={busy} onClick={() => void window.workbench.cleanup.scan()}>
          ↻ Refresh
        </button>
      </div>
      {snap.error && <div className="wtc-error">Couldn’t check: {snap.error}</div>}
      {diskLow(snap.disk) && snap.disk && (
        <div className="wtc-disk">
          Disk {Math.round((1 - snap.disk.free / snap.disk.total) * 100)}% full · {gb(snap.disk.free)} free.
          {doneBytes.n > 0 && ` The ${doneBytes.n} done worktrees take ${doneBytes.partial ? 'at least ' : ''}${gb(doneBytes.bytes)}.`}
        </div>
      )}
      <div className="wtc-list">
        {!snap.scannedAt && snap.scanning && <div className="wtc-empty muted">Reading {`~/…/worktrees`}: each worktree’s git state, its PR on GitHub, its task in Productive…</div>}
        {GROUPS.map((g) => {
          const list = rows.filter((r) => r.verdict === g.verdict)
          if (!list.length) return null
          const shown = all[g.verdict] ? list : list.slice(0, PAGE)
          return (
            <div key={g.verdict} className={`wtc-group wtc-${g.verdict}`}>
              <div className="wtc-ghead">
                <span className="wtc-gname">
                  {g.label} · {list.length}
                </span>
                <span className="muted wtc-why">{g.why}</span>
                <span className="muted wtc-size">{sizeOf(list)}</span>
                {g.verdict === 'done' && (
                  <button className="primary" disabled={busy} onClick={() => void window.workbench.cleanup.remove(list.map((r) => r.path))}>
                    Remove {list.length}
                    {list.some((r) => r.deleteBranch) ? ' · delete their branches' : ''}
                  </button>
                )}
                {g.verdict === 'maybe' && (
                  <button
                    className="ghost"
                    disabled={busy || !pickedNow.length}
                    onClick={() => void window.workbench.cleanup.remove(pickedNow.map((r) => r.path)).then(() => setPicked(new Set()))}
                  >
                    Remove selected{pickedNow.length ? ` (${pickedNow.length})` : ''}
                  </button>
                )}
              </div>
              {shown.map((r) => (
                <Row
                  key={r.path}
                  r={r}
                  busy={busy}
                  failed={snap.failed[r.path]}
                  picked={g.verdict === 'maybe' ? picked.has(r.path) : undefined}
                  onPick={() =>
                    setPicked((s) => {
                      const n = new Set(s)
                      if (!n.delete(r.path)) n.add(r.path)
                      return n
                    })
                  }
                  open={open === r.path}
                  onOpen={() => setOpen(open === r.path ? null : r.path)}
                />
              ))}
              {list.length > shown.length && (
                <button className="wtc-more" onClick={() => setAll({ ...all, [g.verdict]: true })}>
                  … {list.length - shown.length} more · show all
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function sizeOf(list: CleanupRow[]): string {
  const known = list.filter((r) => r.bytes !== null)
  if (!known.length) return ''
  const sum = gb(known.reduce((n, r) => n + r.bytes!, 0))
  return known.length < list.length ? `≥ ${sum} · measuring ${known.length}/${list.length}` : sum
}

function Row({ r, busy, failed, picked, onPick, open, onOpen }: { r: CleanupRow; busy: boolean; failed?: string; picked?: boolean; onPick: () => void; open: boolean; onOpen: () => void }) {
  const pr = r.pr
  const changes = r.changes.length
  return (
    <>
      <div className={`wtc-row${open ? ' open' : ''}`} title={r.reason}>
        <span className="wtc-pick">{picked !== undefined && <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select ${r.name}`} />}</span>
        <span className="wtc-repo muted">{short(r.repo)}</span>
        <span className="wtc-name">
          <span>{shortName(r)}</span>
          <small className="faint">
            {r.branch ?? (r.reviewOf !== null ? 'detached · review checkout' : 'detached')}
            {r.unpushed && !r.inPr && r.verdict !== 'done' ? ` · ${r.unpushed} unpushed` : ''}
          </small>
        </span>
        <span className="wtc-pr">
          {pr ? (
            <>
              <span className={pr.state === 'MERGED' ? 'ok' : pr.state === 'OPEN' ? 'info' : 'bad'}>{pr.state === 'MERGED' ? '✓ merged' : pr.state === 'OPEN' ? '● open' : '✕ closed'}</span>{' '}
              <a href={pr.url} className="link" title={pr.title} onClick={(e) => (e.preventDefault(), void window.workbench.openExternal(pr.url))}>
                #{pr.number}
              </a>
              {pr.endedAt ? <span className="faint"> · {ago(pr.endedAt)}</span> : null}
            </>
          ) : (
            <span className="faint">no PR</span>
          )}
          {changes ? <span className="warn"> · {r.moreChanges ? '20+' : changes} change{changes === 1 ? '' : 's'}</span> : null}
        </span>
        <span className="wtc-task">{r.task ? <span className={`task-pill${r.task.closed ? ' closed' : ''}`} title={`${r.task.title}${r.task.closed ? ' · closed' : ''}`}>{r.task.title}{r.task.closed ? ' ✓' : ''}</span> : <span className="faint">—</span>}</span>
        <span className="muted wtc-age" title="last commit">{ago(r.ts * 1000)}</span>
        <span className="muted wtc-bytes" title="disk use">{r.bytes === null ? '' : gb(r.bytes)}</span>
        <span className="wtc-acts">
          {r.tabs.length > 0 && <span className="wtc-use" title={r.tabs.join(', ')}>✻ tab</span>}
          {r.services.length > 0 && <span className="wtc-use ok" title={`${r.services.join(', ')} runs from it`}>▶ {r.services[0]}</span>}
          <button className="icon-btn" title="Open in editor" onClick={() => void window.workbench.openInEditor(r.path)}>
            ⌘.
          </button>
          {r.verdict === 'keep' ? (
            changes > 0 && !r.tabs.length && !r.services.length ? (
              <button className="icon-btn" title="Show changes" aria-expanded={open} onClick={onOpen}>
                {open ? '▴' : '▾'}
              </button>
            ) : null
          ) : (
            <button className="icon-btn wtc-x" title={r.deleteBranch ? 'Remove worktree and branch' : 'Remove worktree (branch kept)'} disabled={busy} onClick={() => void window.workbench.cleanup.remove([r.path])}>
              ×
            </button>
          )}
        </span>
      </div>
      {failed && <div className="wtc-failed">{failed}</div>}
      {open && (
        <div className="wtc-changes">
          <pre>
            {r.changes.join('\n')}
            {r.moreChanges ? '\n…' : ''}
          </pre>
          <div className="wtc-acts">
            <button className="ghost" onClick={() => void window.workbench.openInEditor(r.path)}>
              Open in editor
            </button>
            <button className="ghost wtc-force" disabled={busy} onClick={() => void window.workbench.cleanup.force(r.path)}>
              Remove anyway… (discards {r.moreChanges ? '20+' : changes} change{changes === 1 ? '' : 's'})
            </button>
          </div>
        </div>
      )}
    </>
  )
}
