import { memo, useEffect, useState } from 'react'
import type { LocalSnapshot, ServiceState } from '@shared/local'
import { Panes } from './Panes'
import { WorktreeSwitcher } from './WorktreeSwitcher'
import { RunPanel } from './RunPr'
import { useStore } from '../store'

const STATE: Record<ServiceState['status'], string> = { running: 'running', stopping: 'stopping…', stopped: 'stopped', crashed: 'crashed' }
const home = (p: string) => p.replace(/^\/Users\/[^/]+\/(Productive\/)?/, '')

function uptime(s: ServiceState, now: number): string {
  if (!s.startedAt || s.status !== 'running') return '—'
  const m = Math.max(0, Math.floor((now - s.startedAt) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function stateText(s: ServiceState): string {
  if (s.status === 'crashed') return `exited · code ${s.exitCode}`
  if (s.status === 'running' && s.def.port) return s.healthy ? `running · :${s.def.port}` : `starting · :${s.def.port}`
  return STATE[s.status]
}

export const LocalView = memo(function LocalView({ snapshot, active }: { snapshot: LocalSnapshot | null; active: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [switcher, setSwitcher] = useState(false)
  const runJob = useStore((s) => s.runpr?.job)
  const [, tick] = useState(0)
  const now = Date.now()

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!active || !snapshot) return
    void window.workbench.local.refreshInfra()
  }, [active, snapshot === null])

  if (!snapshot) return null
  const { services, profiles, profile, infra } = snapshot
  const inProfile = services.filter((s) => s.def.profiles.includes(profile) || s.transient)
  const missing = inProfile.filter((s) => s.status !== 'running' && s.status !== 'stopping' && !s.transient)
  const anyRunning = services.some((s) => s.status === 'running')
  const current = services.find((s) => s.name === selected) ?? inProfile[0] ?? services[0]

  return (
    <div className="local" hidden={!active}>
      <div className="local-head">
        <h1>Local services</h1>
        <div className="seg" role="radiogroup" aria-label="Profile">
          {profiles.map((p) => (
            <button key={p.id} role="radio" aria-checked={p.id === profile} onClick={() => void window.workbench.local.setProfile(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="local-actions">
          <button className="ghost" disabled={!anyRunning} onClick={() => void window.workbench.local.stopAll()}>
            Stop all
          </button>
          <button className="primary" disabled={missing.length === 0} onClick={() => void window.workbench.local.startMissing(profile)}>
            Start missing ({missing.length})
          </button>
        </div>
      </div>

      {runJob && runJob.state !== 'done' && runJob.state !== 'cancelled' && (
        <div className="local-run">
          <RunPanel inline />
        </div>
      )}
      <div className="local-body">
        <section className="svc-list" aria-label="Services">
          {inProfile.map((s) => {
            const on = s.name === current?.name
            return (
              <button key={s.name} className={`svc${on ? ' on' : ''}`} onClick={() => setSelected(s.name)}>
                <span className="svc-line">
                  <span className={`svc-dot svc-${s.status}${s.status === 'running' && s.healthy === false ? ' svc-starting' : ''}`} />
                  <span className="svc-name">{s.name}</span>
                  <span className="mono muted svc-up">{uptime(s, now)}</span>
                </span>
                <span className={`svc-state svc-text-${s.status}`}>{stateText(s)}</span>
                {on && s.branch && (
                  <span className="svc-branch mono">
                    <BranchIcon /> {s.branch}
                  </span>
                )}
              </button>
            )
          })}
          <div className="infra">
            <span className="pop-label">Infra · brew services</span>
            <div className="infra-chips">
              {infra.map((i) => (
                <button
                  key={i.name}
                  className={`chip infra-${i.status === 'started' ? 'ok' : i.status === 'error' ? 'bad' : 'off'}`}
                  title={i.status === 'started' ? `${i.name}: started` : `${i.name}: ${i.status} · click to start`}
                  disabled={i.status === 'started'}
                  onClick={() => void window.workbench.local.startInfra(i.name)}
                >
                  <span className="chip-dot" />
                  {i.name.replace(/@.*/, '')}
                </button>
              ))}
            </div>
          </div>
        </section>

        {current && (
          <main className="svc-detail">
            <div className="svc-detail-head">
              {current.def.repo ? (
                <button className="wt-btn mono" aria-label="Switch worktree" onClick={() => setSwitcher(true)}>
                  <BranchIcon />
                  <span>{current.branch ?? '(no branch)'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              ) : (
                <span className="mono">{current.branch ?? '—'}</span>
              )}
              <span className="mono muted svc-path">
                {home(current.cwd)}
                {current.behind ? ` · ${current.behind} behind ${current.base}` : ''}
              </span>
              <div className="local-actions">
                {current.def.url && (
                  <button className="ghost" disabled={current.status !== 'running'} onClick={() => void window.workbench.openExternal(current.def.url!)}>
                    Open in browser
                  </button>
                )}
                {current.status === 'running' || current.status === 'stopping' ? (
                  <>
                    <button className="ghost" onClick={() => void window.workbench.local.restart(current.name)}>
                      Restart
                    </button>
                    <button className="ghost" disabled={current.status === 'stopping'} onClick={() => void window.workbench.local.stop(current.name)}>
                      Stop
                    </button>
                  </>
                ) : (
                  <button className="ghost" onClick={() => void window.workbench.local.start(current.name)}>
                    Start
                  </button>
                )}
              </div>
            </div>
            {active && <Panes key={current.name} service={current} />}
          </main>
        )}
      </div>
      {switcher && current && <WorktreeSwitcher service={current} onClose={() => setSwitcher(false)} />}
    </div>
  )
})

function BranchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 10.5c0 4-6 3-11 5.5" />
    </svg>
  )
}
