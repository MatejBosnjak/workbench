import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { WebContents } from 'electron'
import type { AgentSettings, ApplyResult } from '@shared/agent'
import type { Session, SessionStatus, StatusSnapshot, Usage } from '@shared/types'
import { PtyHost } from './pty-host'
import { shellEnv, which } from './shell-env'
import type { HookPayload, Signal, StatuslinePayload } from './signal-server'
import { nextState, stateAfterInput } from './state'
import type { Repo, SessionRow } from './store/repo'

export const DEFAULT_CWD = join(homedir(), 'Productive/work')

export interface SessionEvents {
  sessionsChanged(): void
  statusChanged(): void
  /** A hook event was applied to a tab (after its state changed). */
  hook?(id: string, event: string, payload: HookPayload): void
  /** Terminal output of a Workbench tab. */
  output?(id: string, data: string): void
}

export class Sessions {
  private pty: PtyHost
  private status = new Map<string, SessionStatus>()
  private usage: Usage | null
  // External sessions have no pty; they're alive between SessionStart and SessionEnd.
  private externalAlive = new Set<string>()
  // Respawns in progress; their exit isn't a real exit.
  private restarting = new Set<string>()
  // External sessions to resume here once their terminal copy exits.
  private takeOvers = new Set<string>()
  // Sessions with picker changes made mid-turn; they restart when the turn ends.
  private pending = new Set<string>()
  // Text to type into claude's prompt once it's ready (sessions started from a task).
  private prefill = new Map<string, { text: string; seen: string; timer?: NodeJS.Timeout; until: number; tries: number }>()

  constructor(
    private repo: Repo,
    private events: SessionEvents,
  ) {
    this.usage = repo.getSetting<Usage | null>('usage', null)
    this.pty = new PtyHost(
      (id, code) => {
        if (this.restarting.has(id)) return
        this.repo.update(id, { state: code === 0 ? 'idle' : 'failed', lastEventAt: Date.now() })
        this.events.sessionsChanged()
      },
      (id, data) => {
        const row = this.repo.get(id)
        const state = row && stateAfterInput(row.state, data)
        if (!state) return
        this.repo.update(id, { state })
        this.events.sessionsChanged()
      },
      (id, data) => {
        this.events.output?.(id, data)
        this.prefillOnOutput(id, data)
      },
    )
  }

  list(): Session[] {
    return this.repo.openTabs().map((r) => this.toSession(r))
  }

  get(id: string): Session | null {
    const r = this.repo.get(id)
    return r ? this.toSession(r) : null
  }

  statusSnapshot(): StatusSnapshot {
    return { sessions: Object.fromEntries(this.status), usage: this.usage }
  }

  /** A new tab that starts as a copy of another session's conversation (claude --fork-session). */
  fork(sourceId: string): Session | null {
    const src = this.repo.get(sourceId)
    if (!src) return null
    const s = this.create({ cwd: src.cwd, model: src.model, effort: src.effort, permissionMode: src.permissionMode, forkFrom: src.claudeId ?? src.id })
    this.setTitle(s.id, `${src.title} (fork)`, !src.titleLocked)
    return this.get(s.id)
  }

  create(opts: { cwd?: string; model?: string | null; effort?: string | null; permissionMode?: string | null; forkFrom?: string } = {}): Session {
    const cwd = opts.cwd ?? this.repo.getSetting('defaultCwd', DEFAULT_CWD)
    const defaults = this.defaults()
    const now = Date.now()
    const row: SessionRow = {
      id: randomUUID(),
      cwd,
      title: basename(cwd),
      state: 'idle',
      external: false,
      startedAt: now,
      lastEventAt: now,
      claudeId: null,
      transcriptPath: null,
      model: opts.model !== undefined ? opts.model : defaults.model,
      effort: opts.effort !== undefined ? opts.effort : defaults.effort,
      permissionMode: opts.permissionMode !== undefined ? opts.permissionMode : defaults.permissionMode,
      forkFrom: opts.forkFrom ?? null,
    }
    this.repo.insertTab(row)
    this.events.sessionsChanged()
    return this.toSession(row)
  }

  /**
   * Types `text` into the session's prompt (without Enter) once claude has drawn its input box, then checks the
   * text showed up and types it once more if it didn't: early keystrokes can be dropped while claude starts.
   * While claude shows the "trust this folder?" question it waits for your answer.
   */
  prefillPrompt(id: string, text: string): void {
    this.prefill.set(id, { text, seen: '', until: Date.now() + 5 * 60_000, tries: 0 })
  }

