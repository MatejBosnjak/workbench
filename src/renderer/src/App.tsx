import { useEffect, type CSSProperties } from 'react'
import type { MenuCommand } from '@shared/types'
import { isTheme } from '@shared/theme'
import { ExternalPanel } from './components/ExternalPanel'
import { LocalView } from './components/LocalView'
import { PrSide, SessionBar, sessionPrs, SideResizer, TaskSide } from './components/TaskSide'
import { TodayView } from './components/TodayView'
import { WorkstreamView } from './components/WorkstreamView'
import { DirtyGuardModal } from './components/RunPr'
import { Palette } from './components/Palette'
import { FocusDigest } from './components/Focus'
import { Picker } from './components/Picker'
import { StatusBar } from './components/StatusBar'
import { Terminal } from './components/Terminal'
import { MarkRail, stepMarks } from './components/Marks'
import { TopBar } from './components/TopBar'
import { installKeys } from './keys'
import { activeSessionId, navigate, useStore } from './store'
import { useShallow } from 'zustand/react/shallow'

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
    case 'task-side':
      return useStore.getState().toggleSessionSide('task')
    case 'pr-side': {
      // Nothing to show without a PR; leave whatever sidebar is open.
      const st = useStore.getState()
      if (id && sessionPrs(id, st.tasks, st.git, st.runpr).length) st.toggleSessionSide('pr')
      return
    }
    case 'mark-step':
      return stepMarks(cmd.delta)
    case 'focus':
      return void useStore.getState().toggleFocus()
    case 'theme':
      return useStore.getState().setTheme(cmd.theme)
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
  const { sessions, view, mounted, setSessions, show, setStatus, setHooks, paletteOpen, local, setLocal } = useStore(useShallow((s) => ({ sessions: s.sessions, view: s.view, mounted: s.mounted, setSessions: s.setSessions, show: s.show, setStatus: s.setStatus, setHooks: s.setHooks, paletteOpen: s.paletteOpen, local: s.local, setLocal: s.setLocal })))

  const git = useStore((s) => s.git)
  useEffect(() => {
    const { setGit } = useStore.getState()
    void window.workbench.git.snapshot().then(setGit)
    const offGit = window.workbench.git.onChanged(setGit)
    const offNav = window.workbench.onNavigate(navigate)
    const { setRunpr } = useStore.getState()
    void window.workbench.getSetting<Record<string, number>>('ui:snoozed', {}).then((sn) => useStore.setState({ snoozed: Object.fromEntries(Object.entries(sn).filter(([, t]) => t > Date.now())) }))
    void window.workbench.getSetting<Record<string, 'task' | 'pr'>>('ui:sessionSides', {}).then((sessionSides) => useStore.setState({ sessionSides }))
    void window.workbench.getSetting<Partial<Record<'task' | 'pr', number>>>('ui:sideWidths', {}).then((sideWidths) => useStore.setState({ sideWidths }))
    void window.workbench.getSetting<string>('ui:theme', useStore.getState().theme).then((t) => isTheme(t) && t !== useStore.getState().theme && useStore.getState().setTheme(t))
    void window.workbench.getSetting<boolean>('ui:hideDoneTodos', false).then((hideDoneTodos) => useStore.setState({ hideDoneTodos }))
    void window.workbench.runpr.snapshot().then(setRunpr)
    const offRun = window.workbench.runpr.onChanged(setRunpr)
    // ⌘J inside the GitHub pane: back to the list, out of full width.
    const offList = window.workbench.pane.onList(() => useStore.getState().setPaneFull(false))
    const offHeld = window.workbench.onHeld((held) => useStore.setState({ held }))
    return () => {
      offGit()
      offNav()
      offRun()
      offList()
      offHeld()
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
    const set = useStore.getState().setCleanup
    void window.workbench.cleanup.snapshot().then(set)
    return window.workbench.cleanup.onChanged(set)
  }, [])

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
  const sessionSide = useStore((s) => (activeId ? s.sessionSides[activeId] : undefined))
  // A PR sidebar only shows while the session has a PR to show.
  const hasPr = useStore((s) => !!activeId && sessionPrs(activeId, s.tasks, s.git, s.runpr).length > 0)
  const paneFull = useStore((s) => s.paneFull)
  const focus = useStore((s) => s.focus)
  const side = view.kind === 'session' && !!active && !active.external && sessionSide && (sessionSide !== 'pr' || hasPr) ? sessionSide : null
  const sideWidth = useStore((s) => (side ? s.sideWidths[side] : undefined))
  const full = side === 'pr' && paneFull

  return (
    <div className={`app${focus ? ' focus' : ''}`}>
      <div className="crt-fx" aria-hidden="true" />
      <TopBar onNew={() => void newSession()} />
      {view.kind === 'session' && active && !active.external && <SessionBar session={active} />}
      <main className={`main${side ? ` with-side side-${side}${full ? ' side-full' : ''}` : ''}`} style={sideWidth ? ({ '--side-w': `min(${sideWidth}px, calc(100% - 360px))` } as CSSProperties) : undefined}>
        {sessions
          .filter((s) => mounted.has(s.id) && !s.external)
          .map((s) => (
            <Terminal key={s.id} session={s} active={s.id === activeId} />
          ))}
        {view.kind === 'session' && active && !active.external && <MarkRail key={active.id} session={active} />}
        {active?.external && <ExternalPanel session={active} />}
        {side === 'task' && <TaskSide session={active!} />}
        {side === 'pr' && <PrSide session={active!} />}
        {side && !full && <SideResizer side={side} />}
        <TodayView snapshot={tasks} git={git} active={view.kind === 'today'} />
        <LocalView snapshot={local} active={view.kind === 'local'} />
        {view.kind === 'workstream' && <WorkstreamView key={view.id} rootId={view.id} />}
      </main>
      <StatusBar>
        <Picker />
      </StatusBar>
      <DirtyGuardModal />
      <FocusDigest />
      {paletteOpen && <Palette onNew={(pick) => void newSession(pick)} />}
    </div>
  )
}
