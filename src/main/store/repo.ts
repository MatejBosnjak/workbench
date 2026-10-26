import type { Draft, DraftTarget } from '@shared/git'
import type { SessionPrLink } from '@shared/tasks'
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
  forkFrom?: string | null
  titleLocked?: boolean
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
  forkFrom: 'fork_from',
  titleLocked: 'title_locked',
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
  fork_from: string | null
  title_locked: number
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
  forkFrom: r.fork_from,
  titleLocked: r.title_locked === 1,
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
        `INSERT INTO sessions (id, cwd, title, state, external, started_at, last_event_at, claude_id, transcript_path, model, effort, permission_mode, fork_from, tab_order)
         VALUES (@id, @cwd, @title, @state, @external, @startedAt, @lastEventAt, @claudeId, @transcriptPath, @model, @effort, @permissionMode, @forkFrom, @tabOrder)
         ON CONFLICT(id) DO UPDATE SET tab_order = excluded.tab_order`,
      )
      .run({ ...s, forkFrom: s.forkFrom ?? null, external: s.external ? 1 : 0, tabOrder: this.nextOrder() })
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

  // --- links ---

  /** Adds a link unless it exists, or was removed by hand (for auto links). Returns whether it was added. */
  addLink(sessionId: string, taskId: string, via: string, createdBy: 'auto' | 'manual'): boolean {
    if (createdBy === 'auto' && this.db.prepare('SELECT 1 FROM link_tombstones WHERE session_id = ? AND task_id = ?').get(sessionId, taskId)) return false
    if (createdBy === 'manual') this.db.prepare('DELETE FROM link_tombstones WHERE session_id = ? AND task_id = ?').run(sessionId, taskId)
    const r = this.db
      .prepare('INSERT OR IGNORE INTO links (session_id, task_id, via, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, taskId, via, createdBy, Date.now())
    return r.changes > 0
  }

  removeLink(sessionId: string, taskId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM links WHERE session_id = ? AND task_id = ?').run(sessionId, taskId)
      this.db.prepare('INSERT OR IGNORE INTO link_tombstones (session_id, task_id) VALUES (?, ?)').run(sessionId, taskId)
    })()
  }

  links(): { sessionId: string; taskId: string; via: string; createdBy: 'auto' | 'manual'; createdAt: number; session: (SessionRow & { open: boolean; firstPrompt: string | null }) | null }[] {
    const rows = this.db
      .prepare(
        `SELECT l.session_id, l.task_id, l.via, l.created_by, l.created_at, s.*
         FROM links l LEFT JOIN sessions s ON s.id = l.session_id ORDER BY l.created_at`,
      )
      .all() as (RawSession & { session_id: string; task_id: string; via: string; created_by: 'auto' | 'manual'; created_at: number; first_prompt: string | null })[]
    return rows.map((r) => ({
      sessionId: r.session_id,
      taskId: r.task_id,
      via: r.via,
      createdBy: r.created_by,
      createdAt: r.created_at,
      session: r.id ? { ...fromRaw(r), open: r.tab_order !== null, firstPrompt: r.first_prompt } : null,
    }))
  }

  /** Keeps the session's first prompt, for the task preview. */
  notePrompt(id: string, prompt: string): void {
    this.db.prepare('UPDATE sessions SET first_prompt = ? WHERE id = ? AND first_prompt IS NULL').run(prompt.slice(0, 500), id)
  }

  // --- summaries ---

  summaries(): Record<string, { text: string; createdAt: number }> {
    const rows = this.db.prepare('SELECT session_id, text, created_at FROM summaries').all() as { session_id: string; text: string; created_at: number }[]
    return Object.fromEntries(rows.map((r) => [r.session_id, { text: r.text, createdAt: r.created_at }]))
  }

  setSummary(sessionId: string, text: string, model: string): void {
    this.db
      .prepare('INSERT INTO summaries (session_id, text, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, model = excluded.model, created_at = excluded.created_at')
      .run(sessionId, text, model, Date.now())
  }

  // --- PR links made by hand ---

  addSessionPr(sessionId: string, pr: { url: string; label: string; title: string }): void {
    this.db.prepare('DELETE FROM suggest_dismissed WHERE session_id = ? AND key = ?').run(sessionId, `pr:${pr.url}`)
    this.db.prepare('INSERT OR IGNORE INTO session_prs (session_id, pr_url, label, title, created_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, pr.url, pr.label, pr.title, Date.now())
  }

  /** Takes a PR off a session however it got there (by hand, Run app, a linked task) and stops it being suggested again. */
  unlinkSessionPr(sessionId: string, url: string): void {
    this.db.prepare('DELETE FROM session_prs WHERE session_id = ? AND pr_url = ?').run(sessionId, url)
    this.dismissSuggestion(sessionId, `pr:${url}`)
  }

  /** PRs unlinked from sessions. */
  hiddenPrs(): { sessionId: string; url: string }[] {
    const rows = this.db.prepare("SELECT session_id, key FROM suggest_dismissed WHERE key LIKE 'pr:%'").all() as { session_id: string; key: string }[]
    return rows.map((r) => ({ sessionId: r.session_id, url: r.key.slice(3) }))
  }

  sessionPrs(): SessionPrLink[] {
    const rows = this.db.prepare('SELECT session_id, pr_url, label, title FROM session_prs ORDER BY created_at').all() as { session_id: string; pr_url: string; label: string; title: string }[]
    return rows.map((r) => ({ sessionId: r.session_id, url: r.pr_url, label: r.label, title: r.title }))
  }

  addPrTask(prUrl: string, taskId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO pr_tasks (pr_url, task_id, created_at) VALUES (?, ?, ?)').run(prUrl, taskId, Date.now())
  }

  /** Task ids by PR URL. */
  prTasks(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const r of this.db.prepare('SELECT pr_url, task_id FROM pr_tasks').all() as { pr_url: string; task_id: string }[]) out.set(r.pr_url, [...(out.get(r.pr_url) ?? []), r.task_id])
    return out
  }

  dismissSuggestion(sessionId: string, key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO suggest_dismissed (session_id, key) VALUES (?, ?)').run(sessionId, key)
  }

  isDismissed(sessionId: string, key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM suggest_dismissed WHERE session_id = ? AND key = ?').get(sessionId, key)
  }

  // --- seen conversations ---

  seen(): Record<string, string> {
    const rows = this.db.prepare('SELECT thread_key, last_seen_message_id FROM seen').all() as { thread_key: string; last_seen_message_id: string }[]
    return Object.fromEntries(rows.map((r) => [r.thread_key, r.last_seen_message_id]))
  }

  markSeen(key: string, messageId: string): void {
    this.db
      .prepare('INSERT INTO seen (thread_key, last_seen_message_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(thread_key) DO UPDATE SET last_seen_message_id = excluded.last_seen_message_id, seen_at = excluded.seen_at')
      .run(key, messageId, Date.now())
  }

  // --- drafts ---

  /** Drafts not sent yet, plus ones sent in the last day. */
  drafts(): Draft[] {
    const rows = this.db
      .prepare("SELECT * FROM drafts WHERE status != 'sent' OR created_at > ? ORDER BY created_at DESC")
      .all(Date.now() - 86_400_000) as { id: number; target: string; body: string; status: Draft['status']; error: string | null; created_at: number }[]
    return rows.map((r) => ({ id: r.id, target: JSON.parse(r.target) as DraftTarget, body: r.body, status: r.status, error: r.error, createdAt: r.created_at }))
  }

  draft(id: number): Draft | null {
    return this.drafts().find((d) => d.id === id) ?? null
  }

  addDraft(target: DraftTarget, body: string, status: Draft['status']): number {
    return Number(this.db.prepare('INSERT INTO drafts (target, body, status, created_at) VALUES (?, ?, ?, ?)').run(JSON.stringify(target), body, status, Date.now()).lastInsertRowid)
  }

  updateDraft(id: number, patch: { body?: string; status?: Draft['status']; error?: string | null }): void {
    const cur = this.draft(id)
    if (!cur) return
    this.db.prepare('UPDATE drafts SET body = ?, status = ?, error = ? WHERE id = ?').run(patch.body ?? cur.body, patch.status ?? cur.status, patch.error === undefined ? cur.error : patch.error, id)
  }

  deleteDraft(id: number): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }

  // --- workstream notes ---

  note(workstreamId: string): string {
    return (this.db.prepare('SELECT body FROM notes WHERE workstream_id = ?').get(workstreamId) as { body: string } | undefined)?.body ?? ''
  }

  setNote(workstreamId: string, body: string): void {
    this.db
      .prepare('INSERT INTO notes (workstream_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(workstream_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
      .run(workstreamId, body, Date.now())
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
