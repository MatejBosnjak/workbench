import Database from 'better-sqlite3'

export type Db = Database.Database

// Append-only. Each entry runs once, in order; user_version tracks how far we got.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    cwd             TEXT NOT NULL,
    transcript_path TEXT,
    started_at      INTEGER NOT NULL,
    last_event_at   INTEGER NOT NULL,
    state           TEXT NOT NULL DEFAULT 'idle',
    external        INTEGER NOT NULL DEFAULT 0,
    title           TEXT NOT NULL,
    tab_order       INTEGER -- NULL once the tab is closed
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL -- JSON
  );
  `,
  `
  -- claude's own session id; differs from id after /clear, and for external sessions equals it.
  ALTER TABLE sessions ADD COLUMN claude_id TEXT;
  ALTER TABLE sessions ADD COLUMN model TEXT;
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
  CREATE INDEX sessions_claude_id ON sessions (claude_id);
  `,
]

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
