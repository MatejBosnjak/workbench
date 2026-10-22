import { create } from 'zustand'
import type { CaffeinateState, HooksStatus, Session, StatusSnapshot } from '@shared/types'

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
  status: StatusSnapshot
  hooks: HooksStatus | null
  caf: CaffeinateState | null
  paletteOpen: boolean
  setCaf(c: CaffeinateState): void
  setPalette(open: boolean): void
  setStatus(s: StatusSnapshot): void
  setHooks(h: HooksStatus): void
  setSessions(s: Session[]): void
  show(v: View): void
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  view: loadView(),
  mounted: new Set(),
  status: { sessions: {}, usage: null },
  hooks: null,
  caf: null,
  paletteOpen: false,
  setCaf: (caf) => set({ caf }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setStatus: (status) => set({ status }),
  setHooks: (hooks) => set({ hooks }),
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
