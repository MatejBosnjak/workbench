import { create } from 'zustand'
import type { DraftTarget, GitSnapshot } from '@shared/git'
import type { LocalSnapshot } from '@shared/local'
import type { TasksSnapshot } from '@shared/tasks'
import type { DirtyGuard, RunPrSnapshot } from '@shared/runpr'
import type { PaneState } from '@shared/pane'
import { prKey } from '@shared/pane'
import { useEffect } from 'react'
import { rootOf } from '@shared/workstream'
import type { CaffeinateState, HooksStatus, NavigateTarget, Session, StatusSnapshot } from '@shared/types'

export type View = { kind: 'today' } | { kind: 'local' } | { kind: 'session'; id: string } | { kind: 'workstream'; id: string }
export type TodayTab = 'needs' | 'tasks' | 'git' | 'reviews'

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
  /**
   * The most recently shown session terminals, oldest first; at most MOUNTED_MAX stay mounted. Each one holds an
   * xterm buffer and a WebGL context; an evicted one re-attaches and main replays its history when shown again.
   */
  mounted: Set<string>
  status: StatusSnapshot
  hooks: HooksStatus | null
  caf: CaffeinateState | null
  paletteOpen: boolean
  cafOpen: boolean
  keysOpen: boolean
  setKeysOpen(open: boolean): void
  setCafOpen(open: boolean): void
  local: LocalSnapshot | null
  git: GitSnapshot | null
  tasks: TasksSnapshot | null
  /** The workstream shown as a temporary place in the TopBar. */
  wsPlace: { id: string; title: string } | null
  todayTab: TodayTab
  /** The task open in the preview. */
  peekTask: string | null
  /** The Needs you item shown in the sidebar (its key); a second ⏎ or a double-click opens it. */
  peekNeed: string | null
  setPeekNeed(key: string | null): void
  /** A PR row to scroll to and highlight. */
  focusPr: string | null
  /** The PR row picked with j / k in My PRs and Reviews. */
  selPr: string | null
  setSelPr(id: string | null): void
  /** Bumped on every show(), so re-selecting the current tab still hands focus back to its terminal. */
  showTick: number
  /** The draft open in Today's side panel. */
  draft: DraftTarget | null
  setLocal(l: LocalSnapshot): void
  setGit(g: GitSnapshot): void
  runpr: RunPrSnapshot | null
  pane: PaneState | null
  /** The GitHub pane takes the whole body (⤢). */
  paneFull: boolean
  /** The task sidebar beside a session's terminal (⌘I). Kept as ui:taskSide. */
  taskSide: boolean
  setTaskSide(on: boolean): void
  /** A line under the pane's strip, e.g. what happened to a Claude draft. */
  paneNote: string | null
  /** Open overlays (palette, popovers, modals); the native pane hides behind a still while any is open. */
  overlays: number
  /** PRs opened from a link that aren't in My git or My reviews: a temporary "Opened" group. */
  openedPrs: { url: string; title: string }[]
  /** Needs-you items put to sleep: item key → until (ms). Kept in SQLite as ui:snoozed. */
  snoozed: Record<string, number>
  snooze(key: string, until: number | null): void
  setPane(p: PaneState): void
  setPaneFull(v: boolean): void
  setPaneNote(n: string | null): void
  addOverlay(d: 1 | -1): void
  addOpened(p: { url: string; title: string }): void
  runPanel: boolean
  runGuard: { n: number; guard: DirtyGuard } | null
  runError: string | null
  setRunpr(r: RunPrSnapshot): void
  setRunPanel(open: boolean): void
  setRunGuard(g: { n: number; guard: DirtyGuard } | null): void
  setRunError(e: string | null): void
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

/** Session terminals kept mounted at once (see `mounted`). */
const MOUNTED_MAX = 5

