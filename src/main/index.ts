import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/types'
import { Sessions } from './sessions'
import { shellEnv } from './shell-env'
import { openDb } from './store/db'
import { Repo } from './store/repo'

let win: BrowserWindow | null = null

const repo = () => new Repo(openDb(join(app.getPath('userData'), 'workbench.db')))

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#0E0D12',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  })
  w.once('ready-to-show', () => w.show())
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return w
}

function send(cmd: MenuCommand): void {
  win?.webContents.send('menu', cmd)
}

function buildMenu(): void {
  const tabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => send({ type: 'select-tab', index: i }),
  }))
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Session',
        submenu: [
          { label: 'New Session', accelerator: 'CmdOrCtrl+T', click: () => send({ type: 'new-session' }) },
          { label: 'New Session in Folder…', accelerator: 'CmdOrCtrl+Shift+T', click: () => send({ type: 'new-session-in' }) },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send({ type: 'close-tab' }) },
          { type: 'separator' },
          { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: () => send({ type: 'cycle-tab', delta: 1 }) },
          { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: () => send({ type: 'cycle-tab', delta: -1 }) },
          { type: 'separator' },
          ...tabs,
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  )
}

void app.whenReady().then(() => {
  void shellEnv() // warm up; the first session would otherwise wait on it
  const sessions = new Sessions(repo(), () => win?.webContents.send('sessions:changed', sessions.list()))

  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:create', async (_e, opts?: { cwd?: string; pick?: boolean }) => {
    let cwd = opts?.cwd
    if (opts?.pick) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      cwd = r.filePaths[0]
    }
    return sessions.create(cwd)
  })
  ipcMain.handle('sessions:open', (e, id: string, size: { cols: number; rows: number }) => sessions.open(id, size, e.sender))
  ipcMain.handle('sessions:close', (_e, id: string) => sessions.close(id))
  ipcMain.handle('sessions:title', (_e, id: string, title: string) => sessions.setTitle(id, title))
  ipcMain.handle('sessions:reorder', (_e, ids: string[]) => sessions.reorder(ids))

  app.on('before-quit', () => sessions.shutdown())

  buildMenu()
  win = createWindow()
  win.on('closed', () => (win = null))
})

app.on('window-all-closed', () => app.quit())
