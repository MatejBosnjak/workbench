// The in-app GitHub pane: what stays in it, and how PR URLs are keyed.

export interface PaneState {
  /** The active page, or null when the pane shows nothing. */
  url: string | null
  /** The PR the active view was opened for. */
  prUrl: string | null
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** Live views, most recent first. */
  live: string[]
}

export type PaneKey = 'list' | 'back' | 'forward' | 'reload' | 'copy-url' | 'external' | 'palette' | { tab: number }

const ORG = /^https:\/\/github\.com\/productiveio\//
/** GitHub's own sign-in, 2FA and session pages, plus Google's sign-in (the account uses "Sign in with Google"). */
const LOGIN = [
  /^https:\/\/github\.com\/(login|logout|session|sessions)(\/|$|\?)/,
  /^https:\/\/github\.com\/?(\?|$)/,
  /^https:\/\/accounts\.google\.[a-z.]+\//,
  /^https:\/\/(www\.)?google\.[a-z.]+\/(accounts|signin)/,
]

/** Where a navigation goes: stays in the pane (productiveio pages and the login flow) or the system browser. */
export function paneRoute(url: string): 'pane' | 'external' {
  if (ORG.test(url)) return 'pane'
  return LOGIN.some((r) => r.test(url)) ? 'pane' : 'external'
}

/** The PR a URL belongs to: https://github.com/<org>/<repo>/pull/<n>, without tab, hash or query. */
export function prKey(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url)
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null
}

/** Which live view to drop when a new one is needed: the least recent one, skipping views with unsent text when possible. */
export function evictionOrder(live: { key: string; lastUsed: number }[]): string[] {
  return [...live].sort((a, b) => a.lastUsed - b.lastUsed).map((v) => v.key)
}

/** Live GitHub views kept loaded; each is a full github.com page at roughly 80–90 MB. */
export const POOL = 2