  private prefillOnOutput(id: string, data: string): void {
    const p = this.prefill.get(id)
    if (!p) return
    if (Date.now() > p.until) return void this.prefill.delete(id)
    p.seen = (p.seen + data).slice(-8000)
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => this.prefillStep(id), 400)
  }

  private prefillStep(id: string): void {
    const p = this.prefill.get(id)
    if (!p) return
    // eslint-disable-next-line no-control-regex
    const screen = p.seen.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '')
    if (/trust this folder|Do you trust|safety check/i.test(screen)) {
      p.seen = ''
      return
    }
    if (p.tries > 0 && screen.replace(/\s+/g, ' ').includes(p.text.trim().slice(0, 24))) return void this.prefill.delete(id)
    // Claude's input box: its prompt arrow, the "Try …" placeholder, or the mode line under it.
    if (!/❯|Try "|for shortcuts|shift\+tab to cycle|bypass permissions/i.test(screen)) return
    if (p.tries >= 2) return void this.prefill.delete(id)
    p.tries++
    p.seen = ''
    this.pty.write(id, p.tries === 1 ? p.text : `\x15${p.text}`)
    // No echo within a few seconds means it was dropped; the next output (or this timer) tries again.
    p.timer = setTimeout(() => this.prefillStep(id), 2500)
  }

  defaults(): AgentSettings {
    return this.repo.getSetting<AgentSettings>('sessionDefaults', { model: null, effort: null, permissionMode: 'bypassPermissions' })
  }

  setDefaults(d: AgentSettings): void {
    this.repo.setSetting('sessionDefaults', d)
  }

  /**
   * Applies picker changes to a session by restarting it with --resume and the new flags.
   * Typing /model or /effort into the session would also rewrite the user's global defaults
   * in ~/.claude/settings.json, so the picker never does that.
   */
  async configure(id: string, change: Partial<AgentSettings>): Promise<ApplyResult> {
    const row = this.repo.get(id)
    if (!row || row.external) return 'saved'
    this.repo.update(id, change)
    this.events.sessionsChanged()
    if (!this.pty.has(id)) return 'saved'
    if (row.state === 'running') {
      this.pending.add(id)
      return 'pending'
    }
    return this.restart(id)
  }

  /** Respawns the session in place with --resume and the row's current flags. */
  private async restart(id: string): Promise<ApplyResult> {
    const info = this.pty.info(id)
    if (!info?.wc) return 'saved'
    // The old statusline data no longer applies; the picker falls back to the new flags until it refreshes.
    this.status.delete(id)
    this.events.statusChanged()
    this.restarting.add(id)
    try {
      await this.pty.killAndWait(id)
    } finally {
      this.restarting.delete(id)
    }
    await this.open(id, info.size, info.wc)
    return 'restarted'
  }

  isAlive(id: string): boolean {
    return this.pty.has(id)
  }

  async open(id: string, size: { cols: number; rows: number }, wc: WebContents): Promise<void> {
    if (!this.pty.has(id)) {
      const row = this.repo.get(id)
      if (!row || row.external) return
      const env = await shellEnv()
      const claude = which('claude', env)
      if (!claude) throw new Error('claude not found on the login shell PATH')
      const claudeId = row.claudeId ?? row.id
      // A session that never got a prompt has no transcript, and --resume would fail on it.
      const args = hasTranscript(claudeId)
        ? ['--resume', claudeId]
        : row.forkFrom
          ? ['--resume', row.forkFrom, '--fork-session', '--session-id', row.id]
          : ['--session-id', row.id]
      if (row.model) args.push('--model', row.model)
      if (row.effort) args.push('--effort', row.effort)
      if (row.permissionMode) args.push('--permission-mode', row.permissionMode)
      // Development: hooks installed into a scratch settings file reach Workbench's own sessions.
      if (process.env.WORKBENCH_CLAUDE_SETTINGS) args.push('--settings', process.env.WORKBENCH_CLAUDE_SETTINGS)
      this.pty.spawn(id, {
        file: claude,
        args,
        cwd: existsSync(row.cwd) ? row.cwd : homedir(),
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WORKBENCH_SESSION_ID: id },
        ...size,
      })
      this.repo.update(id, { state: 'idle', lastEventAt: Date.now() })
      this.events.sessionsChanged()
    }
    this.pty.attach(id, wc)
  }

  /** Types into the session's pty, as if from the keyboard. */
  write(id: string, data: string): boolean {
    return this.pty.write(id, data)
  }

  /** Kills the pty and resolves once it has exited. */
  stop(id: string): Promise<void> {
    return this.pty.killAndWait(id)
  }

  update(id: string, patch: Partial<Pick<SessionRow, 'model' | 'effort' | 'permissionMode' | 'external'>>): void {
    this.repo.update(id, patch)
    this.events.sessionsChanged()
  }

  recent() {
    return this.repo.recent()
  }

  reopen(id: string): void {
    this.repo.reopenTab(id)
    this.events.sessionsChanged()
  }

  takeOver(id: string): 'now' | 'waiting' {
    const row = this.repo.get(id)
    if (!row?.external) return 'now'
    if (this.externalAlive.has(id)) {
      this.takeOvers.add(id)
      this.events.sessionsChanged()
      return 'waiting'
    }
    this.adopt(id)
    return 'now'
  }

  cancelTakeOver(id: string): void {
    this.takeOvers.delete(id)
    this.events.sessionsChanged()
  }

  /** Turns an external session into a Workbench one; opening it resumes it with --resume. */
  private adopt(id: string): void {
    this.takeOvers.delete(id)
    this.externalAlive.delete(id)
    const d = this.defaults()
    this.repo.update(id, { external: false, state: 'idle', ...d })
    this.events.sessionsChanged()
  }

  close(id: string): void {
    // SIGHUP, then SIGKILL if it's still there after 5s, so a stuck process can't keep its pty and history alive.
    void this.pty.killAndWait(id)
    this.repo.closeTab(id)
    this.status.delete(id)
    this.events.sessionsChanged()
  }

  /** A manual title sticks; an auto one (claude's terminal title) only applies until then. Clearing a manual title unlocks it. */
  setTitle(id: string, title: string, auto = false): void {
    title = title.trim()
    if (auto) {
      if (!title || this.repo.get(id)?.titleLocked) return
      this.repo.update(id, { title })
    } else {
      this.repo.update(id, title ? { title, titleLocked: true } : { titleLocked: false })
    }
    this.events.sessionsChanged()
  }

  reorder(ids: string[]): void {
    this.repo.reorder(ids)
    this.events.sessionsChanged()
  }

  shutdown(): void {
    this.pty.killAll()
  }

  /** Session ptys, for the memory overview. */
  processes(): { id: string; pid: number; historyChars: number }[] {
    return this.pty.processes()
  }

  handleSignal(sig: Signal): void {
    const p = sig.payload
    const row = this.resolve(sig.wbId, p.session_id, sig.kind === 'hook' ? (p as HookPayload).hook_event_name : null, p.cwd)
    if (!row) return
    const patch: Parameters<Repo['update']>[1] = { claudeId: p.session_id, lastEventAt: Date.now() }
    if (p.transcript_path) patch.transcriptPath = p.transcript_path

    if (sig.kind === 'hook') {
      const event = sig.payload.hook_event_name
      const state = nextState(row.state, event)
      if (state) patch.state = state
      const wasAlive = this.externalAlive.has(row.id)
      if (row.external) {
        if (event === 'SessionEnd') this.externalAlive.delete(row.id)
        else this.externalAlive.add(row.id)
      }
      if (row.external && event === 'SessionEnd' && this.takeOvers.has(row.id)) {
        this.repo.update(row.id, patch)
        this.adopt(row.id)
        return
      }
      if (event === 'SessionStart' && row.cwd !== p.cwd) patch.cwd = p.cwd
      if (sig.payload.permission_mode) this.status.set(row.id, { ...this.status.get(row.id), permissionMode: sig.payload.permission_mode })
      this.repo.update(row.id, patch)
      // Most events (every tool call) change nothing the tab list shows; only state, place or identity changes go out.
      const shown =
        (patch.state && patch.state !== row.state) ||
        (patch.cwd && patch.cwd !== row.cwd) ||
        row.claudeId !== p.session_id ||
        (p.transcript_path && p.transcript_path !== row.transcriptPath) ||
        wasAlive !== this.externalAlive.has(row.id)
      if (shown) this.events.sessionsChanged()
      this.events.hook?.(row.id, event, sig.payload)
      if (event === 'Stop' && this.pending.delete(row.id)) void this.restart(row.id)
    } else {
      this.repo.update(row.id, patch)
      this.applyStatusline(row.id, sig.payload)
      if (row.external) this.externalAlive.add(row.id)
    }
  }

  /** Finds the tab a signal belongs to; creates an external tab for sessions started elsewhere. */
  private resolve(wbId: string | null, claudeId: string, event: string | null, cwd: string): (SessionRow & { open: boolean }) | null {
    if (wbId) {
      const row = this.repo.get(wbId)
      return row?.open ? row : null
    }
    const row = this.repo.findByClaudeId(claudeId)
    if (row) {
      if (!row.open && row.external && (event === 'SessionStart' || event === 'UserPromptSubmit')) this.repo.reopenTab(row.id)
      return row.open || row.external ? { ...row, open: true } : null
    }
    if (event === 'SessionEnd') return null
    const now = Date.now()
    const ext: SessionRow = {
      id: claudeId,
      cwd,
      title: basename(cwd),
      state: 'idle',
      external: true,
      startedAt: now,
      lastEventAt: now,
      claudeId,
      transcriptPath: null,
      model: null,
      effort: null,
      permissionMode: null,
    }
    this.repo.insertTab(ext)
    return { ...ext, open: true }
  }

  private applyStatusline(id: string, p: StatuslinePayload): void {
    // What claude picks when it's started without --model / --effort: remembered so the picker can show it.
    const row = this.repo.get(id)
    if (row && !row.model && p.model?.id) this.remember({ modelId: p.model.id, model: p.model.display_name })
    if (row && !row.effort && p.effort?.level) this.remember({ effort: p.effort.level })
    this.status.set(id, {
      ...this.status.get(id),
      model: p.model?.display_name,
      modelId: p.model?.id,
      effort: p.effort?.level,
      contextPct: p.context_window?.used_percentage ?? null,
      contextSize: p.context_window?.context_window_size,
      name: p.session_name,
    })
    const five = p.rate_limits?.five_hour
    const week = p.rate_limits?.seven_day
    if (five || week) {
      this.usage = {
        fiveHour: five?.used_percentage != null ? { pct: five.used_percentage, resetsAt: five.resets_at } : this.usage?.fiveHour,
        sevenDay: week?.used_percentage != null ? { pct: week.used_percentage, resetsAt: week.resets_at } : this.usage?.sevenDay,
        at: Date.now(),
      }
      this.repo.setSetting('usage', this.usage)
    }
    this.events.statusChanged()
  }

  private remember(seen: { modelId?: string; model?: string; effort?: string }): void {
    const cur = this.repo.getSetting<Record<string, string>>('claudeDefaultsSeen', {})
    const next = { ...cur, ...seen }
    if (JSON.stringify(next) !== JSON.stringify(cur)) this.repo.setSetting('claudeDefaultsSeen', next)
  }

  /**
   * What a session started without flags really runs: Workbench's own defaults first, then the global Claude
   * settings (read only), then what such a session last reported.
   */
  resolvedDefaults(): { model: string | null; modelId: string | null; effort: string | null; permissionMode: string | null } {
    const d = this.defaults()
    const seen = this.repo.getSetting<{ modelId?: string; effort?: string }>('claudeDefaultsSeen', {})
    let global: { model?: string; effortLevel?: string; permissions?: { defaultMode?: string } } = {}
    try {
      global = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as typeof global
    } catch {
      // no global settings
    }
    return {
      model: d.model ?? global.model ?? null,
      modelId: d.model || global.model ? null : (seen.modelId ?? null),
      effort: d.effort ?? global.effortLevel ?? seen.effort ?? null,
      permissionMode: d.permissionMode ?? global.permissions?.defaultMode ?? null,
    }
  }

  private toSession(r: SessionRow): Session {
    const { claudeId: _c, transcriptPath: _t, titleLocked: _l, ...rest } = r
    return {
      ...rest,
      alive: r.external ? this.externalAlive.has(r.id) : this.pty.has(r.id),
      takeOver: this.takeOvers.has(r.id) || undefined,
    }
  }
}

function hasTranscript(id: string): boolean {
  const root = join(homedir(), '.claude', 'projects')
  try {
    return readdirSync(root).some((dir) => existsSync(join(root, dir, `${id}.jsonl`)))
  } catch {
    return false
  }
}
