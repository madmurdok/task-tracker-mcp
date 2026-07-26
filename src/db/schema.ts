export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  design_doc_path TEXT,
  design_doc_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_epics_project_id ON epics(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_epics_project_name ON epics(project_id, name);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released')),
  sequence INTEGER NOT NULL,
  release_notes TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_releases_project_id ON releases(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_project_version ON releases(project_id, version);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  owner_session_id TEXT,
  lock_expires_at TEXT,
  complexity_hint TEXT NOT NULL DEFAULT 'normal' CHECK (complexity_hint IN ('normal', 'high')),
  cancellation_reason TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  completion_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_files (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS handoff_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  decisions TEXT NOT NULL DEFAULT '',
  remaining_work TEXT NOT NULL DEFAULT '',
  discoveries TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_notes_task_id ON handoff_notes(task_id);
`;

import type { DatabaseInstance } from "./connection.js";

function ensureColumn(db: DatabaseInstance, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function taskStatusCheckAllowsCancelled(db: DatabaseInstance): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
    .get() as { sql: string } | undefined;
  return row?.sql.includes("cancelled") ?? true;
}

/**
 * SQLite bakes a CHECK constraint into the table's stored schema permanently -
 * there's no `ALTER TABLE` that widens an existing one. Every already-existing
 * `~/.task-tracker/tracker.db` has the old 3-value `status` CHECK baked into its
 * `tasks` table, so it would keep rejecting `status = 'cancelled'` forever
 * without this rebuild (rename -> recreate with the widened CHECK -> copy rows
 * -> drop the renamed original).
 *
 * `foreign_keys` must be toggled off *before* opening the transaction and back
 * on *after* it commits, not inside it - SQLite documents that changing this
 * pragma mid-transaction has no effect. With it left on, `DROP TABLE tasks_old`
 * would fire `task_files`/`task_dependencies`/`handoff_notes`'s `ON DELETE
 * CASCADE` as if every row in `tasks_old` had been individually deleted,
 * wiping out unrelated data that never should have been touched.
 *
 * The rebuild itself runs in a `.immediate()` transaction (acquires SQLite's
 * write lock up front via `BEGIN IMMEDIATE`) so the MCP server and the Status
 * CLI - both call `openDatabase()` independently - can't race through this DDL
 * sequence at the same time; paired with `busy_timeout` (see connection.ts),
 * the second one waits for the lock instead of failing immediately, then
 * re-checks whether the rebuild is still needed and no-ops once it sees the
 * first process already did it. (Deliberately not covered by an automated
 * concurrency test - `better-sqlite3` is synchronous, so a same-process test
 * would deadlock rather than prove anything; see H4's tests for the
 * idempotency coverage this relies on instead.)
 */
function widenTaskStatusCheck(db: DatabaseInstance): void {
  if (taskStatusCheckAllowsCancelled(db)) return;

  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      if (taskStatusCheckAllowsCancelled(db)) return; // someone else won the race while we waited for the lock

      db.exec(`ALTER TABLE tasks RENAME TO tasks_old`);
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          acceptance_criteria TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          owner_session_id TEXT,
          lock_expires_at TEXT,
          complexity_hint TEXT NOT NULL DEFAULT 'normal' CHECK (complexity_hint IN ('normal', 'high')),
          cancellation_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO tasks (id, project_id, epic_id, title, description, acceptance_criteria, status, estimated_tokens, owner_session_id, lock_expires_at, complexity_hint, cancellation_reason, created_at, updated_at)
        SELECT id, project_id, epic_id, title, description, acceptance_criteria, status, estimated_tokens, owner_session_id, lock_expires_at, complexity_hint, cancellation_reason, created_at, updated_at
        FROM tasks_old
      `);
      db.exec(`DROP TABLE tasks_old`);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)`);
    });

    rebuild.immediate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL only shapes brand-new databases -
 * it's a no-op against tables that already exist (e.g. this project's own
 * ~/.task-tracker/tracker.db). New nullable columns need an explicit
 * ALTER TABLE so existing databases pick them up too.
 */
export function runMigrations(db: DatabaseInstance): void {
  ensureColumn(db, "tasks", "lock_expires_at", "TEXT");
  ensureColumn(db, "projects", "design_doc_path", "TEXT");
  ensureColumn(db, "projects", "design_doc_hash", "TEXT");
  ensureColumn(db, "tasks", "epic_id", "TEXT REFERENCES epics(id) ON DELETE SET NULL");
  // Must run after the ensureColumn above, not in the unconditional SCHEMA_SQL
  // block - CREATE TABLE IF NOT EXISTS no-ops for a tasks table that already
  // existed pre-epics, so an unconditional CREATE INDEX ON tasks(epic_id)
  // there would fail with "no such column: epic_id" against it.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)`);
  ensureColumn(
    db,
    "tasks",
    "complexity_hint",
    "TEXT NOT NULL DEFAULT 'normal' CHECK (complexity_hint IN ('normal', 'high'))",
  );
  // Must run before widenTaskStatusCheck(): its rebuild copies this column
  // from tasks_old, which only has it once this ensureColumn has already run.
  ensureColumn(db, "tasks", "cancellation_reason", "TEXT");
  widenTaskStatusCheck(db);
  // No ordering constraint relative to widenTaskStatusCheck() - priority has
  // no CHECK constraint of its own, so a plain ADD COLUMN works whether it
  // runs before or after that rebuild.
  ensureColumn(db, "tasks", "priority", "INTEGER NOT NULL DEFAULT 0");
  // Also no ordering constraint relative to widenTaskStatusCheck() - same
  // reasoning as priority above.
  ensureColumn(db, "tasks", "release_id", "TEXT REFERENCES releases(id) ON DELETE SET NULL");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_release_id ON tasks(release_id)`); // same reasoning as idx_tasks_epic_id above
  ensureColumn(db, "tasks", "completion_summary", "TEXT");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name)`);
}
