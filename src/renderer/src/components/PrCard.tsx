import { useEffect, useState } from 'react'
import type { PrInfo } from '@shared/types'
import { RunAppButton } from './RunPr'

export interface CardAnchor {
  url: string
  x: number
  y: number
}

const CHECKS: Record<NonNullable<PrInfo['checks']>, [string, string]> = {
  SUCCESS: ['CI passing', 'var(--ok)'],
  FAILURE: ['CI failing', 'var(--bad)'],
  PENDING: ['CI running', 'var(--warn)'],
}

function stateOf(pr: PrInfo): [string, string] {
  if (pr.state === 'MERGED') return ['Merged', 'var(--violet)']
  if (pr.state === 'CLOSED') return ['Closed', 'var(--bad)']
  if (pr.isDraft) return ['Draft', 'var(--muted)']
  return ['Open', 'var(--ok)']
}

const REVIEW: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }

export function PrCard({ anchor, onEnter, onLeave }: { anchor: CardAnchor; onEnter?(): void; onLeave?(): void }) {
  const [pr, setPr] = useState<PrInfo | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    setPr(undefined)
    void window.workbench.prInfo(anchor.url).then((p) => live && setPr(p))
    return () => {
      live = false
    }
  }, [anchor.url])

  const left = Math.min(anchor.x, window.innerWidth - 380)
  const top = anchor.y + 18 + 140 > window.innerHeight ? anchor.y - 150 : anchor.y + 18
  return (
    <div className="pr-card" style={{ left, top }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {pr === undefined && <span className="muted">Loading PR…</span>}
      {pr === null && <span className="muted">Couldn't load this PR with gh.</span>}
      {pr && (
        <>
          <span className="pr-card-head mono">
            {pr.repo} #{pr.number}
          </span>
          <span className="pr-card-title">{pr.title}</span>
          <span className="pr-card-meta">
            <span style={{ color: stateOf(pr)[1] }}>{stateOf(pr)[0]}</span>
            {pr.reviewDecision && <span>{REVIEW[pr.reviewDecision] ?? pr.reviewDecision}</span>}
            {pr.checks && <span style={{ color: CHECKS[pr.checks][1] }}>{CHECKS[pr.checks][0]}</span>}
          </span>
          {pr.repo === 'productiveio/frontend' && pr.state === 'OPEN' && <RunAppButton n={pr.number} />}
          <span className="pop-note">Click opens its row in Workbench · ⌘-click opens GitHub</span>
        </>
      )}
    </div>
  )
}
