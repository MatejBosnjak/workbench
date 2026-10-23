import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { AgentSettings } from '@shared/agent'
import type { DraftTarget, GitSnapshot } from '@shared/git'
import type { Person } from '@shared/tasks'
import type { HooksStatus, MenuCommand, NavigateTarget } from '@shared/types'
import { Caffeinate } from './caffeinate'
import { headlessPids, killHeadless } from './claude'
import { MemoryMonitor } from './memory'
import { Drafts } from './drafts'
import { prInfo } from './github'
import { GitPoller } from './github/poller'
import { GitHubPane } from './github/pane'
import { currentStatus, HOOK_EVENTS, install, readSettings, uninstall, writeScripts, type InstallPaths } from './hooks-install'
import { loadConfig } from './local/config'
import { Supervisor } from './local/supervisor'
import { Linker } from './linker'
import { createWorktree, planWorktree, repoRoots } from './local/git'
import { Notifier } from './notify'
import { FocusTracker } from './focus-pr'
import { RunPr } from './local/run-pr'
import { TasksPoller } from './productive/tasks'
import { Sessions } from './sessions'
import { shellEnv, which } from './shell-env'
import { startSignalServer, stopSignalServer } from './signal-server'
import { openDb } from './store/db'
import { Repo } from './store/repo'
import { Workstreams } from './workstreams'
import { slug } from '@shared/workstream'

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
    trafficLightPosition: { x: 16, y: 21 },
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

let paneRef: GitHubPane | null = null

async function confirmGithubSignOut(): Promise<void> {
  if (!win || !paneRef) return
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Sign Out', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Sign out of GitHub in Workbench?',
    detail: 'Clears the GitHub pane\'s login and cookies. Your browser and the gh CLI are not affected.',
  })
  if (res.response === 0) await paneRef.signOut()
}

