import { useEffect, useRef, useState } from 'react'
import type { RunJob, RunStep } from '@shared/runpr'
import { activeSessionId, useStore } from '../store'

const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Starts a run; a dirty base checkout opens the guard instead. */
export async function runPr(n: number, opts: { alongside?: boolean; dirty?: 'stash' | 'alongside' } = {}): Promise<void> {
  const st = useStore.getState()
  try {
    const guard = await window.workbench.runpr.run(n, opts)
    if (guard) st.setRunGuard({ n, guard })
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

/** ▶ Run app with the hint under it, or "In app" for the PR the app already runs. */
export function RunAppButton({ n, compact = false }: { n: number; compact?: boolean }) {
  const runpr = useStore((s) => s.runpr)
  if (!runpr) return null
  if (runpr.appPr === n)
    return (
      <span className="run-in-app" title={runpr.app.url ?? undefined}>
        ✓ In app
      </span>
    )
  const busy = runpr.job?.state === 'running'
  return (
    <span className={`run-btn-wrap${compact ? ' compact' : ''}`}>
      <button className="run-btn" disabled={busy} title={busy ? 'Another run is in progress' : `Run fe #${n} in the app`} onClick={(e) => (e.stopPropagation(), void runPr(n))}>
        <Play /> Run app
      </button>
      {!compact && runpr.hints[n] && <span className="run-hint">{runpr.hints[n]}</span>}
    </span>
  )
}

const done = (s: RunStep) => s.state === 'done' || s.state === 'skipped'

/** The status bar chip: mismatch → ▶ Run, running, ✓ in app, ↩ Back. */
export function RunPrChip() {
  const { runpr, view, setRunPanel, runPanel } = useStore()
  if (!runpr) return null
  const sid = activeSessionId(view)
  const focus = sid ? runpr.focus[sid] : undefined
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
          {job.pr.title.startsWith('Back to') ? job.pr.title : <>Switching app to <span className="mono">fe #{job.pr.number}</span></>}
        </span>
        <span className="muted">
          · {cur?.label ?? '…'} · {i + 1} of {job.steps.length}
        </span>
        <span className="run-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
      </button>
    )
  } else if (job && job.state === 'failed' && runPanel === false && !runpr.appPr) {
    chip = (
      <button className="run-chip bad" onClick={() => setRunPanel(true)}>
        Run fe #{job.pr.number} failed · details
      </button>
    )
  } else if (focus && runpr.appPr !== focus.number) {
    chip = (
      <span className="run-chip mismatch">
        <span className="muted">App</span>
        <span className="run-branch" title={`${runpr.app.branch ?? 'detached'} · ${runpr.app.path}`}>
          ⑂ {runpr.app.running ? (runpr.app.branch ?? 'detached') : 'stopped'}
        </span>
        <span className="run-arrow">→</span>
        <span className="muted">Session</span>
        <span className="mono" title={focus.title}>
          fe #{focus.number}
        </span>
        <button className="run-go" onClick={() => void runPr(focus.number)}>
          <Play /> Run
        </button>
        {back && <BackButton />}
      </span>
    )
  } else if (runpr.appPr && (focus?.number === runpr.appPr || back?.pr === runpr.appPr)) {
    const reviewing = back?.pr === runpr.appPr
    chip = (
      <span className={`run-chip ${reviewing ? 'review' : 'ok'}`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        <span>
          App on <span className="mono">fe #{runpr.appPr}</span>
          {reviewing && <span className="muted"> (review)</span>}
        </span>
        {runpr.app.url && (
          <button className="link-btn" onClick={() => void window.workbench.openExternal(runpr.app.url!)}>
            {runpr.app.url.replace(/^https?:\/\//, '')}
          </button>
        )}
        {reviewing && <BackButton />}
      </span>
    )
  } else if (back) {
    chip = (
      <span className="run-chip review">
        <span className="muted">Base checkout on fe #{back.pr}</span>
        <BackButton />
      </span>
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

const STEP_ICON: Record<RunStep['state'], string> = { pending: '○', running: '', done: '✓', skipped: '–', failed: '✕' }

function ms(n: number | null): string {
  if (n == null) return ''
  return n < 1000 ? `${n}ms` : n < 60_000 ? `${Math.round(n / 1000)}s` : `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`
}

/** Steps, log tail, Cancel. Opens from the chip; also shown in Local. */
export function RunPanel({ inline = false }: { inline?: boolean }) {
  const { runpr, setRunPanel, runError, setRunError } = useStore()
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
            <span className="run-panel-title">{job.pr.title.startsWith('Back to') ? job.pr.title : `Run fe #${job.pr.number} in app`}</span>
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
            {!job.alongside && !job.pr.title.startsWith('Back to') && (
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
  const { runGuard, setRunGuard } = useStore()
  const [busy, setBusy] = useState(false)
  if (!runGuard) return null
  const { n, guard } = runGuard
  const choose = async (dirty: 'stash' | 'alongside' | null) => {
    setBusy(true)
    setRunGuard(null)
    if (dirty) await runPr(n, { dirty })
    setBusy(false)
  }
  return (
    <div className="scrim" onMouseDown={() => void choose(null)}>
      <div className="guard" role="dialog" aria-label="Uncommitted changes" onMouseDown={(e) => e.stopPropagation()}>
        <span className="guard-title">
          Base checkout has {guard.files.length} uncommitted change{guard.files.length > 1 ? 's' : ''}
        </span>
        <span className="muted">
          Checking out fe #{n} in <span className="mono">{guard.path.replace(/^\/Users\/[^/]+/, '~')}</span> would carry these along.
        </span>
        <pre className="guard-files">{guard.files.slice(0, 20).join('\n')}{guard.files.length > 20 ? `\n… ${guard.files.length - 20} more` : ''}</pre>
        <div className="guard-actions">
          <button className="primary" disabled={busy} onClick={() => void choose('stash')}>
            Stash and continue
          </button>
          <button className="ghost" disabled={busy} onClick={() => void choose('alongside')}>
            Run alongside instead
          </button>
          <button className="ghost" disabled={busy} onClick={() => void choose(null)}>
            Cancel
          </button>
        </div>
        <span className="pop-note">The stash is named “workbench: before fe #{n}” and ↩ Back restores it.</span>
      </div>
    </div>
  )
}
