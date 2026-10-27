import { create } from 'zustand'
import type { DraftTarget, GitSnapshot } from '@shared/git'
import type { LocalSnapshot } from '@shared/local'
import type { TasksSnapshot } from '@shared/tasks'
import type { DirtyGuard, RunPrSnapshot, RunTarget } from '@shared/runpr'
import type { PaneState } from '@shared/pane'
import { prKey } from '@shared/pane'
import { useEffect } from 'react'
import { rootOf } from '@shared/workstream'
import type { CaffeinateState, HeldNote, HooksStatus, NavigateTarget, Session, StatusSnapshot } from '@shared/types'
import { isTheme, type ThemeId } from '@shared/theme'

export type SessionSide = 'task' | 'pr' | null

export type View = { kind: 'today' } | { kind: 'local' } | { kind: 'session'; id: string } | { kind: 'workstream'; id: string }
export type TodayTab = 'needs' | 'tasks' | 'git' | 'reviews'

const LAST_VIEW = 'workbench.lastView'
const THEME_KEY = 'workbench.theme'

/** The theme as last applied, from localStorage so the first paint already has it; ui:theme in SQLite is the record. */
function loadTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return isTheme(t) ? t : 'dusk'
  } catch {
    return 'dusk'
  }
}

/** Sets data-theme on <html>, which switches the tokens and theme rules in themes.css. */
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // the setting still has it
  }
}

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
  /** Each session's sidebar beside its terminal: its task (⌘I) or its PR (⌘⇧I); none until opened. Kept as ui:sessionSides. */
  sessionSides: Record<string, Exclude<SessionSide, null>>
  /** The app's look (see THEMES). Kept as ui:theme. */
  theme: ThemeId
  /** Applies the theme everywhere at once (terminals too) and saves it. */
  setTheme(theme: ThemeId): void
  /** Completed to-dos hidden in the task sidebar, for every task. Kept as ui:hideDoneTodos. */
  hideDoneTodos: boolean
  setHideDoneTodos(on: boolean): void
  /** Opens or closes the sidebar of the session on screen. */
  setSessionSide(side: SessionSide): void
  /** Toggles one sidebar of the session on screen: opens it, or closes it when it's the one open. */
  toggleSessionSide(side: Exclude<SessionSide, null>): void
  /** Each sidebar's width in px once dragged; unset means its default. Kept as ui:sideWidths. */
  sideWidths: Partial<Record<Exclude<SessionSide, null>, number>>
  /** `save` writes it to settings (at the end of a drag); null goes back to the default. */
  setSideWidth(side: Exclude<SessionSide, null>, px: number | null, save: boolean): void
  /** A line under the pane's strip, e.g. what happened to a Claude draft. */
  paneNote: string | null
  /** Open overlays (palette, popovers, modals); the native pane hides behind a still while any is open. */
  overlays: number
  /** Focus (⌘F): the screen on view stays; everything pointing elsewhere goes quiet and its notifications are held. */
  focus: boolean
  /** Notifications held while focused. */
  held: number
  /** What was held, shown once focus ends; null when there's nothing to show. */
  digest: HeldNote[] | null
  toggleFocus(): Promise<void>
  setDigest(d: HeldNote[] | null): void
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
  runGuard: { n: number; guard: DirtyGuard; target: RunTarget } | null
  runError: string | null
  setRunpr(r: RunPrSnapshot): void
  setRunPanel(open: boolean): void
  setRunGuard(g: { n: number; guard: DirtyGuard; target: RunTarget } | null): void
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
  sessionSides: {},
  theme: loadTheme(),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
    void window.workbench.setSetting('ui:theme', theme)
  },
  hideDoneTodos: false,
  setHideDoneTodos: (hideDoneTodos) => {
    set({ hideDoneTodos })
    void window.workbench.setSetting('ui:hideDoneTodos', hideDoneTodos)
  },
  setSessionSide: (side) => {
    const id = activeSessionId(get().view)
    if (!id) return
    const sessionSides = { ...get().sessionSides }
    if (side) sessionSides[id] = side
    else delete sessionSides[id]
    // Only open sessions are worth remembering.
    const open = new Set(get().sessions.map((s) => s.id))
    for (const k of Object.keys(sessionSides)) if (!open.has(k)) delete sessionSides[k]
    set({ sessionSides })
    void window.workbench.setSetting('ui:sessionSides', sessionSides)
  },
  toggleSessionSide: (side) => {
    const id = activeSessionId(get().view)
    if (id) get().setSessionSide(get().sessionSides[id] === side ? null : side)
  },
  sideWidths: {},
  setSideWidth: (side, px, save) => {
    const sideWidths = { ...get().sideWidths }
    if (px === null) delete sideWidths[side]
    else sideWidths[side] = Math.round(px)
    set({ sideWidths })
    if (save) void window.workbench.setSetting('ui:sideWidths', sideWidths)
  },
  paneNote: null,
  overlays: 0,
  focus: false,
  held: 0,
  digest: null,
  toggleFocus: async () => {
    const on = !get().focus
    set({ focus: on, digest: null })
    const held = await window.workbench.setFocus(on)
    if (!on && held.length) set({ digest: held })
  },
  setDigest: (digest) => set({ digest }),
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
