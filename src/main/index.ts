import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { HooksStatus, MenuCommand } from '@shared/types'
import { currentStatus, HOOK_EVENTS, install, readSettings, uninstall, writeScripts, type InstallPaths } from './hooks-install'
import { Sessions } from './sessions'
import { shellEnv } from './shell-env'
import { startSignalServer, stopSignalServer } from './signal-server'
import { openDb } from './store/db'
import { Repo } from './store/repo'

app.setName('Workbench')

let win: BrowserWindow | null = null

const dataDir = () => app.getPath('userData')
const socketPath = () => process.env.WORKBENCH_SOCKET ?? join(dataDir(), 'signal.sock')
const installPaths = (): InstallPaths => ({
  // Overridable so development and tests never touch the real file.
  settings: process.env.WORKBENCH_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json'),
  binDir: join(dataDir(), 'bin'),
  dataDir: dataDir(),
  socket: socketPath(),
  templates: app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'resources', 'bin'),
})

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

async function confirmInstall(): Promise<HooksStatus> {
  const p = installPaths()
  const before = readSettings(p.settings)
  const res = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Install Workbench hooks?',
    detail: [
      `This edits ${p.settings}. A backup is saved next to it first.`,
      '',
      `• Adds a hook for ${HOOK_EVENTS.join(', ')}. It does nothing when Workbench isn't running.`,
      `• Wraps your statusline so Workbench gets context and usage numbers. Your current command still runs and prints as before:`,
      `  ${before.statusLine?.command ?? '(none)'}`,
      '',
      'Only entries marked "# workbench" are added; Uninstall removes exactly those.',
    ].join('\n'),
  })
  if (res.response !== 0) return currentStatus(p)
  const backup = install(p)
  void dialog.showMessageBox(win!, { message: 'Hooks installed', detail: backup ? `Backup: ${backup}` : 'There was no settings file to back up.' })
  return currentStatus(p)
}

async function confirmUninstall(): Promise<HooksStatus> {
  const p = installPaths()
  const res = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Uninstall Workbench hooks?',
    detail: `Removes the "# workbench" entries from ${p.settings} and restores your original statusline. A backup is saved first.`,
  })
  if (res.response !== 0) return currentStatus(p)
  const backup = uninstall(p)
  void dialog.showMessageBox(win!, { message: 'Hooks uninstalled', detail: backup ? `Backup: ${backup}` : '' })
  return currentStatus(p)
}

function buildMenu(): void {
  const tabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => send({ type: 'select-tab', index: i }),
  }))
  const hooksChanged = (s: HooksStatus) => win?.webContents.send('hooks:changed', s)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Install Hooks…', click: () => void confirmInstall().then(hooksChanged) },
          { label: 'Uninstall Hooks…', click: () => void confirmUninstall().then(hooksChanged) },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
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
  const sessions = new Sessions(new Repo(openDb(join(dataDir(), 'workbench.db'))), {
    sessionsChanged: () => win?.webContents.send('sessions:changed', sessions.list()),
    statusChanged: () => win?.webContents.send('status:changed', sessions.statusSnapshot()),
  })

  const signals = startSignalServer(socketPath(), (sig) => sessions.handleSignal(sig))
  // Keep installed client scripts in step with this build.
  if (currentStatus(installPaths()).hooks) writeScripts(installPaths())

  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:create', async (_e, opts?: { cwd?: string; pick?: boolean }) => {
    let cwd = opts?.cwd
    if (opts?.pick) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      cwd = r.filePaths[0]
    }
    return sessions.create({ cwd })
  })
  ipcMain.handle('sessions:open', (e, id: string, size: { cols: number; rows: number }) => sessions.open(id, size, e.sender))
  ipcMain.handle('sessions:close', (_e, id: string) => sessions.close(id))
  ipcMain.handle('sessions:title', (_e, id: string, title: string) => sessions.setTitle(id, title))
  ipcMain.handle('sessions:reorder', (_e, ids: string[]) => sessions.reorder(ids))
  ipcMain.handle('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.handle('status:get', () => sessions.statusSnapshot())
  ipcMain.handle('hooks:status', () => currentStatus(installPaths()))
  const hooksChanged = (s: HooksStatus) => (win?.webContents.send('hooks:changed', s), s)
  ipcMain.handle('hooks:install', () => confirmInstall().then(hooksChanged))
  ipcMain.handle('hooks:uninstall', () => confirmUninstall().then(hooksChanged))

  app.on('before-quit', () => {
    sessions.shutdown()
    stopSignalServer(signals, socketPath())
  })

  buildMenu()
  win = createWindow()
  win.on('closed', () => (win = null))
})

app.on('window-all-closed', () => app.quit())
