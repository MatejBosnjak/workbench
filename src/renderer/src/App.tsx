import { useEffect } from 'react'
import type { MenuCommand } from '@shared/types'
import { StatusBar } from './components/StatusBar'
import { Terminal } from './components/Terminal'
import { TopBar } from './components/TopBar'
import { activeSessionId, useStore } from './store'

async function newSession(pick = false): Promise<void> {
  const s = await window.workbench.createSession({ pick })
  if (s) useStore.getState().show({ kind: 'session', id: s.id })
}

function onMenu(cmd: MenuCommand): void {
  const { sessions, view, show } = useStore.getState()
  const id = activeSessionId(view)
  const at = sessions.findIndex((s) => s.id === id)
  switch (cmd.type) {
    case 'new-session':
      return void newSession()
    case 'new-session-in':
      return void newSession(true)
    case 'close-tab': {
      if (!id) return
      // Land on the neighbour, not on Today.
      const next = sessions[at + 1] ?? sessions[at - 1]
      if (next) show({ kind: 'session', id: next.id })
      return void window.workbench.closeSession(id)
    }
    case 'select-tab': {
      const s = cmd.index === 8 ? sessions.at(-1) : sessions[cmd.index]
      if (s) show({ kind: 'session', id: s.id })
      return
    }
    case 'cycle-tab': {
      if (!sessions.length) return
      const s = sessions[(at + cmd.delta + sessions.length) % sessions.length]!
      show({ kind: 'session', id: s.id })
      return
    }
  }
}

export function App() {
  const { sessions, view, mounted, setSessions, show, setStatus, setHooks } = useStore()

  useEffect(() => {
    void window.workbench.getStatus().then(setStatus)
    void window.workbench.hooksStatus().then(setHooks)
    const offStatus = window.workbench.onStatus(setStatus)
    const offHooks = window.workbench.onHooksChanged(setHooks)
    return () => {
      offStatus()
      offHooks()
    }
  }, [setStatus, setHooks])

  useEffect(() => {
    void window.workbench.listSessions().then((list) => {
      setSessions(list)
      // Re-show the restored view so its terminal mounts.
      const v = useStore.getState().view
      if (v.kind === 'session') show(v)
    })
    const offSessions = window.workbench.onSessionsChanged(setSessions)
    const offMenu = window.workbench.onMenuCommand(onMenu)
    return () => {
      offSessions()
      offMenu()
    }
  }, [setSessions, show])

  const activeId = activeSessionId(view)

  return (
    <div className="app">
      <TopBar onNew={() => void newSession()} />
      <main className="main">
        {sessions
          .filter((s) => mounted.has(s.id))
          .map((s) => (
            <Terminal key={s.id} session={s} active={s.id === activeId} />
          ))}
        {view.kind === 'today' && (
          <Placeholder title="Today" note="My tasks, My git and My reviews arrive in phases 3 and 4." />
        )}
        {view.kind === 'local' && <Placeholder title="Local" note="Local services and worktrees arrive in phase 2." />}
      </main>
      <StatusBar />
    </div>
  )
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="empty">
      <h1>{title}</h1>
      <p>{note}</p>
      <button className="primary" onClick={() => void newSession()}>
        New session
      </button>
      <p>
        <kbd>⌘T</kbd> new session · <kbd>⇧⌘T</kbd> in folder… · <kbd>⌘1–9</kbd> switch
      </p>
    </div>
  )
}
