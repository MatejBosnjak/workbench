import { Notification } from 'electron'
import { gitEvents, type GitSnapshot } from '@shared/git'
import type { HeldNote, NavigateTarget } from '@shared/types'
import type { Repo } from './store/repo'

const SENT_KEY = 'notify:sent'
const KEEP = 2000
/** More new items than this at once become one summary notification. */
const BURST = 4

/**
 * Native notifications, in tiers: a session waiting on you comes with sound; GitHub news (already only what's for me)
 * comes silent, except a review asked of me; a session finishing its turn shows no banner, its tab says it. Each git
 * event is announced once, across restarts. While focus is on, everything is held and handed back when it ends.
 */
export class Notifier {
  // Electron drops click handlers of notifications that get garbage collected.
  private live = new Set<Notification>()
  private focus = false
  private held: HeldNote[] = []

  constructor(
    private repo: Repo,
    private open: (t: NavigateTarget) => void,
    private heldChanged: (n: number) => void = () => {},
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
    if (fresh.length > BURST && !this.focus) {
      this.show('github', `${fresh.length} GitHub updates`, fresh.map((e) => e.title).slice(0, 3).join(' · '), { kind: fresh[0]!.target.tab, prId: null }, !fresh.some((e) => e.key.startsWith('rr:')))
      return
    }
    for (const e of fresh) this.show('github', e.title, e.body, { kind: e.target.tab, prId: e.target.prId }, !e.key.startsWith('rr:'))
  }

  session(id: string, title: string, what: 'waiting' | 'finished'): void {
    const target: NavigateTarget = { kind: 'session', id }
    if (what === 'waiting') this.show('waiting', `${title} needs you`, 'Waiting for your input', target, false)
    // No banner for a finished turn; focus still lists it.
    else if (this.focus) this.hold({ kind: 'finished', title: `${title} finished`, body: 'Claude is done', at: Date.now(), target })
  }

  /** Turns focus on (holding from now) or off (returning what was held, most urgent first). */
  setFocus(on: boolean): HeldNote[] {
    this.focus = on
    const out = on ? [] : this.held
    this.held = []
    this.heldChanged(0)
    const rank = { waiting: 0, github: 1, finished: 2 }
    return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.at - a.at)
  }

  private hold(note: HeldNote): void {
    this.held.push(note)
    this.heldChanged(this.held.length)
  }

  private show(kind: HeldNote['kind'], title: string, body: string, target: NavigateTarget, silent: boolean): void {
    if (this.focus) return this.hold({ kind, title, body, at: Date.now(), target })
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent })
    this.live.add(n)
    n.on('click', () => this.open(target))
    n.on('close', () => this.live.delete(n))
    n.show()
    // macOS keeps them in Notification Centre; drop our reference after a while.
    setTimeout(() => this.live.delete(n), 6 * 60 * 60_000).unref()
  }
}
