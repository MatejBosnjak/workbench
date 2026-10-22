import type { SessionState } from '@shared/types'
import type { Db } from './db'

export interface SessionRow {
  id: string
  cwd: string
  title: string
  state: SessionState
  external: boolean
  startedAt: number
  lastEventAt: number
  claudeId: string | null
  transcriptPath: string | null
  model: string | null
  effort: string | null
  permissionMode: string | null
}

type Patch = Partial<Omit<SessionRow, 'id' | 'startedAt'>>

const COLUMNS: Record<keyof Patch, string> = {
  cwd: 'cwd',
  title: 'title',
  state: 'state',
  external: 'external',
  lastEventAt: 'last_event_at',
  claudeId: 'claude_id',
  transcriptPath: 'transcript_path',
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission_mode',
}

interface RawSession {
  id: string
  cwd: string
  title: string
  state: SessionState
  external: number
  started_at: number
  last_event_at: number
  claude_id: string | null
  transcript_path: string | null
  model: string | null
  effort: string | null
  permission_mode: string | null
  tab_order: number | null
}

const fromRaw = (r: RawSession): SessionRow => ({
  id: r.id,
  cwd: r.cwd,
  title: r.title,
  state: r.state,
  external: r.external === 1,
  startedAt: r.started_at,
  lastEventAt: r.last_event_at,
  claudeId: r.claude_id,
  transcriptPath: r.transcript_path,
  model: r.model,
  effort: r.effort,
  permissionMode: r.permission_mode,
})

export class Repo {
  constructor(private db: Db) {}

  openTabs(): SessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE tab_order IS NOT NULL ORDER BY tab_order')
      .all() as RawSession[]
    return rows.map(fromRaw)
  }

  /** Closed tabs, most recent first. */
  recent(limit = 30): { id: string; title: string; cwd: string; lastEventAt: number }[] {
    return (
      this.db
        .prepare('SELECT id, title, cwd, last_event_at FROM sessions WHERE tab_order IS NULL ORDER BY last_event_at DESC LIMIT ?')
        .all(limit) as { id: string; title: string; cwd: string; last_event_at: number }[]
    ).map((r) => ({ id: r.id, title: r.title, cwd: r.cwd, lastEventAt: r.last_event_at }))
  }

  /** Any session, open tab or not. */
  get(id: string): (SessionRow & { open: boolean }) | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSession | undefined
    return r ? { ...fromRaw(r), open: r.tab_order !== null } : null
  }

  findByClaudeId(claudeId: string): (SessionRow & { open: boolean }) | null {
    // An open tab wins over an older closed row that once had the same claude id.
    const r = this.db
      .prepare('SELECT * FROM sessions WHERE claude_id = ? OR id = ? ORDER BY tab_order IS NULL, last_event_at DESC LIMIT 1')
      .get(claudeId, claudeId) as RawSession | undefined
    return r ? { ...fromRaw(r), open: r.tab_order !== null } : null
  }

  /** Adds the session as the last tab, or reopens it there if it already exists. */
  insertTab(s: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, cwd, title, state, external, started_at, last_event_at, claude_id, transcript_path, model, effort, permission_mode, tab_order)
         VALUES (@id, @cwd, @title, @state, @external, @startedAt, @lastEventAt, @claudeId, @transcriptPath, @model, @effort, @permissionMode, @tabOrder)
         ON CONFLICT(id) DO UPDATE SET tab_order = excluded.tab_order`,
      )
      .run({ ...s, external: s.external ? 1 : 0, tabOrder: this.nextOrder() })
  }

  reopenTab(id: string): void {
    this.db.prepare('UPDATE sessions SET tab_order = ? WHERE id = ? AND tab_order IS NULL').run(this.nextOrder(), id)
  }

  update(id: string, patch: Patch): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof Patch, unknown][]
    if (entries.length === 0) return
    const params: Record<string, unknown> = { id }
    for (const [k, v] of entries) params[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v
    const sets = entries.map(([k]) => `${COLUMNS[k]} = @${k}`)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  closeTab(id: string): void {
    this.db.prepare('UPDATE sessions SET tab_order = NULL WHERE id = ?').run(id)
  }

  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE sessions SET tab_order = ? WHERE id = ?')
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))()
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : fallback
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  private nextOrder(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(tab_order), -1) + 1 AS n FROM sessions').get() as { n: number }).n
  }
}
