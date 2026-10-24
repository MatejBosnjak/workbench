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
  `
  ALTER TABLE sessions ADD COLUMN first_prompt TEXT;
  CREATE TABLE links (
    session_id TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    via        TEXT NOT NULL,
    created_by TEXT NOT NULL, -- auto | manual
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, task_id)
  );
  CREATE INDEX links_task ON links (task_id);
  -- A link removed by hand stays removed: inference won't add it back.
  CREATE TABLE link_tombstones (
    session_id TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    PRIMARY KEY (session_id, task_id)
  );
  CREATE TABLE summaries (
    session_id TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- A conversation marked seen stays quiet until a message newer than this one arrives.
  CREATE TABLE seen (
    thread_key           TEXT PRIMARY KEY,
    last_seen_message_id TEXT NOT NULL,
    seen_at              INTEGER NOT NULL
  );
  CREATE TABLE drafts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    target     TEXT NOT NULL, -- JSON DraftTarget
    body       TEXT NOT NULL,
    status     TEXT NOT NULL, -- drafting | ready | sending | sent | failed
    error      TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- A fork's first start resumes this claude session with --fork-session.
  ALTER TABLE sessions ADD COLUMN fork_from TEXT;
  CREATE TABLE notes (
    workstream_id TEXT PRIMARY KEY, -- the root task id
    body          TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  `,
  `
  -- Set by a rename or a task start; claude's terminal title no longer replaces it.
  ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- PRs connected by hand (a link suggestion or a picker): to the session that opened them, and to a task even when
  -- the PR's branch and description don't name it.
  CREATE TABLE session_prs (
    session_id TEXT NOT NULL,
    pr_url     TEXT NOT NULL,
    label      TEXT NOT NULL,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, pr_url)
  );
  CREATE TABLE pr_tasks (
    pr_url     TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pr_url, task_id)
  );
  -- Link suggestions turned down with ×: never offered again for that session.
  CREATE TABLE suggest_dismissed (
    session_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    PRIMARY KEY (session_id, key)
  );
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
