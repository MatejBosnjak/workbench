// Screenshots of every screen into docs/design/current/, from the built app on a scratch profile with live data.
// `pnpm snap` builds first. `pnpm snap today-tasks session` retakes only the named shots.
// The window is invisible and click-through. The scratch profile gets a copy of your services config and GitHub pane login; hooks go to a scratch settings file,
// and every Productive or GitHub write is answered Cancel. Sessions run haiku and send two one-word prompts.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'docs/design/current')
const TMP = join(tmpdir(), 'workbench-snap')
const REAL = join(homedir(), 'Library/Application Support/Workbench')
const only = new Set(process.argv.slice(2))

rmSync(TMP, { recursive: true, force: true })
mkdirSync(join(TMP, 'userdata'), { recursive: true })
mkdirSync(OUT, { recursive: true })
if (existsSync(join(REAL, 'services.json'))) cpSync(join(REAL, 'services.json'), join(TMP, 'userdata/services.json'))
if (existsSync(join(REAL, 'Partitions'))) cpSync(join(REAL, 'Partitions'), join(TMP, 'userdata/Partitions'), { recursive: true })
writeFileSync(join(TMP, 's.json'), '{}')

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')))
const app = await electron.launch({
  executablePath: join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [ROOT, `--user-data-dir=${join(TMP, 'userdata')}`],
  cwd: ROOT,
  env: { ...env, WORKBENCH_CLAUDE_SETTINGS: join(TMP, 's.json'), WORKBENCH_SOCKET: join(TMP, 'wb.sock'), WORKBENCH_BACKGROUND: '1' },
})
await app.evaluate(({ shell, dialog, BrowserWindow }) => {
  shell.openExternal = async () => {}
  // Yes to installing hooks (into the scratch file); Cancel to anything else, so nothing is written to Productive or GitHub.
  dialog.showMessageBox = async (a, b) => {
    const o = b ?? a
    return { response: /hook/i.test(`${o.message} ${o.detail ?? ''}`) ? 0 : 1, checkboxChecked: false }
  }
  const w = BrowserWindow.getAllWindows()[0]
  w?.setSize(1600, 1000)
  w?.center()
  // A full window with live data looks exactly like the real app: keep it invisible and click-through, so nobody
  // works in it by mistake. Captures read the page, not the screen, and Playwright's input doesn't go through the OS.
  w?.setOpacity(0)
  w?.setIgnoreMouseEvents(true)
  w?.setFocusable(false)
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
const wait = (ms) => page.waitForTimeout(ms)
const until = async (fn, ms = 90_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null)
    if (v) return v
    await wait(500)
  }
  return null
}
const api = (fn, arg) => page.evaluate(fn, arg)
const failed = []
/** One shot: `prep` gets the screen into shape; the whole window (GitHub pane included) is saved. */
const shot = async (name, prep) => {
  if (only.size && !only.has(name)) return
  try {
    await page.keyboard.press('Escape')
    await prep?.()
    await wait(700)
    writeFileSync(join(OUT, `${name}.png`), await capture())
    console.log('✓', name)
  } catch (e) {
    failed.push(name)
    console.log('✗', name, e.message.split('\n')[0])
  }
}
const click = (sel) => page.click(sel, { timeout: 8000 })
/** The window as you see it: the page plus the GitHub pane's view drawn over it, at 1x so the files stay small. */
const capture = async () => {
  const parts = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const views = w.contentView.children.filter((v) => v.webContents && v.getVisible?.() !== false)
    return [
      { png: (await w.webContents.capturePage()).toPNG().toString('base64'), ...w.getContentBounds(), x: 0, y: 0 },
      ...(await Promise.all(views.map(async (v) => ({ png: (await v.webContents.capturePage()).toPNG().toString('base64'), ...v.getBounds() })))),
    ]
  })
  const url = await page.evaluate(async (parts) => {
    const c = new OffscreenCanvas(parts[0].width, parts[0].height)
    const g = c.getContext('2d')
    for (const p of parts) g.drawImage(await createImageBitmap(new Blob([Uint8Array.from(atob(p.png), (ch) => ch.charCodeAt(0))], { type: 'image/png' })), p.x, p.y, p.width, p.height)
    const blob = await c.convertToBlob({ type: 'image/png' })
    return new Promise((res) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.readAsDataURL(blob)
    })
  }, parts)
  return Buffer.from(url.split(',')[1], 'base64')
}

