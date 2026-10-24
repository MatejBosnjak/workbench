import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import { promisify } from 'node:util'
import { app, type WebContents } from 'electron'
import { breakdown, mb, parsePs, tree, type MemoryPressure, type MemoryRow, type MemorySnapshot, type Proc } from '@shared/memory'

const run = promisify(execFile)

/** Background cadence keeps the ▌wb colour and the trend current; the popover asks for more while it's open. */
const IDLE_MS = 30_000
const WATCH_MS = 5_000
const TREND_MS = 30_000
const TREND_POINTS = 60 // 30 minutes
const GROWTH_WINDOW_MS = 10 * 60_000
const GROWTH_MIN_MB = 30

export interface MemorySources {
  window(): WebContents | null
  sessions(): { id: string; pid: number; historyChars: number }[]
  local(): { id: string; pid: number; historyChars: number }[]
  pages(): { key: string; pid: number }[]
  headless(): number[]
  /** Tab title and number by session id. */
  sessionLabel(id: string): string | null
}

/**
 * Samples memory by owner: Workbench's own processes (from Electron), each session's process tree, each local
 * service's. One `ps` call per sample; nothing runs faster than every 30s unless the popover is open.
 */
export class MemoryMonitor {
  private timer: NodeJS.Timeout | null = null
  private watching = false
  private trend: { at: number; mb: number }[] = []
  /** Recent totals per session/service row, for the growth hint. */
  private history = new Map<string, { at: number; mb: number }[]>()
  private last: MemorySnapshot | null = null

  constructor(
    private src: MemorySources,
    private changed: (s: MemorySnapshot) => void,
  ) {}

  start(): void {
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The popover is open: sample now and every 5s until it closes. */
  watch(on: boolean): void {
    this.watching = on
    if (on) {
      this.stop()
      void this.tick()
    }
  }

  snapshot(): MemorySnapshot | null {
    return this.last
  }

  private async tick(): Promise<void> {
    try {
      this.last = await this.sample()
      this.changed(this.last)
    } catch {
      // ps or sysctl failing once isn't worth surfacing; the next tick tries again.
    }
    this.stop()
    this.timer = setTimeout(() => void this.tick(), this.watching ? WATCH_MS : IDLE_MS)
  }

  private async sample(): Promise<MemorySnapshot> {
    const [{ stdout }, pressure] = await Promise.all([run('ps', ['-axo', 'pid=,ppid=,rss=,comm=']), readPressure()])
    const procs = parsePs(stdout)
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    const rssOf = (pid: number) => byPid.get(pid)?.rss ?? 0
    const treeKb = (pid: number) => tree(pid, procs).reduce((n, p) => n + p.rss, 0)
    const now = Date.now()

    // Workbench: Electron's own processes, split by role.
    const winPid = this.src.window()?.getOSProcessId() ?? -1
    const pages = this.src.pages()
    const pagePids = new Set(pages.map((p) => p.pid))
    let gpu = 0
    let helpers = 0
    for (const m of app.getAppMetrics()) {
      if (m.pid === process.pid || m.pid === winPid || pagePids.has(m.pid)) continue
      if (m.type === 'GPU') gpu += rssOf(m.pid)
      else helpers += rssOf(m.pid)
    }
    const ptys = [...this.src.sessions(), ...this.src.local()]
    const historyMb = Math.round((ptys.reduce((n, p) => n + p.historyChars, 0) * 2) / 1024 / 1024)
    const headless = this.src.headless().reduce((n, pid) => n + treeKb(pid), 0)
    const workbench: MemoryRow[] = [
      { id: 'window', name: 'App window', detail: 'UI', mb: mb(rssOf(winPid)) },
      { id: 'main', name: 'Main process', detail: historyMb ? `incl. terminal history ~${historyMb} MB` : '', mb: mb(rssOf(process.pid)) },
      {
        id: 'pages',
        name: 'GitHub pages',
        detail: pages.length ? `${pages.length} loaded` : 'none loaded',
        mb: mb(pages.reduce((n, p) => n + rssOf(p.pid), 0)),
        closable: pages.length > 1,
      },
      { id: 'gpu', name: 'GPU', detail: '', mb: mb(gpu) },
      { id: 'helpers', name: 'Helpers', detail: 'network, storage', mb: mb(helpers) },
      ...(headless ? [{ id: 'headless', name: 'Headless claude', detail: 'drafting or summarizing', mb: mb(headless) }] : []),
    ]

    // Sessions and services: each pty's whole process tree (claude plus its MCP servers, tools, test runners).
    const rowFor = (id: string, name: string, pid: number): MemoryRow => {
      const procs_ = tree(pid, procs)
      const kb = procs_.reduce((n, p: Proc) => n + p.rss, 0)
      return { id, name, detail: breakdown(procs_), mb: mb(kb), growthMb: this.growth(id, mb(kb), now) }
    }
    const sessions = this.src
      .sessions()
      .map((p) => rowFor(p.id, this.src.sessionLabel(p.id) ?? p.id, p.pid))
      .sort((a, b) => b.mb - a.mb)
    const services = this.src
      .local()
      .filter((p) => p.id.startsWith('svc:'))
      .map((p) => rowFor(p.id, p.id.slice(4), p.pid))
      .sort((a, b) => b.mb - a.mb)
    // Shell panes in Local count with services; they're rarely big enough for their own rows.
    const panesMb = this.src
      .local()
      .filter((p) => !p.id.startsWith('svc:'))
      .reduce((n, p) => n + mb(treeKb(p.pid)), 0)
    if (panesMb) services.push({ id: 'panes', name: 'Shell panes', detail: '', mb: panesMb })
    const live = new Set([...sessions, ...services].map((r) => r.id))
    for (const id of this.history.keys()) if (!live.has(id)) this.history.delete(id)

    const sum = (rows: MemoryRow[]) => rows.reduce((n, r) => n + r.mb, 0)
    const workbenchMb = sum(workbench)
    const sessionsMb = sum(sessions)
    const servicesMb = sum(services)
    const totalMb = workbenchMb + sessionsMb + servicesMb
    const lastPoint = this.trend.at(-1)
    if (!lastPoint || now - lastPoint.at >= TREND_MS - 1000) {
      this.trend.push({ at: now, mb: totalMb })
      if (this.trend.length > TREND_POINTS) this.trend.shift()
    }
    return {
      at: now,
      totalMb,
      ramMb: Math.round(totalmem() / 1024 / 1024),
      pressure,
      workbenchMb,
      sessionsMb,
      servicesMb,
      workbench,
      sessions,
      services,
      trend: [...this.trend],
    }
  }

  /** Growth since ~10 minutes ago, when it's big enough to mention. */
  private growth(id: string, now_mb: number, now: number): number | undefined {
    const h = this.history.get(id) ?? []
    if (!h.length || now - h.at(-1)!.at >= TREND_MS - 1000) h.push({ at: now, mb: now_mb })
    while (h.length && now - h[0]!.at > GROWTH_WINDOW_MS) h.shift()
    this.history.set(id, h)
    const d = now_mb - (h[0]?.mb ?? now_mb)
    return d >= GROWTH_MIN_MB ? d : undefined
  }
}

/** macOS memory pressure: kern.memorystatus_vm_pressure_level is 1 normal, 2 warn, 4 critical. */
async function readPressure(): Promise<MemoryPressure> {
  try {
    const { stdout } = await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])
    const n = Number(stdout.trim())
    return n >= 4 ? 'critical' : n >= 2 ? 'warn' : 'normal'
  } catch {
    return 'normal'
  }
}
