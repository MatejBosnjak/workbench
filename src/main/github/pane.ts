import { clipboard, dialog, session, shell, WebContentsView, type BrowserWindow } from 'electron'
import { evictionOrder, paneRoute, POOL, prKey, type PaneKey, type PaneState } from '@shared/pane'

export const PARTITION = 'persist:github'

interface Live {
  key: string
  view: WebContentsView
  lastUsed: number
}

export interface PaneEvents {
  changed(s: PaneState): void
  /** A Workbench ⌘ shortcut pressed while GitHub had focus. */
  key(k: PaneKey): void
  /** The page navigated or a form was submitted; the PR may have changed. */
  activity(prUrl: string): void
}

/** Marks form submits in the page so main hears about posted comments (read back from the console). */
const SUBMIT_HOOK = `(() => {
  if (window.__wbSubmitHook) return
  window.__wbSubmitHook = true
  document.addEventListener('submit', () => console.log('__workbench_submit__'), true)
})()`

/**
 * Fills a review thread's reply box (docs/SPEC.md › GitHub pane, verified in the spike): find the comment by the
 * URL's anchor, open the thread's "Reply…" box, set the visible textarea through the native setter so GitHub's
 * own code sees it. Returns what happened; the page is never submitted.
 */
const fillScript = (text: string) => `(async () => {
  const TEXT = ${JSON.stringify(text)}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (e) => !!e && e.offsetParent !== null && e.getBoundingClientRect().height > 0
  const id = location.hash.slice(1)
  let el = null
  for (let i = 0; i < 30 && !el; i++) { el = id && (document.getElementById(id) || document.querySelector('[id$="' + id + '"]')); if (!el) await sleep(300) }
  const scope = el ? (el.closest('.js-resolvable-timeline-thread-container, .review-thread-component, .js-inline-comments-container, .js-comment-container') || el.parentElement) : document
  const findTa = () => [...scope.querySelectorAll('textarea')].filter(visible).pop()
  let ta = el ? findTa() : null
  if (el && !ta) {
    const btn = [...scope.querySelectorAll('button, [role="button"], .review-thread-reply-button')].find((b) => visible(b) && /reply/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')))
    if (btn) { btn.click(); for (let i = 0; i < 10 && !ta; i++) { await sleep(300); ta = findTa() } }
  }
  if (!el) {
    // The PR's own conversation: the "Add a comment" box at the bottom.
    ta = document.querySelector('#new_comment_field') || [...document.querySelectorAll('textarea[name="comment[body]"]')].filter(visible).pop()
  }
  if (!ta) { (el || document.body).scrollIntoView({ block: 'center' }); return { filled: false } }
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  ta.scrollIntoView({ block: 'center' })
  ta.focus()
  if (TEXT) { set.call(ta, TEXT); ta.dispatchEvent(new Event('input', { bubbles: true })) }
  return { filled: true }
})()`

const HAS_TEXT = `[...document.querySelectorAll('textarea')].some((t) => t.value.trim().length > 0)`

/**
 * GitHub inside Workbench: a small pool of WebContentsViews on one persistent login partition, laid over the
 * rectangle the renderer reports. Only github.com/productiveio pages and the login flow stay in the pane.
 */
export class GitHubPane {
  private live: Live[] = []
  private active: Live | null = null
  private bounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false

  constructor(
    private win: () => BrowserWindow | null,
    private events: PaneEvents,
  ) {}

  state(): PaneState {
    const wc = this.active?.view.webContents
    return {
      url: wc?.getURL() || null,
      prUrl: this.active?.key ?? null,
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canBack: wc?.navigationHistory.canGoBack() ?? false,
      canForward: wc?.navigationHistory.canGoForward() ?? false,
      live: [...this.live].sort((a, b) => b.lastUsed - a.lastUsed).map((l) => l.key),
    }
  }

  /** Shows a page: the PR's live view when there is one (navigating it if the URL differs), else a new view. */
  async open(url: string): Promise<void> {
    if (paneRoute(url) !== 'pane') return void shell.openExternal(url)
    const key = prKey(url) ?? url
    let l = this.live.find((x) => x.key === key)
    if (!l) {
      await this.makeRoom()
      l = this.create(key)
      this.live.push(l)
      void l.view.webContents.loadURL(url)
    } else if (url !== key) {
      const wc = l.view.webContents
      const here = wc.getURL().split('#')[0]
      const [there, hash] = url.split('#')
      // Same page (GitHub drops the anchor once loaded): only jump, never reload, so typed text survives.
      if (here === there) {
        if (hash) void wc.executeJavaScript(`(() => { const el = document.getElementById(${JSON.stringify(hash)}); if (el) el.scrollIntoView({ block: 'center' }); history.replaceState(null, '', '#' + ${JSON.stringify(hash)}) })()`).catch(() => {})
      } else void wc.loadURL(url)
    }
    this.activate(l)
  }

