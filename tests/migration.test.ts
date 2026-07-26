import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/schema.js";

/**
 * Builds a DB on the schema as it existed before H1 (cancellation lifecycle):
 * a 3-value status CHECK, no complexity_hint/cancellation_reason - the shape
 * every already-existing ~/.task-tracker/tracker.db has on disk today.
 *
 * `releases` is still included, empty, even though the *tasks* shape predates
 * it: in the real openDatabase() flow, SCHEMA_SQL's `CREATE TABLE IF NOT
 * EXISTS releases` runs unconditionally before runMigrations(), so a brand
 * new table like this always exists by migration time on every real upgrade
 * - only tasks.release_id (an ensureColumn'd column with a REFERENCES
 * releases(id) clause) actually depends on it being there, since
 * foreign_keys=ON makes SQLite validate that the referenced table exists for
 * every write to `tasks`, not just ones that set release_id.
 */
function openPreCancellationDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
      design_doc_path TEXT, design_doc_hash TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE epics (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE releases (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned', sequence INTEGER NOT NULL,
      release_notes TEXT, released_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
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
  return db;
}

describe("widenTaskStatusCheck (via runMigrations)", () => {
  it("rebuilds an old 3-value-CHECK DB in place, preserving rows and related tables, then accepts 'cancelled'", () => {
    const db = openPreCancellationDb();

    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ('t1', 'p1', 'Old task', 'done', 'now', 'now')`,
    ).run();
    db.prepare(`INSERT INTO task_files (task_id, file_path) VALUES ('t1', 'src/a.ts')`).run();
    db.prepare(
      `INSERT INTO handoff_notes (id, task_id, session_id, decisions, created_at)
       VALUES ('h1', 't1', 'session-1', 'used sqlite', 'now')`,
    ).run();

    runMigrations(db);

    const row = db.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get();
    expect(row).toMatchObject({
      id: "t1",
      project_id: "p1",
      title: "Old task",
      status: "done",
      complexity_hint: "normal",
      cancellation_reason: null,
    });

    expect(db.prepare(`SELECT * FROM task_files WHERE task_id = 't1'`).all()).toEqual([
      { task_id: "t1", file_path: "src/a.ts" },
    ]);
    expect(db.prepare(`SELECT * FROM handoff_notes WHERE task_id = 't1'`).all()).toMatchObject([
      { id: "h1", task_id: "t1", decisions: "used sqlite" },
    ]);

    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
           VALUES ('t2', 'p1', 'New task', 'cancelled', 'now', 'now')`,
        )
        .run(),
    ).not.toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
           VALUES ('t3', 'p1', 'Bad', 'nonsense', 'now', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("is idempotent - a second runMigrations call on an already-migrated DB is a clean no-op", () => {
    const db = openPreCancellationDb();
    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'Task', 'now', 'now')`,
    ).run();

    runMigrations(db);
    const afterFirst = db.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get();

    expect(() => runMigrations(db)).not.toThrow();
    const afterSecond = db.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get();

    expect(afterSecond).toEqual(afterFirst);
  });

  it("already-current DBs (SCHEMA_SQL's own shape) are untouched - runMigrations is a no-op on a fresh :memory: DB", async () => {
    const { openDatabase } = await import("../src/db/connection.js");
    const db = openDatabase(":memory:");

    const before = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tasks'`).get() as { sql: string }
    ).sql;
    runMigrations(db);
    const after = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tasks'`).get() as { sql: string }
    ).sql;

    expect(after).toBe(before);
    expect(before).toContain("cancelled");
  });
});

describe("openDatabase against a genuinely pre-epics (v1) DB file", () => {
  /**
   * Regression test for a real bug: SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS
   * tasks` no-ops against an already-existing tasks table (which every real
   * upgrade has), but its `CREATE INDEX ... ON tasks(epic_id/release_id)`
   * statements used to run unconditionally in that same SCHEMA_SQL block -
   * before ensureColumn ever got a chance to add those columns for a DB this
   * old. Every other fixture in this file already has epic_id baked into its
   * "old" tasks table (they simulate post-epics, pre-cancellation states), so
   * none of them caught this - only a truly v1-era file, opened through the
   * real openDatabase() (not runMigrations() called directly on a hand-built
   * in-memory DB), reproduces it.
   */
  it("migrates cleanly instead of failing with 'no such column: epic_id'", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-v1-upgrade-"));
    const dbPath = path.join(dir, "tracker.db");
    try {
      const seed = new Database(dbPath);
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
        .prepare(`INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now')`)
        .run();
      seed
        .prepare(
          `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'Old task', 'now', 'now')`,
        )
        .run();
      seed.close();

      const { openDatabase } = await import("../src/db/connection.js");
      let db: import("better-sqlite3").Database | undefined;
      expect(() => {
        db = openDatabase(dbPath);
      }).not.toThrow();

      const row = db?.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get();
      expect(row).toMatchObject({ id: "t1", title: "Old task", epic_id: null, release_id: null });
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
