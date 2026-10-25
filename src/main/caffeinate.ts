import { spawn, type ChildProcess } from 'node:child_process'
import { Notification, powerMonitor, powerSaveBlocker, screen } from 'electron'
import type { CaffeinateState, Session } from '@shared/types'
import { autoHolds, settleHolds, strongest, type CafHold, type CafMode, type CafUntil } from '@shared/caffeinate'
import { amphetamineActive, amphetamineEnd, amphetamineSetup, amphetamineStart } from './amphetamine'

export interface CaffeinateDeps {
  /** Asks before replacing an Amphetamine session Workbench didn't start. */
  confirm(message: string, detail: string): Promise<boolean>
  /** Persists whether Workbench owns the running Amphetamine session (survives a crash). */
  owned: { get(): boolean; set(v: boolean): void }
  /** Persists my holds and the Auto rule across restarts. */
  saved: { get(): { holds: CafHold[]; auto: boolean }; set(v: { holds: CafHold[]; auto: boolean }): void }
}

/**
 * Keeps the Mac awake while sessions hold it. Each session can hold it (Awake or Lid closed, until its turn ends, its
 * tab closes, or I release it), and with Auto on every running session holds it too. The Mac follows the strongest hold.
 * - on:  Electron's prevent-app-suspension blocker.
 * - lid: on AC power, an Amphetamine session with closed-display mode (caffeinate can't stop lid-close
 *        sleep on Apple Silicon). Without Amphetamine set up, `caffeinate -s` in clamshell mode only
 *        (AC power plus an external display).
 * Only ever ends Amphetamine sessions it started.
 */
