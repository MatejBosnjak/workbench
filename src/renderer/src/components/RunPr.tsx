import { useEffect, useRef, useState } from 'react'
import { runTarget, type RunJob, type RunStep, type RunTarget } from '@shared/runpr'
import { useOverlay, useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'

const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Starts a run; a dirty base checkout opens the guard instead. */
export async function runPr(n: number, opts: { alongside?: boolean; dirty?: 'stash' | 'alongside'; target?: RunTarget } = {}): Promise<void> {
  const st = useStore.getState()
  try {
    const guard = await window.workbench.runpr.run(n, opts)
    if (guard) st.setRunGuard({ n, guard, target: opts.target ?? 'app' })
    else st.setRunPanel(true)
  } catch (e) {
    st.setRunError(errText(e))
    st.setRunPanel(true)
  }
}

function Play() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  )
}

/** ▶ Run app (▶ Run api for api PRs) with the hint under it, or "In app" / "In api" for the PR already running there. */
export function RunAppButton({ repo, n, compact = false }: { repo: string; n: number; compact?: boolean }) {
  const runpr = useStore((s) => s.runpr)
  const target = runTarget(repo)
  if (!runpr || !target || (target === 'api' && !runpr.api)) return null
  const api = target === 'api'
  if ((api ? runpr.apiPr : runpr.appPr) === n)
    return (
      <span className="run-in-app" title={(api ? runpr.api?.url : runpr.app.url) ?? undefined}>
        ✓ In {target}
      </span>
    )
  const busy = runpr.job?.state === 'running'
  const hint = (api ? runpr.apiHints : runpr.hints)[n]
  return (
    <span className={`run-btn-wrap${compact ? ' compact' : ''}`}>
      <button
        className="run-btn"
        disabled={busy}
        title={busy ? 'Another run is in progress' : api ? 'Serve this PR as the api: puma-dev and sidekiq move to its worktree (or the base checkout), after bundle and db:migrate' : 'Run this PR in the app'}
        onClick={(e) => (e.stopPropagation(), void runPr(n, { target }))}
      >
        <Play /> Run {target}
      </button>
      {!compact && hint && <span className="run-hint">{hint}</span>}
    </span>
  )
}

const done = (s: RunStep) => s.state === 'done' || s.state === 'skipped'

/** The status bar chip, only after a run: its progress, a failure, or ↩ Back after a base-checkout run. */
export function RunPrChip() {
  const { runpr, setRunPanel, runPanel } = useStore(useShallow((s) => ({ runpr: s.runpr, setRunPanel: s.setRunPanel, runPanel: s.runPanel })))
  if (!runpr) return null
  const job = runpr.job
  const back = runpr.back

  let chip: React.ReactNode = null
  if (job?.state === 'running') {
    const i = job.steps.findIndex((s) => s.state === 'running')
    const cur = job.steps[i]
    const pct = Math.round((job.steps.filter(done).length / job.steps.length) * 100)
    chip = (
      <button className="run-chip busy" onClick={() => setRunPanel(!runPanel)}>
        <span className="run-spin" role="img" aria-label="Running" />
        <span>
          {job.pr.title.startsWith('Back to') ? job.pr.title : <>Switching {job.target} to {job.pr.title}</>}
        </span>
        <span className="muted">
          · {cur?.label ?? '…'} · {i + 1} of {job.steps.length}
        </span>
        <span className="run-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
      </button>
    )
  } else if (job && job.state === 'failed' && runPanel === false && !(job.target === 'api' ? runpr.apiPr : runpr.appPr)) {
    chip = (
      <button className="run-chip bad" onClick={() => setRunPanel(true)}>
        Run failed · details
      </button>
    )
  } else if (back || runpr.apiBack) {
    chip = (
      <>
        {back && (
          <span className="run-chip review">
            <span className="muted">Base checkout on fe #{back.pr}{runpr.appPr === back.pr ? ' (in app)' : ''}</span>
            <BackButton />
          </span>
        )}
        {runpr.apiBack && (
          <span className="run-chip review">
            <span className="muted">Api on #{runpr.apiBack.pr}{runpr.apiPr === runpr.apiBack.pr ? ' (served)' : ''}</span>
            <ApiBackButton />
          </span>
        )}
      </>
    )
  }
  if (!chip && !runPanel) return null
  return (
    <span className="run-anchor">
      {chip}
      {runPanel && <RunPanel />}
    </span>
  )
}

