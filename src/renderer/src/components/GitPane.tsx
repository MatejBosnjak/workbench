import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { prRef, type Pr } from '@shared/git'
import { FE_REPO } from '@shared/runpr'
import { useStore } from '../store'
import { RunAppButton } from './RunPr'

const CI = { pass: ['CI passing', 'var(--ok)'], fail: ['CI failing', 'var(--bad)'], pending: ['CI running', 'var(--info)'], none: ['no CI', 'var(--faint)'] } as const

/**
 * The GitHub pane: a strip with the PR's facts and actions, and the area the native GitHub view is laid over.
 * While an overlay is open the view hides and a still of it stands in, so nothing looks different.
 */
export function GitPane({ active }: { active: boolean }) {
  const { pane, git, overlays, paneFull, setPaneFull, paneNote, setPaneNote } = useStore()
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

  // Report the rectangle; the native view follows it.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      void window.workbench.pane.bounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [open, paneFull])

  // Visible only while this screen is up and nothing covers it; a still stands in under overlays.
  useEffect(() => {
    let cancelled = false
    const show = active && open && !covered
    if (active && open && covered) {
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

  useEffect(() => () => void window.workbench.pane.visible(false), [])

  if (!open)
    return (
      <div className="gp-empty">
        <span className="faint">Open a PR with ⏎ or a click. ⌘-click opens the browser.</span>
      </div>
    )

  const [ciText, ciColor] = pr ? CI[pr.ci] : ['', '']
  const state = !pr ? '' : pr.draft ? 'draft' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : pr.reviewDecision === 'APPROVED' ? 'approved' : 'open'
  const replies = pr && git ? pr.conversations.filter((c) => c.messages.at(-1)?.author !== git.viewer && git.seen[c.key] !== c.messages.at(-1)?.id).length : 0
  const n = key ? /\/pull\/(\d+)$/.exec(key)?.[1] : null

  return (
    <div className="gp">
      <div className="gp-strip">
        <span className="gp-ref">{pr ? prRef(pr) : key ? `${key.split('/')[4]} #${n}` : (pane?.title ?? '')}</span>
        {state && <span className={`gp-state st-${state.replace(' ', '-')}`}>{state}</span>}
        {pr && <span style={{ color: ciColor }}>● {ciText}</span>}
        {replies > 0 && <span className="gp-reply">{replies} reply needed</span>}
        {pane?.loading && <span className="faint">loading…</span>}
        <span className="gp-tools">
          {pr?.repo === FE_REPO && <RunAppButton n={pr.number} compact />}
          <button className="key-btn" title="Back (⌘[)" disabled={!pane?.canBack} onClick={() => void window.workbench.pane.nav('back')}>
            ‹
          </button>
          <button className="key-btn" title="Forward (⌘])" disabled={!pane?.canForward} onClick={() => void window.workbench.pane.nav('forward')}>
            ›
          </button>
          <button className="key-btn" title="Open in browser" onClick={() => void window.workbench.pane.nav('external')}>
            ⌘↩ browser
          </button>
          <button className="key-btn" title={paneFull ? 'Back to the split (⌘J)' : 'Full width'} onClick={() => setPaneFull(!paneFull)}>
            ⤢
          </button>
          <button
            className="key-btn"
            title="Close"
            onClick={() => {
              setPaneFull(false)
              void window.workbench.pane.close()
            }}
          >
            ×
          </button>
        </span>
      </div>
      {paneNote && (
        <div className="gp-note">
          {paneNote}
          <button className="link-btn" onClick={() => setPaneNote(null)}>
            dismiss
          </button>
        </div>
      )}
      <div className="gp-area" ref={area}>
        {still && covered && <img className="gp-still" src={still} alt="" />}
      </div>
    </div>
  )
}