export const useStore = create<State>((set, get) => ({
  sessions: [],
  view: loadView(),
  mounted: new Set(),
  status: { sessions: {}, usage: null },
  hooks: null,
  caf: null,
  paletteOpen: false,
  cafOpen: false,
  keysOpen: false,
  setKeysOpen: (keysOpen) => set({ keysOpen }),
  setCafOpen: (cafOpen) => set({ cafOpen }),
  local: null,
  git: null,
  tasks: null,
  wsPlace: loadWsPlace(),
  todayTab: loadTab(),
  peekTask: null,
  peekNeed: null,
  setPeekNeed: (peekNeed) => set({ peekNeed, draft: null }),
  focusPr: null,
  selPr: null,
  setSelPr: (selPr) => set({ selPr }),
  showTick: 0,
  draft: null,
  setLocal: (local) => set({ local }),
  setGit: (git) => set({ git }),
  runpr: null,
  pane: null,
  paneFull: false,
  taskSide: false,
  setTaskSide: (taskSide) => {
    set({ taskSide })
    void window.workbench.setSetting('ui:taskSide', taskSide)
  },
  paneNote: null,
  overlays: 0,
  openedPrs: [],
  snoozed: {},
  snooze: (key, until) => {
    const next = Object.fromEntries(Object.entries(get().snoozed).filter(([k, t]) => k !== key && t > Date.now()))
    if (until) next[key] = until
    set({ snoozed: next })
    void window.workbench.setSetting('ui:snoozed', next)
  },
  setPane: (pane) => set({ pane }),
  setPaneFull: (paneFull) => set({ paneFull }),
  setPaneNote: (paneNote) => set({ paneNote }),
  addOverlay: (d) => set({ overlays: Math.max(0, get().overlays + d) }),
  addOpened: (p) => set({ openedPrs: [p, ...get().openedPrs.filter((x) => x.url !== p.url)].slice(0, 8) }),
  runPanel: false,
  runGuard: null,
  runError: null,
  setRunpr: (runpr) => set({ runpr }),
  setRunPanel: (runPanel) => set({ runPanel }),
  setRunGuard: (runGuard) => set({ runGuard }),
  setRunError: (runError) => set({ runError }),
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
    const kept = [...mounted].filter((id) => ids.has(id))
    const next: Partial<State> = { sessions }
    if (kept.length !== mounted.size) next.mounted = new Set(kept)
    if (view.kind === 'session' && !ids.has(view.id)) next.view = { kind: 'today' }
    set(next)
    if (next.view) persist(next.view)
  },
  show: (view) => {
    let mounted = get().mounted
    if (view.kind === 'session') {
      const ids = [...mounted].filter((id) => id !== view.id)
      mounted = new Set([...ids.slice(-(MOUNTED_MAX - 1)), view.id])
    }
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
    return t === 'tasks' || t === 'git' || t === 'reviews' ? t : 'needs'
  } catch {
    return 'needs'
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

/** A PR link click: the GitHub pane for productiveio PRs, the browser for anything else. ⌘-click always opens the browser. */
export function openPrLink(url: string, external: boolean): void {
  if (external || !/^https:\/\/github\.com\/productiveio\//.test(url)) return void window.workbench.openExternal(url)
  openInPane(url)
}

/** Counts an overlay while `open`, so the GitHub pane (a native view drawn above the page) steps aside. */
export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return
    useStore.getState().addOverlay(1)
    return () => useStore.getState().addOverlay(-1)
  }, [open])
}

/**
 * Opens a GitHub URL in the pane: Today › My git (or My reviews for a review request) with the PR selected.
 * PRs in neither list go to a temporary "Opened" group.
 */
export function openInPane(url: string): void {
  const st = useStore.getState()
  const key = prKey(url)
  const mine = key ? st.git?.mine.find((p) => p.url === key) : undefined
  const review = key ? st.git?.reviews.find((p) => p.url === key) : undefined
  st.show({ kind: 'today' })
  st.setTodayTab(review && !mine ? 'reviews' : 'git')
  st.setDraft(null)
  st.setPaneNote(null)
  if (mine ?? review) st.setSelPr((mine ?? review)!.id)
  else if (key) {
    st.addOpened({ url: key, title: url })
    st.setSelPr(key)
  }
  void window.workbench.pane.open(url)
}
