import { spawn, type ChildProcess } from 'node:child_process'
import { Notification, powerMonitor, powerSaveBlocker, screen } from 'electron'
import type { CaffeinateState, Session } from '@shared/types'
import { amphetamineActive, amphetamineEnd, amphetamineSetup, amphetamineStart } from './amphetamine'

export interface CaffeinateDeps {
  /** Asks before replacing an Amphetamine session Workbench didn't start. */
  confirm(message: string, detail: string): Promise<boolean>
  /** Persists whether Workbench owns the running Amphetamine session (survives a crash). */
  owned: { get(): boolean; set(v: boolean): void }
}

/**
 * Keeps the Mac awake while sessions run.
 * - on:  Electron's prevent-app-suspension blocker.
 * - lid: on AC power, an Amphetamine session with closed-display mode (caffeinate can't stop lid-close
 *        sleep on Apple Silicon). Without Amphetamine set up, `caffeinate -s` in clamshell mode only
 *        (AC power plus an external display).
 * Turns itself off when a scoped session stops running. Only ever ends Amphetamine sessions it started.
 */
export class Caffeinate {
  private state: CaffeinateState = { mode: 'off', scope: 'session', sessionId: null, lidAvailable: false, lidVia: null, lidSetup: null, note: null }
  private blocker: number | null = null
  private child: ChildProcess | null = null
  private wasRunning = new Set<string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private changed: (s: CaffeinateState) => void,
    private deps: CaffeinateDeps,
  ) {
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
    return { ...this.state, lidAvailable: lidVia !== null, lidVia, lidSetup: setup.missing }
  }

  async set(mode: CaffeinateState['mode'], scope: CaffeinateState['scope'], sessionId: string | null): Promise<CaffeinateState> {
    let note: string | null = null
    if (mode === 'lid' && !this.get().lidAvailable) {
      mode = 'on'
      note = powerMonitor.isOnBatteryPower() ? 'Lid closed needs power; using Awake.' : `Lid closed isn't set up (${this.get().lidSetup ?? 'Amphetamine'}); using Awake.`
    }
    this.state = { ...this.state, mode, scope, sessionId: scope === 'session' ? sessionId : null, note }
    await this.apply()
    return this.get()
  }

  /** Call whenever sessions change; handles auto-off. */
  sessionsChanged(sessions: Session[]): void {
    const running = new Set(sessions.filter((s) => s.alive && (s.state === 'running' || s.state === 'waiting')).map((s) => s.id))
    if (this.state.mode !== 'off') {
      const inScope = (id: string) => this.state.scope === 'all' || id === this.state.sessionId
      const stopped = [...this.wasRunning].some((id) => inScope(id) && !running.has(id))
      const anyRunning = [...running].some(inScope)
      const gone = this.state.scope === 'session' && !sessions.some((s) => s.id === this.state.sessionId)
      if (gone || (stopped && !anyRunning)) {
        this.state = { ...this.state, mode: 'off', note: 'Turned off: the session stopped.' }
        void this.apply()
      }
    }
    this.wasRunning = running
  }

  async stop(): Promise<void> {
    this.state.mode = 'off'
    await this.apply()
  }

  private onPowerChange(): void {
    if (this.state.mode === 'lid' && !this.get().lidAvailable) {
      this.state = { ...this.state, mode: 'on', note: 'Power disconnected; switched to Awake.' }
      void this.apply()
      new Notification({ title: 'Workbench', body: 'Lid-closed keep-awake is off: power disconnected. The Mac stays awake while open.' }).show()
    } else {
      this.changed(this.get())
    }
  }

  /** Serialized: Amphetamine calls are async and must not interleave. */
  private apply(): Promise<void> {
    this.queue = this.queue.then(() => this.applyNow()).catch(() => {})
    return this.queue
  }

  private async applyNow(): Promise<void> {
    const wantBlocker = this.state.mode !== 'off'
    if (wantBlocker && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!wantBlocker && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
    const via = this.state.mode === 'lid' ? this.get().lidVia : null

    if (via === 'amphetamine' && !this.deps.owned.get()) {
      try {
        if (await amphetamineActive()) {
          const ok = await this.deps.confirm(
            'Replace the running Amphetamine session?',
            'Amphetamine already has a session that Workbench didn\'t start (perhaps a Trigger). Starting the lid-closed session ends it.',
          )
          if (!ok) {
            this.state = { ...this.state, mode: 'on', note: 'Kept your Amphetamine session; using Awake.' }
            return this.changed(this.get())
          }
        }
        await amphetamineStart()
        this.deps.owned.set(true)
      } catch (e) {
        this.state = { ...this.state, mode: 'on', note: `Amphetamine didn't start: ${(e as Error).message.slice(0, 100)}. Using Awake.` }
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
