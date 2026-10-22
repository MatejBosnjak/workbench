import type { Session } from '@shared/types'

const STATE_TEXT = { running: 'Running', waiting: 'Waiting for you', failed: 'Last run failed', idle: 'Idle' } as const

/** An external session has no terminal here: it lives in another terminal app. */
export function ExternalPanel({ session: s }: { session: Session }) {
  return (
    <div className="empty external">
      <h1>{s.title}</h1>
      <p>
        <span className={`sb-dot state-${s.state}`} style={{ display: 'inline-block', marginRight: 8 }} />
        {s.alive ? `${STATE_TEXT[s.state]} in another terminal` : 'Ended in another terminal'} · <span className="mono">{s.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
      </p>
      {s.takeOver ? (
        <>
          <p>Waiting for the terminal copy to exit. Quit it there (/exit) and it resumes here.</p>
          <button className="ghost" style={{ marginLeft: 0 }} onClick={() => void window.workbench.cancelTakeOver(s.id)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button className="primary" onClick={() => void window.workbench.takeOver(s.id)}>
            Take over
          </button>
          <p className="pop-note">{s.alive ? 'Resumes it here with --resume once the terminal copy has exited.' : 'Resumes it here with --resume.'}</p>
        </>
      )}
    </div>
  )
}
