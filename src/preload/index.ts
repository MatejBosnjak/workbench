import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GitSnapshot } from '@shared/git'
import type { LocalSnapshot } from '@shared/local'
import type { Workstream } from '@shared/workstream'
import type { RunPrSnapshot } from '@shared/runpr'
import type { MemorySnapshot } from '@shared/memory'
import type { PaneState } from '@shared/pane'
import type { TasksSnapshot } from '@shared/tasks'
import { SESSION_PORT_MESSAGE, type CaffeinateState, type HooksStatus, type MenuCommand, type NavigateTarget, type Session, type StatusSnapshot, type WorkbenchApi } from '@shared/types'

function on<A extends unknown[]>(channel: string, handler: (e: IpcRendererEvent, ...args: A) => void): () => void {
  const fn = handler as (e: IpcRendererEvent, ...args: unknown[]) => void
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.off(channel, fn)
}

const api: WorkbenchApi = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  openSession: (id, size) => ipcRenderer.invoke('sessions:open', id, size),
  closeSession: (id) => ipcRenderer.invoke('sessions:close', id),
  tabMenu: (id, enabled) => ipcRenderer.invoke('sessions:tab-menu', id, enabled),
  setTitle: (id, title, auto) => ipcRenderer.invoke('sessions:title', id, title, auto),
  reorderSessions: (ids) => ipcRenderer.invoke('sessions:reorder', ids),
  onSessionsChanged: (cb) => on('sessions:changed', (_e, sessions: Session[]) => cb(sessions)),
  onMenuCommand: (cb) => on('menu', (_e, cmd: MenuCommand) => cb(cmd)),
  writeSession: (id, data) => ipcRenderer.invoke('sessions:write', id, data),
  configureSession: (id, change) => ipcRenderer.invoke('sessions:configure', id, change),
  getDefaults: () => ipcRenderer.invoke('defaults:get'),
  setDefaults: (d) => ipcRenderer.invoke('defaults:set', d),
  resolvedDefaults: () => ipcRenderer.invoke('defaults:resolved'),
  recentSessions: () => ipcRenderer.invoke('sessions:recent'),
  sessionMarks: (id) => ipcRenderer.invoke('sessions:marks', id),
  reopenSession: (id) => ipcRenderer.invoke('sessions:reopen', id),
  takeOver: (id) => ipcRenderer.invoke('sessions:takeover', id),
  cancelTakeOver: (id) => ipcRenderer.invoke('sessions:takeover-cancel', id),
  getCaffeinate: () => ipcRenderer.invoke('caf:get'),
  setCaffeinate: (sessionId, mode, until) => ipcRenderer.invoke('caf:set', sessionId, mode, until),
  setCaffeinateAuto: (on) => ipcRenderer.invoke('caf:auto', on),
  onCaffeinate: (cb) => on('caf:changed', (_e, s: CaffeinateState) => cb(s)),
  prInfo: (url) => ipcRenderer.invoke('gh:pr', url),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  suggest: { answer: (id, answer) => ipcRenderer.invoke('suggest:answer', id, answer) },
  tasks: {
    snapshot: () => ipcRenderer.invoke('tasks:snapshot'),
    onChanged: (cb) => on('tasks:changed', (_e, s: TasksSnapshot) => cb(s)),
    refresh: () => ipcRenderer.invoke('tasks:refresh'),
    start: (taskId) => ipcRenderer.invoke('tasks:start', taskId),
    startForPr: (pr) => ipcRenderer.invoke('tasks:start-for-pr', pr),
    link: (sessionId, taskId) => ipcRenderer.invoke('tasks:link', sessionId, taskId),
    unlink: (sessionId, taskId) => ipcRenderer.invoke('tasks:unlink', sessionId, taskId),
    unlinkPr: (sessionId, url) => ipcRenderer.invoke('tasks:unlinkPr', sessionId, url),
    summarize: (taskId) => ipcRenderer.invoke('tasks:summarize', taskId),
    detail: (taskId) => ipcRenderer.invoke('tasks:detail', taskId),
    setStatus: (taskId, statusId) => ipcRenderer.invoke('tasks:setStatus', taskId, statusId),
    setTodo: (taskId, todoId, closed) => ipcRenderer.invoke('tasks:setTodo', taskId, todoId, closed),
    assignTodo: (taskId, todoId, personId) => ipcRenderer.invoke('tasks:assignTodo', taskId, todoId, personId),
    addTodo: (taskId, text, assignee) => ipcRenderer.invoke('tasks:addTodo', taskId, text, assignee),
    people: () => ipcRenderer.invoke('tasks:people'),
    comment: (taskId, text, tagged) => ipcRenderer.invoke('tasks:comment', taskId, text, tagged),
  },
  git: {
    snapshot: () => ipcRenderer.invoke('git:snapshot'),
    onChanged: (cb) => on('git:changed', (_e, s: GitSnapshot) => cb(s)),
    refresh: () => ipcRenderer.invoke('git:refresh'),
    markSeen: (key, messageId) => ipcRenderer.invoke('git:seen', key, messageId),
    openDraft: (target) => ipcRenderer.invoke('drafts:open', target),
    compose: (target, instruction) => ipcRenderer.invoke('drafts:compose', target, instruction),
    generate: (target, instruction) => ipcRenderer.invoke('drafts:generate', target, instruction),
    saveDraft: (id, body) => ipcRenderer.invoke('drafts:save', id, body),
    discardDraft: (id) => ipcRenderer.invoke('drafts:discard', id),
    send: (id, body) => ipcRenderer.invoke('drafts:send', id, body),
  },
  ws: {
    open: (rootId) => ipcRenderer.invoke('ws:open', rootId),
    refresh: (rootId) => ipcRenderer.invoke('ws:refresh', rootId),
    onChanged: (cb) => on('ws:changed', (_e, ws: Workstream) => cb(ws)),
    setNote: (rootId, body) => ipcRenderer.invoke('ws:note', rootId, body),
    repos: () => ipcRenderer.invoke('ws:repos'),
    start: (taskId, repo) => ipcRenderer.invoke('ws:start', taskId, repo),
  },
  pane: {
    open: (url) => ipcRenderer.invoke('pane:open', url),
    bounds: (b) => ipcRenderer.invoke('pane:bounds', b),
    visible: (v) => ipcRenderer.invoke('pane:visible', v),
    close: () => ipcRenderer.invoke('pane:close'),
    nav: (cmd) => ipcRenderer.invoke('pane:nav', cmd),
    capture: () => ipcRenderer.invoke('pane:capture'),
    state: () => ipcRenderer.invoke('pane:state'),
    fill: (url, text) => ipcRenderer.invoke('pane:fill', url, text),
    closeIdle: () => ipcRenderer.invoke('pane:close-idle'),
    onChanged: (cb) => on('pane:changed', (_e, s: PaneState) => cb(s)),
    onList: (cb) => on('pane:key', (_e, k: string) => k === 'list' && cb()),
  },
  memory: {
    snapshot: () => ipcRenderer.invoke('memory:snapshot'),
    watch: (on) => ipcRenderer.invoke('memory:watch', on),
    onChanged: (cb) => on('memory:changed', (_e, s: MemorySnapshot) => cb(s)),
  },
  runpr: {
    snapshot: () => ipcRenderer.invoke('runpr:snapshot'),
    onChanged: (cb) => on('runpr:changed', (_e, s: RunPrSnapshot) => cb(s)),
    guard: (n) => ipcRenderer.invoke('runpr:guard', n),
    run: (n, opts) => ipcRenderer.invoke('runpr:run', n, opts ?? {}),
    cancel: () => ipcRenderer.invoke('runpr:cancel'),
    back: () => ipcRenderer.invoke('runpr:back'),
  },
  forkSession: (id) => ipcRenderer.invoke('sessions:fork', id),
  onNavigate: (cb) => on('navigate', (_e, t: NavigateTarget) => cb(t)),
  reportView: (sessionId) => ipcRenderer.send('ui:view', sessionId),
  setFocus: (on) => ipcRenderer.invoke('focus:set', on),
  onHeld: (cb) => on('focus:held', (_e, n: number) => cb(n)),
  local: {
    snapshot: () => ipcRenderer.invoke('local:snapshot'),
    onChanged: (cb) => on('local:changed', (_e, s: LocalSnapshot) => cb(s)),
    onPaneExit: (cb) => on('local:pane-exit', (_e, id: string) => cb(id)),
    setProfile: (id) => ipcRenderer.invoke('local:profile', id),
    start: (name) => ipcRenderer.invoke('local:start', name),
    stop: (name) => ipcRenderer.invoke('local:stop', name),
    restart: (name) => ipcRenderer.invoke('local:restart', name),
    stopAll: () => ipcRenderer.invoke('local:stop-all'),
    startMissing: (profile) => ipcRenderer.invoke('local:start-missing', profile),
    openPane: (id, size) => ipcRenderer.invoke('local:open-pane', id, size),
    closePane: (id) => ipcRenderer.invoke('local:close-pane', id),
    worktrees: (name) => ipcRenderer.invoke('local:worktrees', name),
    switchWorktree: (name, path, run) => ipcRenderer.invoke('local:switch', name, path, run),
    branches: (name) => ipcRenderer.invoke('local:branches', name),
    checkoutBranch: (name, branch, run) => ipcRenderer.invoke('local:checkout', name, branch, run),
    runAlongside: (name, path) => ipcRenderer.invoke('local:alongside', name, path),
    removeWorktree: (path) => ipcRenderer.invoke('local:remove-worktree', path),
    startInfra: (name) => ipcRenderer.invoke('local:infra-start', name),
    refreshInfra: () => ipcRenderer.invoke('local:infra-refresh'),
  },
  openInEditor: (path) => ipcRenderer.invoke('editor:open', path),
  getSetting: (key, fallback) => ipcRenderer.invoke('settings:get', key, fallback),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  getStatus: () => ipcRenderer.invoke('status:get'),
  onStatus: (cb) => on('status:changed', (_e, s: StatusSnapshot) => cb(s)),
  hooksStatus: () => ipcRenderer.invoke('hooks:status'),
  onHooksChanged: (cb) => on('hooks:changed', (_e, s: HooksStatus) => cb(s)),
  installHooks: () => ipcRenderer.invoke('hooks:install'),
  uninstallHooks: () => ipcRenderer.invoke('hooks:uninstall'),
}

// MessagePorts can't cross contextBridge; hand them to the page with window.postMessage (see renderer ports.ts).
ipcRenderer.on('session:port', (e, id: string) => {
  window.postMessage({ type: SESSION_PORT_MESSAGE, id }, '*', e.ports)
})

contextBridge.exposeInMainWorld('workbench', api)
