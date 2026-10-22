import { create } from 'zustand'
import type { DraftTarget, GitSnapshot } from '@shared/git'
import type { LocalSnapshot } from '@shared/local'
import type { TasksSnapshot } from '@shared/tasks'
import { rootOf } from '@shared/workstream'
import type { CaffeinateState, HooksStatus, NavigateTarget, Session, StatusSnapshot } from '@shared/types'

export type View = { kind: 'today' } | { kind: 'local' } | { kind: 'session'; id: string } | { kind: 'workstream'; id: string }
export type TodayTab = 'tasks' | 'git' | 'reviews'

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
  local: LocalSnapshot | null
  git: GitSnapshot | null
  tasks: TasksSnapshot | null
  /** The workstream shown as a temporary place in the TopBar. */
  wsPlace: { id: string; title: string } | null
  todayTab: TodayTab
  /** The task open in the preview. */
  peekTask: string | null
  /** A PR row to scroll to and highlight. */
  focusPr: string | null
  /** Bumped on every show(), so re-selecting the current tab still hands focus back to its terminal. */
  showTick: number
  /** The draft open in Today's side panel. */
  draft: DraftTarget | null
  setLocal(l: LocalSnapshot): void
  setGit(g: GitSnapshot): void
  setTasks(t: TasksSnapshot): void
  closeWorkstream(): void
  setTodayTab(t: TodayTab): void
  setPeekTask(id: string | null): void
  setFocusPr(id: string | null): void
  setDraft(t: DraftTarget | null): void
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
  local: null,
  git: null,
  tasks: null,
  wsPlace: loadWsPlace(),
  todayTab: loadTab(),
  peekTask: null,
  focusPr: null,
  showTick: 0,
  draft: null,
  setLocal: (local) => set({ local }),
  setGit: (git) => set({ git }),
  setTasks: (tasks) => set({ tasks }),
  closeWorkstream: () => {
    set({ wsPlace: null })
    saveWsPlace(null)
    if (get().view.kind === 'workstream') get().show({ kind: 'today' })
  },
  setTodayTab: (todayTab) => {
    set({ todayTab })
    try {
      localStorage.setItem(TODAY_TAB, todayTab)
    } catch {
      // not important
    }
  },
  setPeekTask: (peekTask) => set({ peekTask, draft: null }),
  setFocusPr: (focusPr) => set({ focusPr }),
  setDraft: (draft) => set({ draft }),
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
    set({ view, mounted, showTick: get().showTick + 1 })
    persist(view)
  },
}))

const TODAY_TAB = 'workbench.todayTab'
const WS_PLACE = 'workbench.wsPlace'

function loadWsPlace(): { id: string; title: string } | null {
  try {
    return JSON.parse(localStorage.getItem(WS_PLACE) ?? 'null') as { id: string; title: string } | null
  } catch {
    return null
  }
}

function saveWsPlace(p: { id: string; title: string } | null): void {
  try {
    localStorage.setItem(WS_PLACE, JSON.stringify(p))
  } catch {
    // not important
  }
}

/** Opens the workstream a task belongs to: its topmost known parent (milestone or parent task). */
export function openWorkstream(taskId: string): void {
  const st = useStore.getState()
  const tasks = st.tasks?.tasks ?? []
  const id = rootOf(taskId, tasks)
  const wsPlace = { id, title: tasks.find((t) => t.id === id)?.title ?? 'Workstream' }
  useStore.setState({ wsPlace, draft: null })
  saveWsPlace(wsPlace)
  st.show({ kind: 'workstream', id })
}

function loadTab(): TodayTab {
  try {
    const t = localStorage.getItem(TODAY_TAB)
    return t === 'git' || t === 'reviews' ? t : 'tasks'
  } catch {
    return 'tasks'
  }
}

function persist(v: View): void {
  try {
    localStorage.setItem(LAST_VIEW, JSON.stringify(v))
  } catch {
    // not important
  }
}

export const activeSessionId = (v: View): string | null => (v.kind === 'session' ? v.id : null)

/** Opens what a notification or an in-app link points at. */
export function navigate(t: NavigateTarget): void {
  const st = useStore.getState()
  if (t.kind === 'session') return st.show({ kind: 'session', id: t.id })
  st.show({ kind: 'today' })
  st.setTodayTab(t.kind)
  st.setDraft(null)
  st.setFocusPr(t.prId)
}

/** A PR link click: its row in My git / My reviews when it's there, else GitHub. ⌘-click always opens GitHub. */
export function openPrLink(url: string, external: boolean): void {
  const git = useStore.getState().git
  const mine = git?.mine.find((p) => p.url === url)
  const review = git?.reviews.find((p) => p.url === url)
  if (external || (!mine && !review)) return void window.workbench.openExternal(url)
  navigate({ kind: mine ? 'git' : 'reviews', prId: (mine ?? review)!.id })
}
