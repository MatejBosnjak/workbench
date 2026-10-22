import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { SESSION_PORT_MESSAGE, type MenuCommand, type Session, type WorkbenchApi } from '@shared/types'

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
}

// MessagePorts can't cross contextBridge; hand them to the page with window.postMessage (see renderer ports.ts).
ipcRenderer.on('session:port', (e, id: string) => {
  window.postMessage({ type: SESSION_PORT_MESSAGE, id }, '*', e.ports)
})

contextBridge.exposeInMainWorld('workbench', api)
