import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { AgentSettings } from '@shared/agent'
import type { HooksStatus, MenuCommand } from '@shared/types'
import { Caffeinate } from './caffeinate'
import { prInfo } from './github'
import { currentStatus, HOOK_EVENTS, install, readSettings, uninstall, writeScripts, type InstallPaths } from './hooks-install'
import { loadConfig } from './local/config'
import { Supervisor } from './local/supervisor'
import { Linker } from './linker'
import { TasksPoller } from './productive/tasks'
import { Sessions } from './sessions'
import { shellEnv, which } from './shell-env'
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

const BACKGROUND = process.env.WORKBENCH_BACKGROUND === '1'

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
  // Test runs open the window behind whatever has focus.
  w.once('ready-to-show', () => (BACKGROUND ? w.showInactive() : w.show()))
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
          { label: 'Switch or Run…', accelerator: 'CmdOrCtrl+K', click: () => send({ type: 'palette' }) },
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
  if (BACKGROUND) app.setActivationPolicy('accessory')
  void shellEnv() // warm up; the first session would otherwise wait on it
  const caffeinate = new Caffeinate((s) => win?.webContents.send('caf:changed', s))
  const repo = new Repo(openDb(join(dataDir(), 'workbench.db')))
  const local = new Supervisor(
    loadConfig(join(dataDir(), 'services.json')),
    repo,
    () => win?.webContents,
    (s) => win?.webContents.send('local:changed', s),
    (id) => win?.webContents.send('local:pane-exit', id),
  )
  const sessions = new Sessions(repo, {
    sessionsChanged: () => {
      const list = sessions.list()
      caffeinate.sessionsChanged(list)
      win?.webContents.send('sessions:changed', list)
    },
    statusChanged: () => win?.webContents.send('status:changed', sessions.statusSnapshot()),
    hook: (id, event, payload) => void linker.onHook(id, event, payload),
  })
  const tasksChanged = () => win?.webContents.send('tasks:changed', linker.snapshot())
  let hadTasks = false
  const tasks = new TasksPoller(repo, () => {
    tasksChanged()
    // Sessions opened before the list loaded get their cwd/branch checked once it has.
    if (!hadTasks && tasks.fetchedAt && !tasks.loading) {
      hadTasks = true
      void linker.inferAll()
    }
  })
  const linker = new Linker(repo, tasks, sessions, tasksChanged, dataDir())
  tasks.start()

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
  ipcMain.handle('sessions:configure', (_e, id: string, change: Partial<AgentSettings>) => sessions.configure(id, change))
  ipcMain.handle('defaults:get', () => sessions.defaults())
  ipcMain.handle('defaults:set', (_e, d: AgentSettings) => sessions.setDefaults(d))
  ipcMain.handle('sessions:recent', () => sessions.recent())
  ipcMain.handle('sessions:reopen', (_e, id: string) => sessions.reopen(id))
  ipcMain.handle('sessions:takeover', (_e, id: string) => sessions.takeOver(id))
  ipcMain.handle('sessions:takeover-cancel', (_e, id: string) => sessions.cancelTakeOver(id))
  ipcMain.handle('caf:get', () => caffeinate.get())
  ipcMain.handle('caf:set', (_e, mode, scope, sessionId: string | null) => caffeinate.set(mode, scope, sessionId))
  ipcMain.handle('gh:pr', (_e, url: string) => prInfo(url))
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('tasks:snapshot', () => linker.snapshot())
  ipcMain.handle('tasks:refresh', () => tasks.refresh())
  ipcMain.handle('tasks:start', (_e, taskId: string) => {
    const task = tasks.tasks.find((t) => t.id === taskId)
    const s = sessions.create({ cwd: linker.worktreeFor(taskId) ?? undefined })
    if (task) sessions.setTitle(s.id, task.title)
    linker.link(s.id, taskId, 'started from this task', 'manual')
    return sessions.get(s.id)
  })
  ipcMain.handle('tasks:link', (_e, sessionId: string, taskId: string) => linker.link(sessionId, taskId, 'linked by hand', 'manual'))
  ipcMain.handle('tasks:unlink', (_e, sessionId: string, taskId: string) => linker.unlink(sessionId, taskId))
  ipcMain.handle('tasks:summarize', (_e, taskId: string) => linker.summarize(taskId))
  ipcMain.handle('local:snapshot', () => local.snapshot())
  ipcMain.handle('local:profile', (_e, id: string) => local.setProfile(id))
  ipcMain.handle('local:start', (_e, name: string) => local.start(name))
  ipcMain.handle('local:stop', (_e, name: string) => local.stop(name))
  ipcMain.handle('local:restart', (_e, name: string) => local.restart(name))
  ipcMain.handle('local:stop-all', () => local.stopAll())
  ipcMain.handle('local:start-missing', (_e, profile: string) => local.startMissing(profile))
  ipcMain.handle('local:open-pane', (e, id: string, size: { cols: number; rows: number }) => local.openPane(id, size, e.sender))
  ipcMain.handle('local:close-pane', (_e, id: string) => local.closePane(id))
  ipcMain.handle('local:worktrees', (_e, name: string) => local.worktrees(name))
  ipcMain.handle('local:switch', (_e, name: string, path: string, run: boolean) => local.switchWorktree(name, path, run))
  ipcMain.handle('local:alongside', (_e, name: string, path: string) => local.runAlongside(name, path))
  ipcMain.handle('local:infra-start', (_e, name: string) => local.startInfra(name))
  ipcMain.handle('local:infra-refresh', () => local.refreshInfra())
  ipcMain.handle('local:remove-worktree', async (_e, path: string) => {
    const res = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Remove this worktree?',
      detail: `${path}\n\nRuns git worktree remove (no --force): git refuses if there are uncommitted or untracked changes. The branch is kept.`,
    })
    return res.response === 0 ? ((await local.removeWorktree(path)) ?? 'removed') : 'cancelled'
  })
  ipcMain.handle('editor:open', async (_e, path: string) => {
    const env = await shellEnv()
    const code = which('code', env)
    if (code) execFile(code, [path], { env })
    else void shell.openPath(path)
  })
  ipcMain.handle('settings:get', (_e, key: string, fallback: unknown) => (key.startsWith('ui:') ? repo.getSetting(key, fallback) : fallback))
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
    if (key.startsWith('ui:')) repo.setSetting(key, value)
  })
  ipcMain.handle('status:get', () => sessions.statusSnapshot())
  ipcMain.handle('hooks:status', () => currentStatus(installPaths()))
  const hooksChanged = (s: HooksStatus) => (win?.webContents.send('hooks:changed', s), s)
  ipcMain.handle('hooks:install', () => confirmInstall().then(hooksChanged))
  ipcMain.handle('hooks:uninstall', () => confirmUninstall().then(hooksChanged))

  let quitting = false
  app.on('before-quit', (e) => {
    tasks.stop()
    const running = local.running()
    if (!quitting && running.length) {
      e.preventDefault()
      const answer = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Stop and Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Stop ${running.length} local service${running.length > 1 ? 's' : ''} and quit?`,
        detail: running.map((s) => s.name).join(', '),
      })
      if (answer !== 0) return
      quitting = true
      void local.stopAll().finally(() => app.quit())
      return
    }
    caffeinate.stop()
    sessions.shutdown()
    local.dispose()
    stopSignalServer(signals, socketPath())
  })

  buildMenu()
  win = createWindow()
  win.on('closed', () => (win = null))
})

app.on('window-all-closed', () => app.quit())
