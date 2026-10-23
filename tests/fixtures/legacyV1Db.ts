import Database from "better-sqlite3";

/**
 * Writes a pre-epics (v1) tracker DB file: the oldest on-disk shape, with no
 * epics/releases/plans/slices tables and the columns later added by
 * ensureColumn missing, so openDatabase() on it runs every migration and the
 * migrated tables end up with a different physical column order than a fresh
 * DB. Seeds one project with two tasks (ids `${projectId}-t1`, `-t2`).
 */
export function writeLegacyV1Db(dbPath: string, projectId = "p1"): void {
  const seed = new Database(dbPath);
  try {
    seed.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        owner_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_files (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, file_path TEXT NOT NULL
      );
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id)
      );
      CREATE TABLE handoff_notes (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, decisions TEXT NOT NULL DEFAULT '', remaining_work TEXT NOT NULL DEFAULT '',
        discoveries TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
    `);
    seed
      .prepare(`INSERT INTO projects (id, name, root_path, created_at) VALUES (?, 'Legacy Demo', '/tmp/legacy', '2026-01-01T00:00:00.000Z')`)
      .run(projectId);
    const task = seed.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    task.run(`${projectId}-t1`, projectId, "Old task one", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    task.run(`${projectId}-t2`, projectId, "Old task two", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
  } finally {
    seed.close();
  }
}
