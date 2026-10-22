import { spawn, type ChildProcess } from 'node:child_process'
import { Notification, powerMonitor, powerSaveBlocker, screen } from 'electron'
import type { CaffeinateState, Session } from '@shared/types'

/**
 * Keeps the Mac awake while sessions run.
 * - on:  Electron's prevent-app-suspension blocker.
 * - lid: also `caffeinate -s`, which only holds on AC power. macOS still sleeps on lid close
 *        unless it can run in clamshell mode, so this needs an external display too.
 * Turns itself off when a scoped session stops running.
 */
export class Caffeinate {
  private state: CaffeinateState = { mode: 'off', scope: 'session', sessionId: null, lidAvailable: false, note: null }
  private blocker: number | null = null
  private child: ChildProcess | null = null
  private wasRunning = new Set<string>()

  constructor(private changed: (s: CaffeinateState) => void) {
    powerMonitor.on('on-battery', () => this.onPowerChange())
    powerMonitor.on('on-ac', () => this.onPowerChange())
    screen.on('display-added', () => this.onPowerChange())
    screen.on('display-removed', () => this.onPowerChange())
    this.state.lidAvailable = lidAvailable()
  }

  get(): CaffeinateState {
    return { ...this.state, lidAvailable: lidAvailable() }
  }

  set(mode: CaffeinateState['mode'], scope: CaffeinateState['scope'], sessionId: string | null): CaffeinateState {
    let note: string | null = null
    if (mode === 'lid' && !lidAvailable()) {
      mode = 'on'
      note = 'Lid closed needs power and an external display; using Awake.'
    }
    this.state = { ...this.state, mode, scope, sessionId: scope === 'session' ? sessionId : null, note }
    this.apply()
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
        this.apply()
      }
    }
    this.wasRunning = running
  }

  stop(): void {
    this.state.mode = 'off'
    this.apply()
  }

  private onPowerChange(): void {
    if (this.state.mode === 'lid' && !lidAvailable()) {
      this.state = { ...this.state, mode: 'on', note: 'Power or display disconnected; switched to Awake.' }
      this.apply()
      new Notification({ title: 'Workbench', body: 'Lid-closed keep-awake is off: power or display disconnected. The Mac stays awake while open.' }).show()
    } else {
      this.changed(this.get())
    }
  }

  private apply(): void {
    const wantBlocker = this.state.mode !== 'off'
    if (wantBlocker && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!wantBlocker && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
    const wantChild = this.state.mode === 'lid'
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

function lidAvailable(): boolean {
  return !powerMonitor.isOnBatteryPower() && screen.getAllDisplays().some((d) => !d.internal)
}
