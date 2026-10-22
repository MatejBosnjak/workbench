import { create } from 'zustand'
import type { Session } from '@shared/types'

export type View = { kind: 'today' } | { kind: 'local' } | { kind: 'session'; id: string }

const LAST_VIEW = 'workbench.lastView'

function loadView(): View {
  try {
    return (JSON.parse(localStorage.getItem(LAST_VIEW) ?? '') as View) ?? { kind: 'today' }
  } catch {
    return { kind: 'today' }
  }
}

interface State {
  sessions: Session[]
  view: View
  /** Sessions whose terminal has been shown at least once; they stay mounted. */
  mounted: Set<string>
  setSessions(s: Session[]): void
  show(v: View): void
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  view: loadView(),
  mounted: new Set(),
  setSessions: (sessions) => {
    const { view, mounted } = get()
    const ids = new Set(sessions.map((s) => s.id))
    const next: Partial<State> = { sessions, mounted: new Set([...mounted].filter((id) => ids.has(id))) }
    if (view.kind === 'session' && !ids.has(view.id)) next.view = { kind: 'today' }
    set(next)
    if (next.view) persist(next.view)
  },
  show: (view) => {
    const mounted = view.kind === 'session' ? new Set(get().mounted).add(view.id) : get().mounted
    set({ view, mounted })
    persist(view)
  },
}))

function persist(v: View): void {
  try {
    localStorage.setItem(LAST_VIEW, JSON.stringify(v))
  } catch {
    // not important
  }
}

export const activeSessionId = (v: View): string | null => (v.kind === 'session' ? v.id : null)
