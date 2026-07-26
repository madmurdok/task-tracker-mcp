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

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  owner_session_id TEXT,
  lock_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id);

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
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name)`);
}
