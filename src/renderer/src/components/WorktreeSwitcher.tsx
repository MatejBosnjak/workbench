import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Branch, ServiceState, Worktree } from '@shared/local'

const home = (p: string) => p.replace(/^\/Users\/[^/]+\/(Productive\/)?/, '')

function age(ts: number): string {
  if (!ts) return '?'
  const days = Math.floor((Date.now() / 1000 - ts) / 86400)
  if (days < 1) {
    const h = Math.floor((Date.now() / 1000 - ts) / 3600)
    return h < 1 ? 'now' : `${h}h`
  }
  return days < 14 ? `${days}d` : days < 70 ? `${Math.floor(days / 7)}w` : `${Math.floor(days / 30)}mo`
}

function badge(w: Worktree): [string, string] | null {
  if (w.base) return ['base', 'wt-base']
  if (w.dirty) return ['● dirty', 'wt-dirty']
  if (w.merged) return ['✓ merged', 'wt-done']
  if (w.gone) return ['⬆ gone', 'wt-done']
  if (w.dirty === false) return ['⚠ unmerged', 'wt-unmerged']
  return null
}

/** Rows shown at most per section; the filter narrows the rest. */
const MAX_ROWS = 200

type Item = { kind: 'wt'; w: Worktree } | { kind: 'branch'; b: Branch }

/** Worktrees of the service's repo, then branches of its base checkout no worktree has; ⏎ on a branch checks it out there. */
export function WorktreeSwitcher({ service, onClose }: { service: ServiceState; onClose(): void }) {
  const [list, setList] = useState<Worktree[] | null>(null)
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const listEl = useRef<HTMLDivElement>(null)

  const load = () => void window.workbench.local.worktrees(service.name).then(setList)
  useEffect(load, [service.name])
  useEffect(() => void window.workbench.local.branches(service.name).then(setBranches), [service.name])

  const { trees, refs } = useMemo(() => {
    const q = query.toLowerCase()
    const trees = (list ?? []).filter((w) => !q || `${w.branch ?? ''} ${w.path}`.toLowerCase().includes(q))
    const refs = (branches ?? []).filter((b) => !q || `${b.remote ? 'origin/' : ''}${b.name}`.toLowerCase().includes(q))
    return { trees, refs }
  }, [list, branches, query])
  const items: Item[] = useMemo(
    () => [...trees.slice(0, MAX_ROWS).map((w) => ({ kind: 'wt' as const, w })), ...refs.slice(0, MAX_ROWS).map((b) => ({ kind: 'branch' as const, b }))],
    [trees, refs],
  )
  const baseBranch = list?.find((w) => w.base)?.branch
  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listEl.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const current = items[index]
  const act = async (kind: 'run' | 'switch' | 'editor' | 'remove' | 'alongside', item = current) => {
    if (!item) return
    if (item.kind === 'branch') {
      if (kind === 'editor') return void window.workbench.openInEditor(service.def.cwd)
      if (kind !== 'run' && kind !== 'switch') return
      onClose()
      return void (await window.workbench.local.checkoutBranch(service.name, item.b.name, kind === 'run'))
    }
    const w = item.w
    if (kind === 'editor') return void window.workbench.openInEditor(w.path)
    if (kind === 'remove') {
      const r = await window.workbench.local.removeWorktree(w.path)
      if (r === 'removed') load()
      if (r !== 'cancelled') setNote(r === 'removed' ? `Removed ${home(w.path)}` : r)
      return
    }
    onClose()
    if (kind === 'alongside') await window.workbench.local.runAlongside(service.name, w.path)
    else await window.workbench.local.switchWorktree(service.name, w.path, kind === 'run')
  }

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase()
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1))
    else if (e.key === 'Enter') void act('run')
    else if (e.metaKey && k === 'o') void act('switch')
    else if (e.metaKey && k === '.') void act('editor')
    else if (e.metaKey && k === 'backspace') void act('remove')
    else return
    e.preventDefault()
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="palette wt" role="dialog" aria-label={`Switch ${service.name} worktree`} onMouseDown={(e) => e.stopPropagation()}>
        <label className="palette-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input autoFocus aria-label="Filter worktrees" placeholder={`Filter ${service.def.repo} worktrees and branches…`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          <span className="muted mono" style={{ fontSize: 11 }}>
            {list ? `${trees.length} worktrees · ${branches ? `${refs.length} branches` : 'branches…'}` : 'scanning…'}
          </span>
        </label>
        <div className="palette-list" ref={listEl}>
          {items.map((item, i) => {
            const head =
              i === 0 && item.kind === 'wt' ? (
                <div className="wt-sec">Worktrees</div>
              ) : item.kind === 'branch' && items[i - 1]?.kind !== 'branch' ? (
                <div className="wt-sec">
                  Branches · {home(service.def.cwd)} (base checkout{baseBranch ? `, on ${baseBranch}` : ''})
                </div>
              ) : null
            if (item.kind === 'branch') {
              const b = item.b
              return (
                <Fragment key={`b:${b.remote}:${b.name}`}>
                  {head}
                  <button className="palette-item wt-row wt-branch" data-active={i === index} onMouseEnter={() => setIndex(i)} onClick={() => void act('run', item)}>
                    <span className="wt-marker" />
                    <span className="pop-text">
                      <span className="mono">{b.remote ? `origin/${b.name}` : b.name}</span>
                    </span>
                    <span className={`wt-badge ${b.remote ? 'wt-remote' : 'wt-local'}`}>{b.remote ? 'remote' : 'local'}</span>
                    <span className="mono muted wt-age">{age(b.ts)}</span>
                  </button>
                </Fragment>
              )
            }
            const w = item.w
            const b = badge(w)
            const here = w.path === service.cwd
            return (
              <Fragment key={w.path}>
                {head}
                <button className="palette-item wt-row" data-active={i === index} onMouseEnter={() => setIndex(i)} onClick={() => void act('run', item)}>
                  <span className="wt-marker">{here ? '▸' : ''}</span>
                  <span className="pop-text">
                    <span className="mono">{w.branch ?? '(detached)'}</span>
                    <span className="pop-note mono">{home(w.path)}</span>
                  </span>
                  {b && <span className={`wt-badge ${b[1]}`}>{b[0]}</span>}
                  <span className="mono muted wt-age">{age(w.ts)}</span>
                </button>
              </Fragment>
            )
          })}
        </div>
        <div className="palette-foot mono">
          <span>↵ switch &amp; run</span>
          <span>⌘O switch only</span>
          <span>⌘. VS Code</span>
          <span>⌘⌫ remove worktree</span>
          {note && <span className="wt-note">{note}</span>}
          {service.def.port && (
            <button className="ghost" onClick={() => void act('alongside')} disabled={current?.kind !== 'wt'}>
              Run alongside on new port
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