await page.waitForSelector('.statusbar')
await api(() => window.workbench.installHooks())
await api(() => window.workbench.setDefaults({ model: 'haiku', effort: null, permissionMode: null }))
await until(async () => (await api(() => window.workbench.tasks.snapshot())).fetchedAt && (await api(() => window.workbench.git.snapshot())).fetchedAt)

const today = async (tab) => {
  await click('.place:has-text("Today")')
  if (tab) await click(`.counter:has-text("${tab}")`)
}
await shot('today-needs', () => today('Needs you'))
await shot('today-tasks', () => today('My tasks'))
await shot('today-task-card', async () => {
  await today('My tasks')
  // A subtask with a design link (its own or its parent's), so the card shows the Design row.
  const withDesign = page.locator('.task-line.row:not(.parent):has(.figma-mark)').first()
  if (await withDesign.count()) await withDesign.click()
  else await click('.task-line.row:not(.parent)')
  await page.waitForSelector('.td-todo, .task-desc, .peek', { timeout: 15_000 }).catch(() => {})
})
await shot('today-prs', () => today('My PRs'))
await shot('today-reviews', () => today('Reviews'))
await shot('github-pane', async () => {
  await today('My PRs')
  await click('.pr-wrap .pr-row')
  await wait(5000)
})
await api(() => window.workbench.pane.close?.())
await shot('workstream', async () => {
  await today('My tasks')
  await click('.ctx-open')
  await page.waitForSelector('.ws-who', { timeout: 20_000 })
})
await page.click('.ws-place-close').catch(() => {})
// Service and shell panes are login shells; give them time to print a prompt.
await shot('local', async () => {
  await click('.place[aria-label^="Local"]')
  await wait(4000)
})
// Reads every worktree's git state, then GitHub and Productive, then sizes: slow.
await shot('local-worktrees', async () => {
  await click('.place[aria-label^="Local"]')
  await click('.local-tabs button:nth-child(2)')
  await until(() => api(() => window.workbench.cleanup.snapshot().then((s) => s.scannedAt && !s.scanning)), 240_000)
  // Then du sizes the done ones (node_modules and all).
  await until(() => api(() => window.workbench.cleanup.snapshot().then((s) => s.rows.filter((r) => r.verdict === 'done').every((r) => r.bytes !== null))), 480_000)
  await wait(800)
})
await page.click('.local-tabs button:nth-child(1)').catch(() => {})