function BackButton() {
  const back = useStore((s) => s.runpr?.back)
  if (!back) return null
  const to = back.detached ? back.previous.slice(0, 8) : back.previous
  return (
    <button
      className="run-back"
      title={`Check out ${to} in the base checkout${back.stash ? ', restore the stash' : ''} and restart the app where it ran before`}
      onClick={() =>
        void window.workbench.runpr.back().catch((e) => {
          useStore.getState().setRunError(errText(e))
          useStore.getState().setRunPanel(true)
        })
      }
    >
      ↩ {to}
    </button>
  )
}

function ApiBackButton() {
  const back = useStore((s) => s.runpr?.apiBack)
  if (!back) return null
  const c = back.checkout
  const to = c ? (c.detached ? c.previous.slice(0, 8) : c.previous) : back.link.split('/').pop()
  return (
    <button
      className="run-back"
      title={`Point puma-dev back at ${back.link.replace(/^\/Users\/[^/]+/, '~')} and sidekiq at ${back.sidekiq.replace(/^\/Users\/[^/]+/, '~')}${c ? `, check out ${to} in the base checkout${c.stash ? ', restore the stash' : ''}` : ''}`}
      onClick={() =>
        void window.workbench.runpr.back('api').catch((e) => {
          useStore.getState().setRunError(errText(e))
          useStore.getState().setRunPanel(true)
        })
      }
    >
      ↩ {to}
    </button>
  )
}

const STEP_ICON: Record<RunStep['state'], string> = { pending: '○', running: '', done: '✓', skipped: '–', failed: '✕' }

function ms(n: number | null): string {
  if (n == null) return ''
  return n < 1000 ? `${n}ms` : n < 60_000 ? `${Math.round(n / 1000)}s` : `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`
}

