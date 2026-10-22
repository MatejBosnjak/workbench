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
}

interface RawSession {
  id: string
  cwd: string
  title: string
  state: SessionState
  external: number
  started_at: number
  last_event_at: number
}

const fromRaw = (r: RawSession): SessionRow => ({
  id: r.id,
  cwd: r.cwd,
  title: r.title,
  state: r.state,
  external: r.external === 1,
  startedAt: r.started_at,
  lastEventAt: r.last_event_at,
})

export class Repo {
  constructor(private db: Db) {}

  openTabs(): SessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE tab_order IS NOT NULL ORDER BY tab_order')
      .all() as RawSession[]
    return rows.map(fromRaw)
  }

  insertTab(s: SessionRow): void {
    const next = this.db.prepare('SELECT COALESCE(MAX(tab_order), -1) + 1 AS n FROM sessions').get() as { n: number }
    this.db
      .prepare(
        `INSERT INTO sessions (id, cwd, title, state, external, started_at, last_event_at, tab_order)
         VALUES (@id, @cwd, @title, @state, @external, @startedAt, @lastEventAt, @tabOrder)
         ON CONFLICT(id) DO UPDATE SET tab_order = excluded.tab_order`,
      )
      .run({ ...s, external: s.external ? 1 : 0, tabOrder: next.n })
  }

  update(id: string, patch: Partial<Pick<SessionRow, 'title' | 'state' | 'lastEventAt'>>): void {
    const cols: Record<string, string> = { title: 'title', state: 'state', lastEventAt: 'last_event_at' }
    const sets = Object.keys(patch).map((k) => `${cols[k]} = @${k}`)
    if (sets.length === 0) return
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`).run({ id, ...patch })
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
}
