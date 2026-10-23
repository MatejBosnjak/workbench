/** One line in the memory popover. */
export interface MemoryRow {
  /** Session id, service name, or a fixed key for Workbench's own parts. */
  id: string
  name: string
  /** Faint text after the name, e.g. "claude 312 · node ×2 96". */
  detail: string
  mb: number
  /** Growth over the last ~10 minutes, when it's worth pointing out. */
  growthMb?: number
  /** GitHub pages beyond the one on screen can be closed from the row. */
  closable?: boolean
}

export type MemoryPressure = 'normal' | 'warn' | 'critical'

export interface MemorySnapshot {
  at: number
  totalMb: number
  ramMb: number
  pressure: MemoryPressure
  workbenchMb: number
  sessionsMb: number
  servicesMb: number
  workbench: MemoryRow[]
  sessions: MemoryRow[]
  services: MemoryRow[]
  /** Total over the last 30 minutes, oldest first. */
  trend: { at: number; mb: number }[]
}

export interface Proc {
  pid: number
  ppid: number
  /** Resident memory in KB, as `ps` reports it. */
  rss: number
  comm: string
}

/** Parses `ps -axo pid=,ppid=,rss=,comm=`. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), comm: m[4]!.trim() })
  }
  return procs
}

/** A process and all its descendants, root first. */
export function tree(root: number, procs: Proc[]): Proc[] {
  const kids = new Map<number, Proc[]>()
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  const self = procs.find((p) => p.pid === root)
  if (!self) return []
  const out: Proc[] = []
  const todo = [self]
  while (todo.length) {
    const p = todo.pop()!
    out.push(p)
    todo.push(...(kids.get(p.pid) ?? []))
  }
  return out
}

export const mb = (kb: number) => Math.round(kb / 1024)

/** "claude 312 · node ×2 96 · vitest 214": the biggest kinds of process in a tree, by executable name. */
export function breakdown(procs: Proc[], max = 3): string {
  const by = new Map<string, { kb: number; n: number }>()
  for (const p of procs) {
    const name = p.comm.split('/').pop() || p.comm
    const e = by.get(name) ?? { kb: 0, n: 0 }
    by.set(name, { kb: e.kb + p.rss, n: e.n + 1 })
  }
  return [...by.entries()]
    .filter(([, e]) => mb(e.kb) >= 1)
    .sort((a, b) => b[1].kb - a[1].kb)
    .slice(0, max)
    .map(([name, e]) => `${name}${e.n > 1 ? ` ×${e.n}` : ''} ${mb(e.kb)}`)
    .join(' · ')
}

/** The ▌ scale: light purple → purple → dark purple → dark red → bright red. */
const COLORS = ['#CDB8F5', '#A07EEA', '#6B4FB0', '#A33A50', '#FF4D6A']

/**
 * The ▌wb glyph colour for a total. Each step is 1/12 of the Mac's RAM (red from a third); between the
 * mid-band stops it blends in OKLab, so it never jumps at a threshold. Critical pressure is bright red.
 */
export function memoryColor(totalMb: number, ramMb: number, pressure: MemoryPressure): string {
  if (pressure === 'critical') return COLORS[4]!
  const step = ramMb / 12
  const x = totalMb / step - 0.5
  if (x <= 0) return COLORS[0]!
  if (x >= COLORS.length - 1) return COLORS[COLORS.length - 1]!
  const i = Math.floor(x)
  const f = Math.round((x - i) * 100)
  return `color-mix(in oklab, ${COLORS[i + 1]} ${f}%, ${COLORS[i]})`
}

/** "2.4G" / "860M" for the taskbar. */
export function shortSize(mbTotal: number): string {
  return mbTotal >= 1024 ? `${(mbTotal / 1024).toFixed(1)}G` : `${mbTotal}M`
}