// A session started from a task: it prefills the task prompt; replace it with two one-word prompts, the second naming
// another task so the link suggestion shows.
const snap = await api(() => window.workbench.tasks.snapshot())
const parents = new Set(snap.tasks.map((t) => t.parentId))
const mine = snap.tasks.filter((t) => !parents.has(t.id))
// Start from a task that has a PR, so the session bar shows both buttons.
const git = await api(() => window.workbench.git.snapshot())
const withPr = new Set([...git.mine, ...git.reviews].flatMap((p) => p.taskRefs ?? []))
const t1 = mine.find((t) => withPr.has(t.id)) ?? mine[0] ?? snap.tasks[0]
const t2 = mine.find((t) => t !== t1)
const wantSession = !only.size || [...only].some((n) => n.startsWith('session') || n.startsWith('theme-') || ['focus', 'palette', 'caffeinate', 'memory', 'keys', 'picker'].includes(n))
let sid = null
const send = async (text) => {
  await api(([id, t]) => window.workbench.writeSession(id, t), [sid, text])
  await wait(400)
  await api((id) => window.workbench.writeSession(id, '\r'), sid)
}
if (wantSession && t1) {
  const s = await api((id) => window.workbench.tasks.start(id), t1.id)
  sid = s.id
  // A second PR, failing if I have one, so the session bar shows several (worst first).
  const extra = git.mine.find((p) => p.ci === 'fail' && !(p.taskRefs ?? []).includes(t1.id)) ?? git.mine.find((p) => !(p.taskRefs ?? []).includes(t1.id))
  if (extra) await api(([id, url]) => window.workbench.tasks.linkPr(id, url), [sid, extra.url])
  await click('.tab >> nth=-1')
  await until(async () => (await page.$eval('.term', (e) => e.innerText)).includes('lets look at this task'), 40_000)
  await api((id) => window.workbench.writeSession(id, '\x15'), sid)
  await send('Reply with just: ok')
  await wait(12_000)
  await send(`Reply with just: ok. (context: ${t2?.id ?? ''})`)
  await until(async () => page.$('.lsug'), 40_000)
  await wait(4000)
}
const session = async () => {
  if (sid) await click('.tab >> nth=-1')
}
await shot('session-suggest', session)
await page.click('.lsug-no').catch(() => {})
await shot('session', session)
await shot('session-legend', async () => {
  await session()
  await click('.marks-legend-btn')
})
// Turn focus: leave the tab while claude answers, come back to "new since you left"; a long answer pins "you asked".
await shot('session-focus', async () => {
  await session()
  await click('.place:has-text("Today")')
  await send('Print the numbers 1 to 12, one per line, nothing else')
  await wait(15_000)
  await session()
  await page.waitForSelector('.turn-since', { timeout: 20_000 })
})
await shot('session-pinned', async () => {
  await session()
  await send('Print the numbers 1 to 70, one per line, nothing else')
  await page.waitForSelector('.turn-pin', { timeout: 40_000 })
  await wait(3000)
})
await shot('session-task-side', async () => {
  await session()
  await click('.session-bar .sbar-btn:not(.pad):not(.seg)')
})
await click('.session-bar .sbar-btn:not(.pad):not(.seg)').catch(() => {})
await shot('session-pr-side', async () => {
  await session()
  await click('.session-bar .sbar-btn.seg >> nth=0')
  await page.click('.sb-chip:not(.lk-add)', { timeout: 5000 }).catch(() => {})
  await wait(5000)
})
await click('.session-bar .sbar-btn.seg.on').catch(() => {})
const menu = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu', c), cmd)
await shot('focus', async () => {
  await session()
  await menu({ type: 'focus' })
})
// Leaving may list what was held; the next shot's Escape closes it.
await menu({ type: 'focus' })
const blurred = async (fn) => {
  await session()
  await page.evaluate(() => document.activeElement?.blur())
  await fn()
}
await shot('palette', () => blurred(() => click('.kbar')))
// The session holds the Mac until I stop it, so the list has a row.
await shot('caffeinate', async () => {
  if (sid) await api((id) => window.workbench.setCaffeinate(id, 'on', 'manual'), sid)
  await blurred(() => click('.cafb-btn'))
})
await shot('session-cup', () => blurred(() => click('.sbar-cup')))
await shot('memory', () => blurred(() => click('.mem-btn')))
await shot('keys', () => blurred(() => page.focus('.sb-keys')))
await shot('picker', () => blurred(() => click('.picker-btn')))

// Each non-default theme on My tasks and the session, then back to Dusk.
for (const theme of ['muthur', 'brown', 'console', 'night']) {
  await menu({ type: 'theme', theme })
  await shot(`theme-${theme}`, () => today('My tasks'))
  await shot(`theme-${theme}-session`, async () => {
    await session()
    await wait(800)
  })
}
await menu({ type: 'theme', theme: 'dusk' })

if (sid) await api((id) => window.workbench.closeSession(id), sid)
await app.close()
console.log(failed.length ? `failed: ${failed.join(', ')}` : `all shots in ${OUT}`)
process.exit(failed.length ? 1 : 0)
