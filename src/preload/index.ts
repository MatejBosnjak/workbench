import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GitSnapshot } from '@shared/git'
import type { LocalSnapshot } from '@shared/local'
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
  setTitle: (id, title) => ipcRenderer.invoke('sessions:title', id, title),
  reorderSessions: (ids) => ipcRenderer.invoke('sessions:reorder', ids),
  onSessionsChanged: (cb) => on('sessions:changed', (_e, sessions: Session[]) => cb(sessions)),
  onMenuCommand: (cb) => on('menu', (_e, cmd: MenuCommand) => cb(cmd)),
  writeSession: (id, data) => ipcRenderer.invoke('sessions:write', id, data),
  configureSession: (id, change) => ipcRenderer.invoke('sessions:configure', id, change),
  getDefaults: () => ipcRenderer.invoke('defaults:get'),
  setDefaults: (d) => ipcRenderer.invoke('defaults:set', d),
  recentSessions: () => ipcRenderer.invoke('sessions:recent'),
  reopenSession: (id) => ipcRenderer.invoke('sessions:reopen', id),
  takeOver: (id) => ipcRenderer.invoke('sessions:takeover', id),
  cancelTakeOver: (id) => ipcRenderer.invoke('sessions:takeover-cancel', id),
  getCaffeinate: () => ipcRenderer.invoke('caf:get'),
  setCaffeinate: (mode, scope, sessionId) => ipcRenderer.invoke('caf:set', mode, scope, sessionId),
  onCaffeinate: (cb) => on('caf:changed', (_e, s: CaffeinateState) => cb(s)),
  prInfo: (url) => ipcRenderer.invoke('gh:pr', url),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  tasks: {
    snapshot: () => ipcRenderer.invoke('tasks:snapshot'),
    onChanged: (cb) => on('tasks:changed', (_e, s: TasksSnapshot) => cb(s)),
    refresh: () => ipcRenderer.invoke('tasks:refresh'),
    start: (taskId) => ipcRenderer.invoke('tasks:start', taskId),
    link: (sessionId, taskId) => ipcRenderer.invoke('tasks:link', sessionId, taskId),
    unlink: (sessionId, taskId) => ipcRenderer.invoke('tasks:unlink', sessionId, taskId),
    summarize: (taskId) => ipcRenderer.invoke('tasks:summarize', taskId),
  },
  git: {
    snapshot: () => ipcRenderer.invoke('git:snapshot'),
    onChanged: (cb) => on('git:changed', (_e, s: GitSnapshot) => cb(s)),
    refresh: () => ipcRenderer.invoke('git:refresh'),
    markSeen: (key, messageId) => ipcRenderer.invoke('git:seen', key, messageId),
    openDraft: (target) => ipcRenderer.invoke('drafts:open', target),
    generate: (target, instruction) => ipcRenderer.invoke('drafts:generate', target, instruction),
    saveDraft: (id, body) => ipcRenderer.invoke('drafts:save', id, body),
    discardDraft: (id) => ipcRenderer.invoke('drafts:discard', id),
    send: (id, body) => ipcRenderer.invoke('drafts:send', id, body),
  },
  onNavigate: (cb) => on('navigate', (_e, t: NavigateTarget) => cb(t)),
  reportView: (sessionId) => ipcRenderer.send('ui:view', sessionId),
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
