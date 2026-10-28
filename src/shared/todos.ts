/** A to-do of my own in Needs you: not Productive's, kept only in Workbench's SQLite. */
export interface MyTodo {
  id: number
  text: string
  note: string
  /** YYYY-MM-DD; null shows it at once and never makes it late. */
  due: string | null
  /** The session it was captured from; ⏎ goes back there. */
  sessionId: string | null
  /** Its title when captured, for once its tab is gone. */
  sessionTitle: string | null
  createdAt: number
  doneAt: number | null
}

export type NewTodo = Pick<MyTodo, 'text' | 'due' | 'sessionId' | 'sessionTitle'>
export type TodoPatch = Partial<Pick<MyTodo, 'text' | 'note' | 'due' | 'sessionId' | 'sessionTitle' | 'doneAt'>>

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** A day word as typed: today, tomorrow, a weekday (the next one, never today), "3 nov" / "nov 3" (this year, or next once past), 2026-11-03. */
export function parseDay(word: string, now = new Date()): string | null {
  const w = word.trim().toLowerCase()
  const at = (days: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
    return isoDay(d)
  }
  if (w === 'today') return at(0)
  if (w === 'tomorrow' || w === 'tmr' || w === 'tom') return at(1)
  const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const wd = w.length >= 3 ? full.findIndex((d) => d.startsWith(w)) : -1
  if (wd >= 0) return at(((wd - now.getDay() + 6) % 7) + 1)
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w
  const dm = /^(\d{1,2})\.?\s*([a-z]{3})[a-z]*$/.exec(w)
  const md = /^([a-z]{3})[a-z]*\s*(\d{1,2})$/.exec(w)
  if (!dm && !md) return null
  const [day, mon] = dm ? [Number(dm[1]), dm[2]!] : [Number(md![2]), md![1]!]
  const mi = MONTHS.indexOf(mon)
  if (mi < 0 || day < 1 || day > 31) return null
  let d = new Date(now.getFullYear(), mi, day)
  if (isoDay(d) < isoDay(now)) d = new Date(now.getFullYear() + 1, mi, day)
  return isoDay(d)
}

/** "Call the bank fri" → text and due; the last one or two words are tried as a day. */
export function parseCapture(line: string, now = new Date()): { text: string; due: string | null } {
  const words = line.trim().split(/\s+/)
  for (const n of [2, 1]) {
    if (words.length <= n) continue
    const due = parseDay(words.slice(-n).join(' '), now)
    if (due) return { text: words.slice(0, -n).join(' '), due }
  }
  return { text: line.trim(), due: null }
}

/** "today", "tomorrow", "Fri 31 Oct": how a due day reads. */
export function dayText(due: string, now = new Date()): string {
  if (due === isoDay(now)) return 'today'
  const tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  if (due === isoDay(tmr)) return 'tomorrow'
  return new Date(`${due}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}
