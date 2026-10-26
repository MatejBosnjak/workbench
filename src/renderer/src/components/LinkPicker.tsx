import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { parsePrUrl, prRepo, type Ci } from '@shared/git'
import { statusVivid } from '@shared/tasks'
import { useOverlay, useStore } from '../store'
import { sessionPrs } from './TaskSide'

/** One row of a picker. `off` rows (already linked) show but can't be picked. */
interface PickItem {
  key: string
  group?: string
  text: string
  row: ReactNode
  off?: boolean
}

/** A filter box over a list: ↑↓ move, ↵ picks, esc closes. `extra` adds a row for what was typed (a pasted URL). */
function PickList({ items, placeholder, head, foot, extra, onPick, onClose }: { items: PickItem[]; placeholder: string; head?: string; foot: string; extra?(q: string): PickItem | null; onPick(key: string): void; onClose(): void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const own = extra?.(q.trim())
  const shown = own ? [own] : items.filter((it) => it.text.toLowerCase().includes(q.trim().toLowerCase()))
  const live = shown.filter((it) => !it.off)
  const hl = live[Math.min(i, live.length - 1)]
  const pick = (it: PickItem | undefined) => it && !it.off && onPick(it.key)

  return (
    <>
      {head && <span className="prl-head">{head}</span>}
      <input
        className="lk-input"
        autoFocus
        placeholder={placeholder}
        value={q}
        onChange={(e) => (setQ(e.target.value), setI(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setI((n) => Math.max(0, Math.min(live.length - 1, n + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (e.key === 'Enter') pick(hl)
          else if (e.key === 'Escape') onClose()
        }}
      />
      <div className="lk-list">
        {shown.length === 0 && <span className="prl-head">nothing matches</span>}
        {shown.map((it, n) => (
          <div key={it.key} style={{ display: 'contents' }}>
            {it.group && it.group !== shown[n - 1]?.group && <span className="prl-head">{it.group}</span>}
            <button role="menuitem" className={`prl-item lk-item${it === hl ? ' hl' : ''}${it.off ? ' off' : ''}`} disabled={it.off} onClick={() => pick(it)}>
              {it.row}
            </button>
          </div>
        ))}
      </div>
      <span className="prl-sep" />
      <span className="prl-head">{foot}</span>
    </>
  )
}

const CI_COLOR: Record<Ci, string> = { pass: 'var(--ok)', fail: 'var(--bad)', pending: 'var(--info)', none: 'var(--faint)' }

/**
 * A button that opens a PR picker for the session: my PRs and review requests, or any PR URL pasted in. PRs already
 * on the session are dimmed. The menu hangs under the button, drawn over the GitHub pane (which shows a still).
 */
export function LinkPrButton({ sessionId, className, title, children }: { sessionId: string; className: string; title?: string; children: ReactNode }) {
  const { git, tasks, runpr } = useStore(useShallow((s) => ({ git: s.git, tasks: s.tasks, runpr: s.runpr })))
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const close = () => setAt(null)
  useOverlay(at !== null)
  useEffect(() => {
    if (!at) return
    const click = (e: MouseEvent) => !(e.target as HTMLElement).closest('.prl-menu') && e.target !== btn.current && close()
    window.addEventListener('mousedown', click)
    return () => window.removeEventListener('mousedown', click)
  }, [at])

  const on = new Set(sessionPrs(sessionId, tasks, git, runpr).map((p) => p.url))
  const row = (repo: string, title: string, ci: Ci | null, linked: boolean) => (
    <>
      <span className="lk-ref">{repo}</span>
      <span className="prl-title">{title}</span>
      {ci && <span className="lk-ci" style={{ background: CI_COLOR[ci] }} />}
      {linked && <span className="faint">linked</span>}
    </>
  )
  const items: PickItem[] = [
    ...(git?.mine ?? []).map((p) => ({ p, group: 'my PRs' })),
    ...(git?.reviews ?? []).map((p) => ({ p, group: 'reviews' })),
  ].map(({ p, group }) => ({ key: p.url, group, text: `${prRepo(p)} ${p.title} ${p.number}`, off: on.has(p.url), row: row(prRepo(p), p.title, p.ci, on.has(p.url)) }))
  const pasted = (q: string): PickItem | null => {
    const u = parsePrUrl(q)
    if (!u) return null
    const known = items.find((it) => it.key === u.url)
    return known ? { ...known, group: undefined } : { key: u.url, text: q, row: row(u.repo, `#${u.number}`, null, false) }
  }

  return (
    <>
      <button
        ref={btn}
        className={className}
        title={title ?? 'Link a PR to this session'}
        aria-expanded={at !== null}
        onClick={(e) => {
          if (at) return close()
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 436)) })
        }}
      >
        {children}
      </button>
      {at &&
        createPortal(
          <div className="prl-menu lk-menu" role="menu" style={{ top: at.top, left: at.left }}>
            <PickList
              items={items}
              placeholder="filter my PRs and reviews, or paste a PR URL"
              foot="↵ links the highlighted PR · paste any github.com/…/pull/N URL"
              extra={pasted}
              onClose={close}
              onPick={(url) => {
                close()
                void window.workbench.tasks.linkPr(sessionId, url)
              }}
            />
          </div>,
          document.body,
        )}
    </>
  )
}

/** Inside the GitHub pane's Task ▾ menu: my tasks to connect this PR to; the PR's tasks so far are dimmed. */
export function LinkTaskList({ prUrl, linked, onDone }: { prUrl: string; linked: string[]; onDone(): void }) {
  const tasks = useStore((s) => s.tasks)
  const items: PickItem[] = (tasks?.tasks ?? [])
    .filter((t) => !t.context)
    .map((t) => ({
      key: t.id,
      text: t.title,
      off: linked.includes(t.id),
      row: (
        <span className="lk-task" style={{ '--st': statusVivid({ colorId: t.statusColorId }) } as CSSProperties}>
          <span className="prl-rail" />
          <span className="prl-title">{t.title}</span>
          <span className="prl-status">{linked.includes(t.id) ? 'linked' : t.statusName.toLowerCase()}</span>
        </span>
      ),
    }))
  return (
    <PickList
      items={items}
      head="link this PR to a task"
      placeholder="filter my tasks"
      foot="↵ links · the PR then shows on the task and its sessions"
      onClose={onDone}
      onPick={(id) => {
        onDone()
        void window.workbench.tasks.linkPrTask(prUrl, id)
      }}
    />
  )
}
