import { Notification } from 'electron'
import { gitEvents, type GitSnapshot } from '@shared/git'
import type { NavigateTarget } from '@shared/types'
import type { Repo } from './store/repo'

const SENT_KEY = 'notify:sent'
const KEEP = 2000
/** More new items than this at once become one summary notification. */
const BURST = 4

/** Native notifications. Each git event is announced once, across restarts. */
export class Notifier {
  // Electron drops click handlers of notifications that get garbage collected.
  private live = new Set<Notification>()

  constructor(
    private repo: Repo,
    private open: (t: NavigateTarget) => void,
  ) {}

  git(s: Pick<GitSnapshot, 'viewer' | 'mine' | 'reviews' | 'seen'>): void {
    const events = gitEvents(s)
    const stored = this.repo.getSetting<string[] | null>(SENT_KEY, null)
    const sent = new Set(stored ?? [])
    const fresh = events.filter((e) => !sent.has(e.key))
    if (!fresh.length) return
    this.repo.setSetting(SENT_KEY, [...sent, ...fresh.map((e) => e.key)].slice(-KEEP))
    // The first run only learns what's already there.
    if (stored === null) return
    if (fresh.length > BURST) {
      this.show(`${fresh.length} GitHub updates`, fresh.map((e) => e.title).slice(0, 3).join(' · '), { kind: fresh[0]!.target.tab, prId: null })
      return
    }
    for (const e of fresh) this.show(e.title, e.body, { kind: e.target.tab, prId: e.target.prId })
  }

  session(id: string, title: string, what: 'waiting' | 'finished'): void {
    this.show(what === 'waiting' ? `${title} needs you` : `${title} finished`, what === 'waiting' ? 'Waiting for your input' : 'Claude is done', { kind: 'session', id })
  }

  private show(title: string, body: string, target: NavigateTarget): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    this.live.add(n)
    n.on('click', () => this.open(target))
    n.on('close', () => this.live.delete(n))
    n.show()
    // macOS keeps them in Notification Centre; drop our reference after a while.
    setTimeout(() => this.live.delete(n), 6 * 60 * 60_000).unref()
  }
}
