import { useEffect } from 'react'
import type { MenuCommand } from '@shared/types'
import { ExternalPanel } from './components/ExternalPanel'
import { LocalView } from './components/LocalView'
import { TodayView } from './components/TodayView'
import { WorkstreamView } from './components/WorkstreamView'
import { DirtyGuardModal } from './components/RunPr'
import { Palette } from './components/Palette'
import { Picker } from './components/Picker'
import { StatusBar } from './components/StatusBar'
import { Terminal } from './components/Terminal'
import { TopBar } from './components/TopBar'
import { installKeys } from './keys'
import { activeSessionId, navigate, useStore } from './store'

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
      // Same numbering as the taskbar: 1 Today, 2 Local, 3… sessions; ⌘9 is the last session.
      if (cmd.index === 0) return show({ kind: 'today' })
      if (cmd.index === 1) return show({ kind: 'local' })
      const s = cmd.index === 8 ? sessions.at(-1) : sessions[cmd.index - 2]
      if (s) show({ kind: 'session', id: s.id })
      return
    }
    case 'palette':
      return useStore.getState().setPalette(!useStore.getState().paletteOpen)
    case 'cycle-tab': {
      if (!sessions.length) return
      const s = sessions[(at + cmd.delta + sessions.length) % sessions.length]!
      show({ kind: 'session', id: s.id })
      return
    }
  }
}

export function App() {
  const { sessions, view, mounted, setSessions, show, setStatus, setHooks, paletteOpen, local, setLocal } = useStore()

  const git = useStore((s) => s.git)
  useEffect(() => {
    const { setGit } = useStore.getState()
    void window.workbench.git.snapshot().then(setGit)
    const offGit = window.workbench.git.onChanged(setGit)
    const offNav = window.workbench.onNavigate(navigate)
    const { setRunpr } = useStore.getState()
    void window.workbench.runpr.snapshot().then(setRunpr)
    const offRun = window.workbench.runpr.onChanged(setRunpr)
    return () => {
      offGit()
      offNav()
      offRun()
    }
  }, [])
  useEffect(() => window.workbench.reportView(activeSessionId(view)), [view])

  const tasks = useStore((s) => s.tasks)
  useEffect(() => {
    const { setTasks } = useStore.getState()
    void window.workbench.tasks.snapshot().then(setTasks)
    return window.workbench.tasks.onChanged(setTasks)
  }, [])

  useEffect(() => {
    void window.workbench.local.snapshot().then(setLocal)
    return window.workbench.local.onChanged(setLocal)
  }, [setLocal])

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
    const offKeys = installKeys(() => void newSession())
    return () => {
      offSessions()
      offMenu()
      offKeys()
    }
  }, [setSessions, show])

  const activeId = activeSessionId(view)
  const active = sessions.find((s) => s.id === activeId)

  return (
    <div className="app">
      <TopBar onNew={() => void newSession()} />
      <main className="main">
        {sessions
          .filter((s) => mounted.has(s.id) && !s.external)
          .map((s) => (
            <Terminal key={s.id} session={s} active={s.id === activeId} />
          ))}
        {active?.external && <ExternalPanel session={active} />}
        <TodayView snapshot={tasks} git={git} active={view.kind === 'today'} />
        <LocalView snapshot={local} active={view.kind === 'local'} />
        {view.kind === 'workstream' && <WorkstreamView key={view.id} rootId={view.id} />}
      </main>
      <StatusBar>
        <Picker />
      </StatusBar>
      <DirtyGuardModal />
      {paletteOpen && <Palette onNew={(pick) => void newSession(pick)} />}
    </div>
  )
}
