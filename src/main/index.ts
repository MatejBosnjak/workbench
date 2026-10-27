import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { AgentSettings } from '@shared/agent'
import { parsePrUrl, prRepo, shortRepo, type DraftTarget, type GitSnapshot, type Pr } from '@shared/git'
import type { Person, SessionPrLink } from '@shared/tasks'
import type { RunTarget } from '@shared/runpr'
import type { HooksStatus, MenuCommand, NavigateTarget, TabMenuPick } from '@shared/types'
import { Caffeinate } from './caffeinate'
import { headlessPids, killHeadless } from './claude'
import { MemoryMonitor } from './memory'
import { Drafts } from './drafts'
import { prInfo } from './github'
import { GitPoller } from './github/poller'
import { GitHubPane, DEFAULT_ZOOM } from './github/pane'
import { currentStatus, HOOK_EVENTS, install, readSettings, uninstall, writeScripts, writeSkill, type InstallPaths } from './hooks-install'
import { loadConfig } from './local/config'
import { Supervisor } from './local/supervisor'
import { Linker } from './linker'
import { MarksReader } from './marks'
import { createWorktree, currentBranch, planWorktree, repoRoots } from './local/git'
import { WorktreeCleanup } from './local/cleanup'
import { Notifier } from './notify'
import { FocusTracker } from './focus-pr'
import { RunPr } from './local/run-pr'
import { TasksPoller } from './productive/tasks'
import { Sessions } from './sessions'
import { shellEnv, which } from './shell-env'
import { startSignalServer, stopSignalServer } from './signal-server'
import { runWb } from './wb'
import { openDb } from './store/db'
import { Repo } from './store/repo'
import { Suggester } from './suggest'
import { Workstreams } from './workstreams'
import { slug, withoutRepoPrefix } from '@shared/workstream'
import { isTheme, THEMES, type ThemeId } from '@shared/theme'

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
  skillsDir: join(dirname(process.env.WORKBENCH_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json')), 'skills'),
  skillTemplates: app.isPackaged ? join(process.resourcesPath, 'skills') : join(app.getAppPath(), 'resources', 'skills'),
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
    trafficLightPosition: { x: 16, y: 11 },
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
  // Right-click on an in-app link: the browser and the address, whatever a plain click does.
  w.webContents.on('context-menu', (_e, p) => {
    if (!/^https?:\/\//.test(p.linkURL)) return
    Menu.buildFromTemplate([
      { label: 'Open Link in Browser', click: () => void shell.openExternal(p.linkURL) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
    ]).popup({ window: w })
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
      `• Adds the "workbench" skill to ${installPaths().skillsDir}, so Claude in a Workbench tab knows its task and PRs (through the wb command).`,
      '',
      'Only entries marked "# workbench" are added; Uninstall removes exactly those, and the skill.',
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

function buildMenu(theme: ThemeId): void {
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
          {
            label: 'Theme',
            submenu: THEMES.map((t) => ({ label: t.name, type: 'radio' as const, checked: t.id === theme, click: () => send({ type: 'theme', theme: t.id }) })),
          },
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
          { label: 'PR Sidebar', accelerator: 'CmdOrCtrl+Shift+I', click: () => send({ type: 'pr-side' }) },
          { label: 'Focus on This Screen', accelerator: 'CmdOrCtrl+F', click: () => send({ type: 'focus' }) },
          { type: 'separator' },
          { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: () => send({ type: 'cycle-tab', delta: 1 }) },
          { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: () => send({ type: 'cycle-tab', delta: -1 }) },
          { label: 'Next Bookmark', accelerator: 'CmdOrCtrl+]', click: () => send({ type: 'mark-step', delta: 1 }) },
          { label: 'Previous Bookmark', accelerator: 'CmdOrCtrl+[', click: () => send({ type: 'mark-step', delta: -1 }) },
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
    saved: { get: () => repo.getSetting('caf:holds', { holds: [], auto: true }), set: (v) => repo.setSetting('caf:holds', v) },
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
    binDir: installPaths().binDir,
    sessionsChanged: () => {
      const list = sessions.list()
      caffeinate.sessionsChanged(list)
      // The Dock badge counts sessions waiting on you.
      app.setBadgeCount(list.filter((s) => s.state === 'waiting').length)
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
      if (event === 'UserPromptSubmit' && payload.prompt) suggest.onPrompt(id, payload.prompt)
      if (event === 'PostToolUse' && payload.tool_name === 'Bash') suggest.onCommand(id, String((payload.tool_input as { command?: string } | undefined)?.command ?? ''))
      // claude's idle reminder after a finished turn isn't a question: no banner (the Stop already counted).
      if (payload.notification_type !== 'idle_prompt') notifySession(id, event)
    },
    output: (id, data) => {
      focus.onOutput(id, data)
      suggest.onOutput(id, data)
    },
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
  const notifier = new Notifier(repo, navigate, (n) => win?.webContents.send('focus:held', n))
  ipcMain.handle('focus:set', (_e, on: boolean) => notifier.setFocus(on))
  const notifySession = (id: string, event: string) => {
    if (event !== 'Notification' && event !== 'Stop') return
    if (win?.isFocused() && viewedSession === id) return
    const s = sessions.list().find((x) => x.id === id)
    if (s && !s.external) notifier.session(id, s.title, event === 'Notification' ? 'waiting' : 'finished')
  }
  const tasksSnapshot = () => ({ ...linker.snapshot(), sessionPrs: repo.sessionPrs(), hiddenPrs: repo.hiddenPrs(), suggestions: suggest.list() })
  const tasksChanged = () => {
    win?.webContents.send('tasks:changed', tasksSnapshot())
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
  // PRs connected to a task by hand count as naming it, so every view that reads taskRefs shows them.
  const withPrTasks = (prs: Pr[], extra: Map<string, string[]>): Pr[] =>
    prs.map((p) => (extra.has(p.url) ? { ...p, taskRefs: [...new Set([...p.taskRefs, ...extra.get(p.url)!])] } : p))
  const gitSnapshot = (): GitSnapshot => ({
    viewer: git.viewer,
    mine: withPrTasks(git.mine, repo.prTasks()),
    reviews: withPrTasks(git.reviews, repo.prTasks()),
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
  const suggest = new Suggester({
    repo,
    tasks,
    linkedTasks: (id) =>
      repo
        .links()
        .filter((l) => l.sessionId === id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((l) => l.taskId),
    viewer: () => git.viewer,
    changed: () => tasksChanged(),
  })
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
  }, { get: () => repo.getSetting('pane:zoom', DEFAULT_ZOOM), set: (z) => repo.setSetting('pane:zoom', z) })
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
  const cleanup = new WorktreeCleanup(
    {
      productive: () => tasks.client(),
      tabs: () => sessions.list().map((s) => ({ cwd: s.cwd, title: s.title })),
      services: () => local.snapshot().services.map((s) => ({ name: s.name, cwd: s.cwd })),
    },
    (s) => win?.webContents.send('cleanup:changed', s),
  )
  // Once, a minute in, so the Local tab can show the pile; Local › Worktrees rescans when it opens.
  setTimeout(() => void cleanup.scan(), 60_000)
  // statfs is cheap: keeps the low-disk prompt on the Local tab current between scans.
  setInterval(() => cleanup.checkDisk(), 15 * 60_000)
  const workstreams = new Workstreams(repo, tasks, git, linker, (ws) => win?.webContents.send('ws:changed', ws))
  tasks.start()
  git.start()

  /** A new tab for a task, linked to it, titled after it. */
  const startForTask = (taskId: string, cwd: string | undefined, title?: string) => {
    const task = tasks.tasks.find((t) => t.id === taskId)
    const s = sessions.create({ cwd })
    if (task ?? title) sessions.setTitle(s.id, withoutRepoPrefix(task?.title ?? title!))
    linker.link(s.id, taskId, 'started from this task', 'manual')
    // The prompt starts with the task, ready to send or extend; open() types it once claude is up.
    return sessions.get(s.id)
  }
  sessions.taskStart = (id) => {
    const taskId = repo.links().find((l) => l.sessionId === id && l.via === 'started from this task')?.taskId
    if (!taskId) {
      // A session started from a PR: the PR it was connected to.
      const pr = repo.sessionPrs().find((p) => p.sessionId === id)
      return pr ? { prompt: `lets look at this PR ${pr.url} `, title: withoutRepoPrefix(pr.title) } : null
    }
    const task = tasks.tasks.find((t) => t.id === taskId)
    const url = task?.url ?? workstreams.url(taskId)
    return url ? { prompt: `lets look at this task ${url} `, title: withoutRepoPrefix(task?.title ?? workstreams.title(taskId) ?? 'Task') } : null
  }

  // Linking by hand (the pickers, or `wb` from inside a session): a PR from my lists, or any PR URL pasted in.
  const linkPr = (sessionId: string, text: string) => {
    const u = parsePrUrl(text)
    if (!u) return
    const pr = [...git.mine, ...git.reviews].find((p) => p.url === u.url)
    repo.addSessionPr(sessionId, { url: u.url, label: pr ? prRepo(pr) : shortRepo(u.repo), title: pr?.title ?? `PR #${u.number}` })
    tasksChanged()
  }
  const unlinkPr = (sessionId: string, url: string) => {
    repo.unlinkSessionPr(sessionId, url)
    tasksChanged()
  }
  const signals = startSignalServer(
    socketPath(),
    (sig) => sessions.handleSignal(sig),
    (wbId, name, args) =>
      runWb(
        {
          session: (id) => sessions.get(id) ?? undefined,
          tasks: tasksSnapshot,
          git: gitSnapshot,
          runpr: () => runpr.snapshot(),
          branch: (cwd) => (existsSync(cwd) ? currentBranch(cwd) : Promise.resolve(null)),
          linkPr,
          unlinkPr,
          linkTask: (sessionId, taskId) => linker.link(sessionId, taskId, 'linked with wb', 'manual'),
          unlinkTask: (sessionId, taskId) => linker.unlink(sessionId, taskId),
        },
        wbId,
        name,
        args,
      ),
  )
  // Keep installed client scripts (and the skill, once installed) in step with this build.
  const installed = currentStatus(installPaths())
  if (installed.hooks) writeScripts(installPaths())
  if (installed.skill) writeSkill(installPaths())

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
  ipcMain.handle(
    'sessions:tab-menu',
    (_e, _id: string, enabled: Record<TabMenuPick, boolean>) =>
      new Promise<TabMenuPick | null>((resolve) => {
        const item = (label: string, pick: TabMenuPick): MenuItemConstructorOptions => ({ label, enabled: enabled[pick], click: () => resolve(pick) })
        Menu.buildFromTemplate([item('Close', 'close'), { type: 'separator' }, item('Close Others', 'others'), item('Close to the Left', 'left'), item('Close to the Right', 'right'), { type: 'separator' }, item('Close All', 'all')]).popup({
          window: win ?? undefined,
          // A click can arrive just after the menu reports it closed; only a dismissal resolves null (a later resolve is a no-op).
          callback: () => setTimeout(() => resolve(null), 150),
        })
      }),
  )
  ipcMain.handle('sessions:title', (_e, id: string, title: string, auto?: boolean) => sessions.setTitle(id, title, auto))
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
  ipcMain.handle('caf:set', (_e, sessionId: string, mode, until) => caffeinate.set(sessionId, mode, until))
  ipcMain.handle('caf:auto', (_e, on: boolean) => caffeinate.setAuto(on))
  ipcMain.handle('gh:pr', (_e, url: string) => prInfo(url))
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('tasks:snapshot', () => tasksSnapshot())
  // A link suggestion's answer. 'yes' makes the links it offered; 'pr-only' connects just the PR to the session;
  // 'todo' also writes a "PR: url" to-do on the task, after a confirm; 'no' is remembered for that session.
  ipcMain.handle('suggest:answer', async (_e, id: string, answer: 'yes' | 'pr-only' | 'todo' | 'no') => {
    if (answer === 'no') return suggest.dismiss(id)
    const s = suggest.take(id)
    if (!s) return
    if (s.kind === 'task') linker.link(s.sessionId, s.taskId, 'task id in prompt', 'manual')
    else {
      repo.addSessionPr(s.sessionId, s)
      if (s.task && answer !== 'pr-only') {
        repo.addPrTask(s.url, s.task.id)
        if (s.task.fromPr) linker.link(s.sessionId, s.task.id, `PR ${s.label}`, 'manual')
        if (answer === 'todo' && (await askProductive('Add this to-do?', `PR: ${s.url}\n\nAssigned to you, on ${s.task.title}`))) {
          const { personId } = await tasks.client()
          await tasks.addTodo(s.task.id, `PR: ${s.url}`, personId)
        }
      }
      gitChanged()
    }
    tasksChanged()
  })
  ipcMain.handle('tasks:refresh', () => tasks.refresh())
  ipcMain.handle('tasks:start', (_e, taskId: string) => startForTask(taskId, linker.worktreeFor(taskId) ?? undefined))
  ipcMain.handle('tasks:start-for-pr', (_e, pr: Omit<SessionPrLink, 'sessionId'>) => {
    const s = sessions.create({})
    sessions.setTitle(s.id, withoutRepoPrefix(pr.title))
    repo.addSessionPr(s.id, pr)
    tasksChanged()
    return sessions.get(s.id)
  })
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
  ipcMain.handle('tasks:linkPr', (_e, sessionId: string, text: string) => linkPr(sessionId, text))
  ipcMain.handle('tasks:linkPrTask', (_e, url: string, taskId: string) => {
    repo.addPrTask(url, taskId)
    gitChanged()
    tasksChanged()
  })
  ipcMain.handle('tasks:unlinkPr', (_e, sessionId: string, url: string) => unlinkPr(sessionId, url))
  ipcMain.handle('tasks:summarize', (_e, taskId: string) => linker.summarize(taskId))
  const marks = new MarksReader()
  ipcMain.handle('sessions:marks', async (_e, id: string) => {
    const file = linker.transcriptFor(id)
    return file ? marks.read(file).catch(() => []) : []
  })
  ipcMain.handle('tasks:detail', (_e, taskId: string) => tasks.detail(taskId))
  // Writes to Productive: each one shows exactly what changes and waits for a yes (status moves go straight through).
  const askProductive = async (message: string, detail: string) =>
    (await dialog.showMessageBox(win!, { type: 'question', buttons: ['Update Productive', 'Cancel'], defaultId: 0, cancelId: 1, message, detail })).response === 0
  ipcMain.handle('tasks:setStatus', async (_e, taskId: string, statusId: string) => {
    const d = await tasks.detail(taskId)
    if (!d.statuses.some((s) => s.id === statusId)) return null
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
  ipcMain.handle('tasks:addTodo', async (_e, taskId: string, text: string, assignee: Person | null) => {
    const d = await tasks.detail(taskId)
    if (!text.trim() || !(await askProductive('Add this to-do?', `${text.trim()}${assignee ? `\n\nAssigned to ${assignee.name}` : ''}\n\non ${d.task.title}`))) return null
    await tasks.addTodo(taskId, text.trim(), assignee?.id ?? null)
    return tasks.detail(taskId)
  })
  ipcMain.handle('tasks:setTodo', async (_e, taskId: string, todoId: string, closed: boolean) => {
    const d = await tasks.detail(taskId)
    const todo = d.todos.find((t) => t.id === todoId)
    if (!todo || !(await askProductive(closed ? 'Mark this to-do done?' : 'Reopen this to-do?', `${todo.text}\n\non ${d.task.title}`))) return null
    await tasks.setTodo(todoId, closed)
    return tasks.detail(taskId)
  })
  // Like a status move, picking the person is the approval.
  ipcMain.handle('tasks:assignTodo', async (_e, taskId: string, todoId: string, personId: string | null) => {
    await tasks.assignTodo(todoId, personId)
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
  ipcMain.handle('runpr:guard', (_e, n: number, target: RunTarget) => runpr.guard(n, target))
  ipcMain.handle('runpr:run', (_e, n: number, opts: { alongside?: boolean; dirty?: 'stash' | 'alongside'; target?: RunTarget }) => runpr.run(n, opts))
  ipcMain.handle('runpr:cancel', () => runpr.cancel())
  ipcMain.handle('runpr:back', (_e, target: RunTarget) => runpr.goBack(target))
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
  ipcMain.handle('local:aws-login', () => local.awsLogin())
  ipcMain.handle('local:branches', (_e, name: string) => local.branches(name))
  ipcMain.handle('local:checkout', async (_e, name: string, branch: string, run: boolean) => {
    let stash = false
    if (await local.baseDirty(name)) {
      const res = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['Stash and continue', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `${local.state(name)?.def.cwd ?? name} has uncommitted changes`,
        detail: `Stash them (git stash push) before checking out ${branch}? They stay in git stash list.`,
      })
      if (res.response !== 0) return
      stash = true
    }
    await local.checkoutBranch(name, branch, { run, stash })
  })
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
  ipcMain.handle('cleanup:snapshot', () => cleanup.snapshot())
  ipcMain.handle('cleanup:scan', () => cleanup.scan())
  ipcMain.handle('cleanup:remove', async (_e, paths: string[]) => {
    const rows = cleanup.snapshot().rows.filter((r) => paths.includes(r.path))
    if (!rows.length) return
    const branches = rows.filter((r) => r.deleteBranch).length
    const res = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: [`Remove ${rows.length}`, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: rows.length === 1 ? `Remove ${rows[0]!.name}?` : `Remove ${rows.length} worktrees?`,
      detail: [
        rows.length === 1 ? rows[0]!.reason : `${branches} with their branch (merged PR), ${rows.length - branches} keeping it.`,
        '',
        'For each: git worktree remove <path> (no --force: git refuses if anything is uncommitted)',
        ...(branches ? ['then git branch -D <branch> where the PR is merged (-D because squash merges look unmerged to git)'] : []),
        'and git worktree prune once per repo.',
      ].join('\n'),
    })
    if (res.response === 0) await cleanup.remove(rows.map((r) => r.path))
  })
  ipcMain.handle('cleanup:force', async (_e, path: string) => {
    const r = cleanup.snapshot().rows.find((x) => x.path === path)
    if (!r) return
    const res = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Discard and Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove ${r.name} and discard its changes?`,
      detail: `git worktree remove --force throws these away:\n\n${r.changes.join('\n')}${r.moreChanges ? '\n…and more' : ''}\n\nThe branch${r.branch ? ` ${r.branch}` : ''} and its commits are kept.`,
    })
    if (res.response === 0) await cleanup.remove([path], true)
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
    if (key === 'ui:theme' && isTheme(value)) buildMenu(value)
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

  const theme = repo.getSetting<unknown>('ui:theme', 'dusk')
  buildMenu(isTheme(theme) ? theme : 'dusk')
  win = createWindow()
  win.on('closed', () => (win = null))
})

app.on('window-all-closed', () => app.quit())