/** Steps, log tail, Cancel. Opens from the chip; also shown in Local. */
export function RunPanel({ inline = false }: { inline?: boolean }) {
  useOverlay(!inline)
  const { runpr, setRunPanel, runError, setRunError } = useStore(useShallow((s) => ({ runpr: s.runpr, setRunPanel: s.setRunPanel, runError: s.runError, setRunError: s.setRunError })))
  const root = useRef<HTMLDivElement>(null)
  const log = useRef<HTMLPreElement>(null)
  const job: RunJob | null = runpr?.job ?? null

  useEffect(() => {
    if (inline) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.closest('.run-anchor')?.contains(e.target as Node)) setRunPanel(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [inline, setRunPanel])

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [job?.log.length])

  if (!job && !runError) return null
  const sub = !job ? '' : job.mode === 'worktree' ? `worktree${job.matchedBy ? ` found · matched by ${job.matchedBy}` : ''}` : job.pr.title.startsWith('Back to') ? 'restoring the base checkout' : 'no worktree · base checkout'
  return (
    <div className={`run-panel${inline ? ' inline' : ' popover'}`} ref={root} role="dialog" aria-label="Run PR">
      {job && (
        <>
          <div className="run-panel-head">
            <span className="run-panel-title">{job.pr.title.startsWith('Back to') ? job.pr.title : job.target === 'api' ? `Serve ${job.pr.title} as the api` : `Run ${job.pr.title} in the app`}</span>
            <span className={`run-state ${job.state}`}>{job.state === 'running' ? 'running' : job.state}</span>
          </div>
          <span className="pop-note">
            {sub}
            {job.alongside ? ' · alongside' : ''}
          </span>
          <span className="mono run-path">{job.path.replace(/^\/Users\/[^/]+/, '~')}</span>
          <div className="run-steps">
            {job.steps.map((s) => (
              <div key={s.id} className={`run-step ${s.state}`}>
                <span className="run-step-icon">{s.state === 'running' ? <span className="run-spin" /> : STEP_ICON[s.state]}</span>
                <span className="run-step-label mono">{s.label}</span>
                {s.detail && <span className="pop-note run-step-detail">{s.detail}</span>}
                <span className="mono muted run-step-ms">{s.state === 'skipped' ? 'skipped' : ms(s.ms)}</span>
              </div>
            ))}
          </div>
          {job.log.length > 0 && <pre className="run-log" ref={log}>{job.log.slice(-40).join('\n')}</pre>}
          {job.error && <span className="bad-text">{job.error}</span>}
        </>
      )}
      {runError && <span className="bad-text">{runError}</span>}
      <div className="run-panel-foot">
        {job?.state === 'running' ? (
          <>
            <button className="ghost" onClick={() => void window.workbench.runpr.cancel()}>
              Cancel
            </button>
            {job.target === 'app' && !job.alongside && !job.pr.title.startsWith('Back to') && (
              <button
                className="link-btn"
                onClick={async () => {
                  await window.workbench.runpr.cancel()
                  setTimeout(() => void runPr(job.pr.number, { alongside: true }), 500)
                }}
              >
                Run alongside instead
              </button>
            )}
          </>
        ) : (
          <>
            {job?.url && job.state === 'done' && (
              <button className="link-btn" onClick={() => void window.workbench.openExternal(job.url!)}>
                → {job.url.replace(/^https?:\/\//, '')}
              </button>
            )}
            {!inline && (
              <button
                className="ghost"
                onClick={() => {
                  setRunPanel(false)
                  setRunError(null)
                }}
              >
                Close
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Never checks out over uncommitted work. */
export function DirtyGuardModal() {
  const { runGuard, setRunGuard } = useStore(useShallow((s) => ({ runGuard: s.runGuard, setRunGuard: s.setRunGuard })))
  useOverlay(!!runGuard)
  const [busy, setBusy] = useState(false)
  if (!runGuard) return null
  const { n, guard, target } = runGuard
  const label = `${target === 'api' ? 'api' : 'fe'} #${n}`
  const choose = async (dirty: 'stash' | 'alongside' | null) => {
    setBusy(true)
    setRunGuard(null)
    if (dirty) await runPr(n, { dirty, target })
    setBusy(false)
  }
  return (
    <div className="scrim" onMouseDown={() => void choose(null)}>
      <div className="guard" role="dialog" aria-label="Uncommitted changes" onMouseDown={(e) => e.stopPropagation()}>
        <span className="guard-title">
          Base checkout has {guard.files.length} uncommitted change{guard.files.length > 1 ? 's' : ''}
        </span>
        <span className="muted">
          Checking out {label} in <span className="mono">{guard.path.replace(/^\/Users\/[^/]+/, '~')}</span> would carry these along.
        </span>
        <pre className="guard-files">{guard.files.slice(0, 20).join('\n')}{guard.files.length > 20 ? `\n… ${guard.files.length - 20} more` : ''}</pre>
        <div className="guard-actions">
          <button className="primary" disabled={busy} onClick={() => void choose('stash')}>
            Stash and continue
          </button>
          {target === 'app' && (
            <button className="ghost" disabled={busy} onClick={() => void choose('alongside')}>
              Run alongside instead
            </button>
          )}
          <button className="ghost" disabled={busy} onClick={() => void choose(null)}>
            Cancel
          </button>
        </div>
        <span className="pop-note">The stash is named “workbench: before {label}” and ↩ Back restores it.</span>
      </div>
    </div>
  )
}