function buildMenu(): void {
  const tabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 0 ? 'Today' : i === 1 ? 'Local' : i === 8 ? 'Last Session' : `Tab ${i + 1}`,
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
          { label: 'Sign Out of GitHub…', click: () => void confirmGithubSignOut() },
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
          { label: 'Task Sidebar', accelerator: 'CmdOrCtrl+I', click: () => send({ type: 'task-side' }) },
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
  const repo = new Repo(openDb(join(dataDir(), 'workbench.db')))
  const caffeinate = new Caffeinate((s) => win?.webContents.send('caf:changed', s), {
    confirm: async (message, detail) =>
      (await dialog.showMessageBox(win!, { type: 'question', buttons: ['Replace', 'Keep it'], defaultId: 1, cancelId: 1, message, detail })).response === 0,
    owned: { get: () => repo.getSetting('caf:amphetamineOwned', false), set: (v) => repo.setSetting('caf:amphetamineOwned', v) },
  })
  const local = new Supervisor(
    loadConfig(join(dataDir(), 'services.json')),
    repo,
    () => win?.webContents,
    (s) => {
      win?.webContents.send('local:changed', s)
      refreshRunPr()
    },
    (id) => win?.webContents.send('local:pane-exit', id),
  )
  let lastStatus = ''
  const sessions = new Sessions(repo, {
    sessionsChanged: () => {
      const list = sessions.list()
      caffeinate.sessionsChanged(list)
      win?.webContents.send('sessions:changed', list)
    },
    statusChanged: () => {
      // Statusline ticks often repeat the last numbers; an unchanged snapshot isn't worth a renderer update.
      const snap = sessions.statusSnapshot()
      const json = JSON.stringify(snap)
      if (json === lastStatus) return
      lastStatus = json
      win?.webContents.send('status:changed', snap)
    },
    hook: (id, event, payload) => {
      void linker.onHook(id, event, payload)
      focus.onHook(id, event, payload)
      notifySession(id, event)
    },
    output: (id, data) => focus.onOutput(id, data),
  })
  // The session on screen; its own notifications are skipped while the window has focus.
  let viewedSession: string | null = null
  ipcMain.on('ui:view', (_e, id: string | null) => (viewedSession = id))
  const navigate = (t: NavigateTarget) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('navigate', t)
  }
  const notifier = new Notifier(repo, navigate)
  const notifySession = (id: string, event: string) => {
    if (event !== 'Notification' && event !== 'Stop') return
    if (win?.isFocused() && viewedSession === id) return
    const s = sessions.list().find((x) => x.id === id)
    if (s && !s.external) notifier.session(id, s.title, event === 'Notification' ? 'waiting' : 'finished')
  }
  const tasksChanged = () => {
    win?.webContents.send('tasks:changed', linker.snapshot())
    focus.refreshTasks()
  }
  let hadTasks = false
  const tasks = new TasksPoller(repo, () => {
    tasksChanged()
    // Sessions opened before the list loaded get their cwd/branch checked once it has.
    if (!hadTasks && tasks.fetchedAt && !tasks.loading) {
      hadTasks = true
      void linker.inferAll()
    }
  })
  const gitSnapshot = (): GitSnapshot => ({
    viewer: git.viewer,
    mine: git.mine,
    reviews: git.reviews,
    fetchedAt: git.fetchedAt,
    error: git.error,
    loading: git.loading,
    seen: repo.seen(),
    drafts: repo.drafts(),
  })
  const gitChanged = () => win?.webContents.send('git:changed', gitSnapshot())
  let gitSeenAt: number | null = null
  const git = new GitPoller(repo, () => {
    gitChanged()
    if (git.loading || git.error || !git.fetchedAt || git.fetchedAt === gitSeenAt) return
    gitSeenAt = git.fetchedAt
    notifier.git(gitSnapshot())
    void linker.inferAll()
    focus.refreshTasks()
    refreshRunPr()
  })
  const linker = new Linker(repo, tasks, git, sessions, tasksChanged, dataDir())
  const confirmPost = async (message: string, detail: string) =>
    (await dialog.showMessageBox(win!, { type: 'question', buttons: ['Post', 'Cancel'], defaultId: 1, cancelId: 1, message, detail })).response === 0
  const drafts = new Drafts(repo, git, tasks, linker, confirmPost, gitChanged, dataDir())
  // Run PR in app. Log lines arrive fast during a run; the renderer gets at most ten updates a second.
  let runprTimer: NodeJS.Timeout | null = null
  const runprChanged = () => {
    runprTimer ??= setTimeout(() => {
      runprTimer = null
      win?.webContents.send('runpr:changed', runpr.snapshot())
    }, 100)
  }
  let refreshTimer: NodeJS.Timeout | null = null
  function refreshRunPr() {
    refreshTimer ??= setTimeout(() => {
      refreshTimer = null
      void runpr?.refresh()
    }, 1000)
  }
  const focus = new FocusTracker(repo, sessions, git, runprChanged)
  const runpr = new RunPr(repo, local, git, focus, runprChanged)
  // GitHub inside Workbench (phase 8).
  const pane = new GitHubPane(() => win, {
    changed: (st) => win?.webContents.send('pane:changed', st),
    key: (k) => {
      if (typeof k === 'object') send({ type: 'select-tab', index: k.tab })
      else if (k === 'palette') send({ type: 'palette' })
      else if (k === 'list') {
        win?.webContents.focus()
        win?.webContents.send('pane:key', 'list')
      }
    },
    activity: () => git.refreshSoon(),
  })
  paneRef = pane
  const memory = new MemoryMonitor(
    {
      window: () => win?.webContents ?? null,
      sessions: () => sessions.processes(),
      local: () => local.processes(),
      pages: () => pane.views(),
      headless: headlessPids,
      sessionLabel: (id) => {
        const list = sessions.list()
        const i = list.findIndex((s) => s.id === id)
        return i < 0 ? null : `${i + 3} ${list[i]!.title}`
      },
    },
    (s) => win?.webContents.send('memory:changed', s),
  )
  memory.start()
  const workstreams = new Workstreams(repo, tasks, git, linker, (ws) => win?.webContents.send('ws:changed', ws))
  tasks.start()
  git.start()

  /** A new tab for a task, linked to it, titled after it. */
  const startForTask = (taskId: string, cwd: string | undefined, title?: string) => {
    const task = tasks.tasks.find((t) => t.id === taskId)
    const s = sessions.create({ cwd })
    if (task ?? title) sessions.setTitle(s.id, task?.title ?? title!)
    linker.link(s.id, taskId, 'started from this task', 'manual')
    // The prompt starts with the task, ready to send or extend.
    const url = task?.url ?? workstreams.url(taskId)
    if (url) sessions.prefillPrompt(s.id, `lets look at this task ${url} `)
    return sessions.get(s.id)
  }

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
  ipcMain.handle('defaults:resolved', () => sessions.resolvedDefaults())
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
  ipcMain.handle('tasks:start', (_e, taskId: string) => startForTask(taskId, linker.worktreeFor(taskId) ?? undefined))
  ipcMain.handle('ws:open', (_e, rootId: string) => workstreams.open(rootId))
  ipcMain.handle('ws:refresh', (_e, rootId: string) => workstreams.refresh(rootId))
  ipcMain.handle('ws:note', (_e, rootId: string, body: string) => workstreams.setNote(rootId, body))
  ipcMain.handle('ws:repos', () => [...repoRoots().keys()])
  ipcMain.handle('ws:start', async (_e, taskId: string, repoName: string | null) => {
    const existing = linker.worktreeFor(taskId)
    const title = workstreams.title(taskId)
    if (existing || !repoName) return startForTask(taskId, existing ?? undefined, title)
    const plan = await planWorktree(repoName, taskId, slug(title ?? taskId))
    if (!plan) throw new Error(`No checkout of ${repoName} under the .wtrc repos folders`)
    const res = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['Create and Start', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Create a worktree for “${title ?? taskId}”?`,
      detail: `Runs:\n\n${plan.commands.join('\n')}\n\nThen starts a session there.`,
    })
    if (res.response !== 0) return null
    const err = await createWorktree(plan)
    if (err) throw new Error(err)
    return startForTask(taskId, plan.path, title)
  })
  ipcMain.handle('sessions:fork', (_e, id: string) => {
    const s = sessions.fork(id)
    if (!s) return null
    const src = sessions.get(id)
    for (const l of repo.links().filter((x) => x.sessionId === id)) linker.link(s.id, l.taskId, `forked from ${src?.title ?? 'a session'}`, 'manual')
    return s
  })
  ipcMain.handle('tasks:link', (_e, sessionId: string, taskId: string) => linker.link(sessionId, taskId, 'linked by hand', 'manual'))
  ipcMain.handle('tasks:unlink', (_e, sessionId: string, taskId: string) => linker.unlink(sessionId, taskId))
  ipcMain.handle('tasks:summarize', (_e, taskId: string) => linker.summarize(taskId))
  ipcMain.handle('tasks:detail', (_e, taskId: string) => tasks.detail(taskId))
  // Writes to Productive: each one shows exactly what changes and waits for a yes.
  const askProductive = async (message: string, detail: string) =>
    (await dialog.showMessageBox(win!, { type: 'question', buttons: ['Update Productive', 'Cancel'], defaultId: 0, cancelId: 1, message, detail })).response === 0
  ipcMain.handle('tasks:setStatus', async (_e, taskId: string, statusId: string) => {
    const d = await tasks.detail(taskId)
    const to = d.statuses.find((s) => s.id === statusId)
    const from = d.statuses.find((s) => s.id === d.statusId)
    if (!to || !(await askProductive(`Move the task to “${to.name}”?`, `${d.task.title}\n\n${from?.name ?? '?'} → ${to.name}`))) return null
    await tasks.setStatus(taskId, statusId)
    return tasks.detail(taskId)
  })
  ipcMain.handle('tasks:people', () => tasks.people())
  ipcMain.handle('tasks:comment', async (_e, taskId: string, text: string, tagged: Person[]) => {
    const d = await tasks.detail(taskId)
    const who = tagged.length ? `\n\nTags (notified): ${tagged.map((p) => p.name).join(', ')}` : ''
    if (!text.trim() || !(await askProductive('Post this Productive comment?', `To: ${d.task.title}${who}\n\n${text.trim()}`))) return null
    await tasks.comment(taskId, text.trim(), tagged)
    return tasks.detail(taskId)
  })
  ipcMain.handle('tasks:setTodo', async (_e, taskId: string, todoId: string, closed: boolean) => {
    const d = await tasks.detail(taskId)
    const todo = d.todos.find((t) => t.id === todoId)
    if (!todo || !(await askProductive(closed ? 'Mark this to-do done?' : 'Reopen this to-do?', `${todo.text}\n\non ${d.task.title}`))) return null
    await tasks.setTodo(todoId, closed)
    return tasks.detail(taskId)
  })
  ipcMain.handle('pane:open', (_e, url: string) => pane.open(url))
  ipcMain.handle('pane:bounds', (_e, b: { x: number; y: number; width: number; height: number }) => pane.setBounds(b))
  ipcMain.handle('pane:visible', (_e, v: boolean) => pane.setVisible(v))
  ipcMain.handle('pane:close', () => pane.close())
  ipcMain.handle('pane:nav', (_e, cmd: 'back' | 'forward' | 'reload' | 'copy-url' | 'external' | 'focus') => pane.nav(cmd))
  ipcMain.handle('pane:capture', () => pane.capture())
  ipcMain.handle('pane:state', () => pane.state())
  ipcMain.handle('pane:fill', (_e, url: string, text: string) => pane.fill(url, text))
  ipcMain.handle('pane:close-idle', () => pane.closeIdle())
  ipcMain.handle('memory:snapshot', () => memory.snapshot())
  ipcMain.handle('memory:watch', (_e, on: boolean) => memory.watch(on))
  ipcMain.handle('drafts:compose', (_e, target: DraftTarget, instruction: string) => drafts.compose(target, instruction))
  ipcMain.handle('git:snapshot', () => gitSnapshot())
  ipcMain.handle('git:refresh', () => git.refresh())
  ipcMain.handle('git:seen', (_e, key: string, messageId: string) => {
    repo.markSeen(key, messageId)
    gitChanged()
  })
  ipcMain.handle('drafts:open', (_e, target: DraftTarget) => drafts.open(target))
  ipcMain.handle('drafts:generate', (_e, target: DraftTarget, instruction: string) => drafts.generate(target, instruction))
  ipcMain.handle('drafts:save', (_e, id: number, body: string) => drafts.save(id, body))
  ipcMain.handle('drafts:discard', (_e, id: number) => drafts.discard(id))
  ipcMain.handle('drafts:send', (_e, id: number, body: string) => drafts.send(id, body))
  ipcMain.handle('runpr:snapshot', () => runpr.snapshot())
  ipcMain.handle('runpr:guard', (_e, n: number) => runpr.guard(n))
  ipcMain.handle('runpr:run', (_e, n: number, opts: { alongside?: boolean; dirty?: 'stash' | 'alongside' }) => runpr.run(n, opts))
  ipcMain.handle('runpr:cancel', () => runpr.cancel())
  ipcMain.handle('runpr:back', () => runpr.goBack())
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
  let cafStopped = false
  app.on('before-quit', (e) => {
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
    // Ending Workbench's Amphetamine session is async; finish it before the process goes.
    if (!cafStopped) {
      e.preventDefault()
      cafStopped = true
      void caffeinate.stop().finally(() => app.quit())
      return
    }
    // Run PR's install and build run detached; without this they outlive the app.
    runpr.cancel()
    killHeadless()
    tasks.stop()
    git.stop()
    focus.stop()
    memory.stop()
    pane.dispose()
    sessions.shutdown()
    local.dispose()
    stopSignalServer(signals, socketPath())
  })

  buildMenu()
  win = createWindow()
  win.on('closed', () => (win = null))
})

app.on('window-all-closed', () => app.quit())