  /** The renderer reports CSS pixels; the view is placed in window points, so the page's zoom is applied here. */
  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    const z = this.win()?.webContents.getZoomFactor() ?? 1
    this.bounds = { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.max(0, Math.round(b.width * z)), height: Math.max(0, Math.round(b.height * z)) }
    this.layout()
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.layout()
  }

  /** Closes the active view (the list stays). */
  close(): void {
    const l = this.active
    if (!l) return
    this.drop(l)
    this.active = null
    this.layout()
    this.emit()
  }

  nav(cmd: 'back' | 'forward' | 'reload' | 'copy-url' | 'external' | 'focus'): void {
    const wc = this.active?.view.webContents
    if (!wc) return
    if (cmd === 'back') wc.navigationHistory.goBack()
    if (cmd === 'forward') wc.navigationHistory.goForward()
    if (cmd === 'reload') wc.reload()
    if (cmd === 'copy-url') clipboard.writeText(wc.getURL())
    if (cmd === 'external') void shell.openExternal(wc.getURL())
    if (cmd === 'focus') wc.focus()
  }

  /** A still image of the active page, shown in its place while an overlay covers the pane. */
  async capture(): Promise<string | null> {
    const wc = this.active?.view.webContents
    if (!wc || !this.visible) return null
    return (await wc.capturePage()).toDataURL()
  }

  /** Opens the conversation's URL and fills its reply box. False when the box wasn't found (the text goes to the clipboard). */
  async fill(messageUrl: string, text: string): Promise<boolean> {
    await this.open(messageUrl)
    const wc = this.active!.view.webContents
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        wc.once('did-stop-loading', done)
        setTimeout(done, 15_000)
      })
    }
    // The fill script reads the anchor from location.hash; GitHub may have dropped it.
    const hash = messageUrl.includes('#') ? `#${messageUrl.split('#')[1]}` : ''
    if (hash) await wc.executeJavaScript(`history.replaceState(null, '', ${JSON.stringify(hash)})`).catch(() => {})
    const r = (await wc.executeJavaScript(fillScript(text)).catch(() => ({ filled: false }))) as { filled: boolean }
    if (!r.filled && text) clipboard.writeText(text)
    wc.focus()
    return r.filled
  }

  async signOut(): Promise<void> {
    for (const l of [...this.live]) this.drop(l)
    this.active = null
    await session.fromPartition(PARTITION).clearStorageData()
    this.layout()
    this.emit()
  }

  dispose(): void {
    for (const l of [...this.live]) this.drop(l)
  }

  private create(key: string): Live {
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true } })
    view.setBackgroundColor('#0E0D12')
    const wc = view.webContents
    const route = (e: { preventDefault(): void }, url: string) => {
      if (paneRoute(url) === 'pane') return
      e.preventDefault()
      void shell.openExternal(url)
    }
    wc.on('will-navigate', (e) => route(e, e.url))
    wc.on('will-redirect', (e) => route(e, e.url))
    wc.setWindowOpenHandler(({ url }) => {
      if (paneRoute(url) === 'pane' && prKey(url)) void this.open(url)
      else void shell.openExternal(url)
      return { action: 'deny' }
    })
    const touched = () => {
      this.emit()
      this.events.activity(key)
    }
    wc.on('did-navigate', touched)
    wc.on('did-navigate-in-page', touched)
    wc.on('did-start-loading', () => this.emit())
    wc.on('did-stop-loading', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('dom-ready', () => void wc.executeJavaScript(SUBMIT_HOOK).catch(() => {}))
    wc.on('console-message', (e) => {
      if (e.message === '__workbench_submit__') setTimeout(() => this.events.activity(key), 2500)
    })
    // While GitHub has focus, Workbench keeps only its ⌘ shortcuts.
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return
      const k = input.key.toLowerCase()
      const map: Record<string, PaneKey> = { j: 'list', '[': 'back', ']': 'forward', r: 'reload', l: 'copy-url', enter: 'external', k: 'palette' }
      let action: PaneKey | undefined = map[k]
      if (!action && /^[1-9]$/.test(k)) action = { tab: Number(k) - 1 }
      if (!action) return
      e.preventDefault()
      if (action === 'back' || action === 'forward' || action === 'reload' || action === 'copy-url' || action === 'external') this.nav(action)
      this.events.key(action)
    })
    return { key, view, lastUsed: Date.now() }
  }

  private activate(l: Live): void {
    l.lastUsed = Date.now()
    this.active = l
    this.layout()
    this.emit()
  }

  /** Keeps at most POOL views, evicting the least recent; asks before dropping one with typed, unsent text. */
  private async makeRoom(): Promise<void> {
    while (this.live.length >= POOL) {
      const order = evictionOrder(this.live)
      let dropped = false
      for (const key of order) {
        const l = this.live.find((x) => x.key === key)!
        const typed = (await l.view.webContents.executeJavaScript(HAS_TEXT).catch(() => false)) as boolean
        if (typed) {
          const win = this.win()
          const answer = win
            ? (await dialog.showMessageBox(win, { type: 'question', buttons: ['Keep it open', 'Discard'], defaultId: 0, cancelId: 0, message: 'A GitHub page has unsent text', detail: `${key}\n\nClosing it to open another PR would lose what you typed.` })).response
            : 0
          if (answer === 0) continue
        }
        this.drop(l)
        dropped = true
        break
      }
      // Every live page has text the user kept: go over the limit rather than lose it.
      if (!dropped) return
    }
  }

  private drop(l: Live): void {
    this.win()?.contentView.removeChildView(l.view)
    l.view.webContents.close()
    this.live = this.live.filter((x) => x !== l)
  }

  private layout(): void {
    const win = this.win()
    if (!win) return
    for (const l of this.live) {
      const show = l === this.active && this.visible && this.bounds.width > 0 && this.bounds.height > 0
      if (show) {
        if (!win.contentView.children.includes(l.view)) win.contentView.addChildView(l.view)
        l.view.setBounds(this.bounds)
        l.view.setVisible(true)
      } else if (win.contentView.children.includes(l.view)) {
        l.view.setVisible(false)
      }
    }
  }

  private emit(): void {
    this.events.changed(this.state())
  }
}
