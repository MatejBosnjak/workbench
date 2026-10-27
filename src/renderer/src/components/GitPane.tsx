import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { prRef, prRepo, shortRepo, type Pr } from '@shared/git'
import { useStore } from '../store'
import { CiLink, UnlinkIcon } from './Chips'
import { PrLinks } from './PrLinks'
import { RunAppButton } from './RunPr'
import { useShallow } from 'zustand/react/shallow'

const CI = { pass: ['CI passing', 'var(--ok)'], fail: ['CI failing', 'var(--bad)'], pending: ['CI running', 'var(--info)'], none: ['no CI', 'var(--faint)'] } as const

/**
 * The GitHub pane: a strip with the PR's facts and actions, and the area the native GitHub view is laid over.
 * While an overlay is open the view hides and a still of it stands in, so nothing looks different.
 */
export function GitPane({
  active,
  onClose,
  onUnlink,
  side = false,
}: {
  active: boolean
  /** Replaces closing the pane (the session sidebar closes itself instead). */
  onClose?(): void
  /** In a session's sidebar: takes the shown PR off the session (an unlink button after back / forward). */
  onUnlink?(url: string): void
  /** In a session's sidebar: framed like the task sidebar, without the task and session links the session bar already shows. */
  side?: boolean
}) {
  const { pane, git, overlays, paneFull, setPaneFull, paneNote, setPaneNote } = useStore(useShallow((s) => ({ pane: s.pane, git: s.git, overlays: s.overlays, paneFull: s.paneFull, setPaneFull: s.setPaneFull, paneNote: s.paneNote, setPaneNote: s.setPaneNote })))
  const area = useRef<HTMLDivElement>(null)
  const [still, setStill] = useState<string | null>(null)
  const key = pane?.prUrl ?? null
  const pr: Pr | undefined = key ? [...(git?.mine ?? []), ...(git?.reviews ?? [])].find((p) => p.url === key) : undefined
  const open = !!pane?.url
  const covered = overlays > 0

  useEffect(() => {
    void window.workbench.pane.state().then((s) => useStore.getState().setPane(s))
    return window.workbench.pane.onChanged((s) => useStore.getState().setPane(s))
  }, [])

  // Report the rectangle; the native view follows it. Size changes come from the ResizeObserver; moves without a
  // resize (counters appearing, split sizes loading, zoom) are caught by checking the position every frame,
  // but only while the pane is on screen: Today stays mounted when hidden, and the loop would never let the renderer idle.
  useLayoutEffect(() => {
    const el = area.current
    if (!el || !active || !open) return
    let last = ''
    const report = () => {
      const r = el.getBoundingClientRect()
      const next = `${r.left},${r.top},${r.width},${r.height},${window.devicePixelRatio}`
      if (next === last) return
      last = next
      void window.workbench.pane.bounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    let frame = 0
    const tick = () => {
      report()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [active, open, paneFull])

  // Visible only while this screen is up and nothing covers it; a still stands in under overlays. Today and a session
  // sidebar each mount a GitPane over the one native view, so only the instance on screen drives it; one that goes off
  // screen hides it once.
  const shown = useRef(false)
  useEffect(() => {
    if (!active) {
      if (shown.current) void window.workbench.pane.visible(false)
      shown.current = false
      return
    }
    shown.current = true
    let cancelled = false
    const show = open && !covered
    if (open && covered) {
      void window.workbench.pane.capture().then((img) => {
        if (cancelled) return
        setStill(img)
        void window.workbench.pane.visible(false)
      })
    } else {
      void window.workbench.pane.visible(show)
      if (show) setStill(null)
    }
    return () => {
      cancelled = true
    }
  }, [active, open, covered])

  useEffect(() => () => void (shown.current && window.workbench.pane.visible(false)), [])

  if (!open)
    return (
      <div className="gp-empty">
        <span className="faint">Open a PR with ⏎ or a click. ⌘-click opens the browser.</span>
      </div>
    )

  const [ciText, ciColor] = pr ? CI[pr.ci] : ['', '']
  const state = !pr ? '' : pr.draft ? 'draft' : pr.reviewDecision === 'CHANGES_REQUESTED' ? (pr.changesAddressed ? 're-review asked' : 'changes requested') : pr.reviewDecision === 'APPROVED' ? 'approved' : 'open'
  const replies = pr && git ? pr.conversations.filter((c) => c.messages.at(-1)?.author !== git.viewer && git.seen[c.key] !== c.messages.at(-1)?.id).length : 0
  const n = key ? /\/pull\/(\d+)$/.exec(key)?.[1] : null

  const facts = (
    <>
      <span className="gp-ref" title={pr ? prRef(pr) : undefined}>{pr ? prRepo(pr) : key ? shortRepo(key.split('/')[4] ?? '') : ''}</span>
      <span className="gp-title">{pr?.title ?? pane?.title ?? ''}</span>
      {state && <span className={`gp-state st-${state.replace(' ', '-')}`}>{state}</span>}
      {pr && (
        <CiLink url={pr.ciUrl} color={ciColor}>
          ●{side ? ` ${ciText}` : ''}
        </CiLink>
      )}
      {replies > 0 && (
        <span className="gp-reply" title={`${replies} ${replies === 1 ? 'reply' : 'replies'} needed`}>
          ↩ {replies}
        </span>
      )}
      {pane?.loading && <span className="faint">loading…</span>}
    </>
  )
  const tools = (
    <span className="gp-tools">
      {pr && <RunAppButton repo={pr.repo} n={pr.number} compact />}
      <button className="key-btn" title="Back (⌘[)" disabled={!pane?.canBack} onClick={() => void window.workbench.pane.nav('back')}>
        ‹
      </button>
      <button className="key-btn" title="Forward (⌘])" disabled={!pane?.canForward} onClick={() => void window.workbench.pane.nav('forward')}>
        ›
      </button>
      {onUnlink && key && (
        <button className="key-btn tl-unlink" title="Unlink this PR from the session" aria-label="Unlink this PR from the session" onClick={() => onUnlink(key)}>
          <UnlinkIcon />
        </button>
      )}
      <button className="key-btn" title="Open in browser (⌘↩)" aria-label="Open in browser" onClick={() => void window.workbench.pane.nav('external')}>
        ↗
      </button>
      <button className="key-btn tl-full" title={paneFull ? 'Back to the split (⌘J)' : 'Full width'} onClick={() => setPaneFull(!paneFull)}>
        ⤢
      </button>
      <button
        className="key-btn tl-close"
        title="Close"
        onClick={() => {
          setPaneFull(false)
          if (onClose) onClose()
          else void window.workbench.pane.close()
        }}
      >
        ×
      </button>
    </span>
  )
  const note = paneNote && (
    <div className="gp-note">
      {paneNote}
      <button className="link-btn" onClick={() => setPaneNote(null)}>
        dismiss
      </button>
    </div>
  )
  const areaEl = (
    <div className="gp-area" ref={area}>
      {still && covered && <img className="gp-still" src={still} alt="" />}
    </div>
  )

  if (side)
    return (
      <section className="box gp gp-side">
        <span className="box-title gp-facts">{facts}</span>
        <span className="box-aside">{tools}</span>
        {note}
        {areaEl}
      </section>
    )
  return (
    <div className="gp">
      <div className="gp-strip">
        {facts}
        {key && <PrLinks pr={pr} prUrl={key} />}
        {tools}
      </div>
      {note}
      {areaEl}
    </div>
  )
}

