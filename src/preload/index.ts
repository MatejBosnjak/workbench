import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { SESSION_PORT_MESSAGE, type CaffeinateState, type HooksStatus, type MenuCommand, type Session, type StatusSnapshot, type WorkbenchApi } from '@shared/types'

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