export class Caffeinate {
  private holds: CafHold[]
  private auto: boolean
  private autoSince = new Map<string, number>()
  private sessions: Session[] = []
  private note: string | null = null
  /** Lid closed was asked for but isn't happening (declined, failed); Awake until the lid holds go. */
  private lidBlocked = false
  private lidWarned = false
  private blocker: number | null = null
  private child: ChildProcess | null = null
  private wasWorking = new Set<string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private changed: (s: CaffeinateState) => void,
    private deps: CaffeinateDeps,
  ) {
    const saved = deps.saved.get()
    // An "until done" turn ended with the app.
    this.holds = saved.holds.filter((h) => h.until !== 'done')
    this.auto = saved.auto
    powerMonitor.on('on-battery', () => this.onPowerChange())
    powerMonitor.on('on-ac', () => this.onPowerChange())
    screen.on('display-added', () => this.onPowerChange())
    screen.on('display-removed', () => this.onPowerChange())
    // A session left over from a crash: end it, since nothing will.
    if (deps.owned.get()) void amphetamineEnd().catch(() => {}).finally(() => deps.owned.set(false))
  }

  get(): CaffeinateState {
    const setup = amphetamineSetup()
    const ac = !powerMonitor.isOnBatteryPower()
    const clamshell = ac && screen.getAllDisplays().some((d) => !d.internal)
    const lidVia = ac && setup.ready ? 'amphetamine' : clamshell ? 'clamshell' : null
    const holds = [...this.holds, ...(this.auto ? autoHolds(this.sessions, this.holds, this.autoSince) : [])].sort((a, b) => a.since - b.since)
    const want = strongest(holds)
    const mode = want === 'lid' && (lidVia === null || this.lidBlocked) ? 'on' : want
    return { mode, holds, auto: this.auto, lidAvailable: lidVia !== null, lidVia, lidSetup: setup.missing, note: this.note }
  }

  async set(sessionId: string, mode: CafMode, until?: CafUntil): Promise<CaffeinateState> {
    const old = this.holds.find((h) => h.sessionId === sessionId)
    this.holds = this.holds.filter((h) => h.sessionId !== sessionId)
    this.note = null
    if (mode !== 'off') {
      if (mode === 'lid' && !this.get().lidAvailable)
        this.note = powerMonitor.isOnBatteryPower() ? 'Lid closed needs power; Awake until it is plugged in.' : `Lid closed isn't set up (${this.get().lidSetup ?? 'Amphetamine'}); using Awake.`
      this.holds.push({ sessionId, mode, until: until ?? old?.until ?? 'done', since: old?.since ?? this.autoSince.get(sessionId) ?? Date.now(), auto: false })
    }
    if (!this.holds.some((h) => h.mode === 'lid')) this.lidBlocked = false
    this.save()
    await this.apply()
    return this.get()
  }

  async setAuto(on: boolean): Promise<CaffeinateState> {
    this.auto = on
    this.note = null
    this.save()
    await this.apply()
    return this.get()
  }

  /** Call whenever sessions change: closed tabs and finished turns let go, running sessions join under Auto. */
  sessionsChanged(sessions: Session[]): void {
    this.sessions = sessions
    for (const s of sessions) if (s.state === 'running' && !this.autoSince.has(s.id)) this.autoSince.set(s.id, Date.now())
    for (const id of this.autoSince.keys()) if (!sessions.some((s) => s.id === id && s.state === 'running')) this.autoSince.delete(id)
    const { holds, released } = settleHolds(this.holds, sessions, this.wasWorking)
    this.wasWorking = new Set(sessions.filter((s) => s.alive && (s.state === 'running' || s.state === 'waiting')).map((s) => s.id))
    if (released.length) {
      this.holds = holds
      const names = released.map((h) => sessions.find((s) => s.id === h.sessionId)?.title ?? 'a closed tab')
      this.note = `Let go: ${names.join(', ')} ${released.length > 1 ? 'are' : 'is'} done.`
      if (!this.holds.some((h) => h.mode === 'lid')) this.lidBlocked = false
      this.save()
    }
    void this.apply()
  }

  /** On quit: lets the Mac sleep again; my holds stay saved for the next start. */
  async stop(): Promise<void> {
    this.sessions = []
    this.holds = []
    await this.apply()
  }

  private save(): void {
    this.deps.saved.set({ holds: this.holds, auto: this.auto })
  }

  private onPowerChange(): void {
    const s = this.get()
    const wantsLid = s.holds.some((h) => h.mode === 'lid')
    if (wantsLid && !s.lidAvailable && !this.lidWarned) {
      this.lidWarned = true
      this.note = 'Power disconnected: Awake until it is plugged in again.'
      new Notification({ title: 'Workbench', body: 'Lid-closed keep-awake is paused: power disconnected. The Mac stays awake while open.' }).show()
    }
    if (s.lidAvailable) this.lidWarned = false
    void this.apply()
  }

  /** Serialized: Amphetamine calls are async and must not interleave. */
  private apply(): Promise<void> {
    this.queue = this.queue.then(() => this.applyNow()).catch(() => {})
    return this.queue
  }

  private async applyNow(): Promise<void> {
    const state = this.get()
    const wantBlocker = state.mode !== 'off'
    if (wantBlocker && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!wantBlocker && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
    const via = state.mode === 'lid' ? state.lidVia : null

    if (via === 'amphetamine' && !this.deps.owned.get()) {
      try {
        if (await amphetamineActive()) {
          const ok = await this.deps.confirm(
            'Replace the running Amphetamine session?',
            'Amphetamine already has a session that Workbench didn\'t start (perhaps a Trigger). Starting the lid-closed session ends it.',
          )
          if (!ok) {
            this.lidBlocked = true
            this.note = 'Kept your Amphetamine session; using Awake.'
            return this.changed(this.get())
          }
        }
        await amphetamineStart()
        this.deps.owned.set(true)
      } catch (e) {
        this.lidBlocked = true
        this.note = `Amphetamine didn't start: ${(e as Error).message.slice(0, 100)}. Using Awake.`
      }
    }
    if (via !== 'amphetamine' && this.deps.owned.get()) {
      try {
        if (await amphetamineActive()) await amphetamineEnd()
      } catch {
        // Amphetamine quit or isn't scriptable; nothing left to end.
      }
      this.deps.owned.set(false)
    }

    const wantChild = via === 'clamshell'
    if (wantChild && !this.child) {
      this.child = spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' })
      this.child.on('exit', () => (this.child = null))
    }
    if (!wantChild && this.child) {
      this.child.kill()
      this.child = null
    }
    this.changed(this.get())
  }
}
