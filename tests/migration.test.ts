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

  it("leaves task_files/task_dependencies/handoff_notes able to accept new rows after the rebuild", () => {
    // Regression test: SQLite's `ALTER TABLE tasks RENAME TO tasks_old` used
    // to also rewrite these three tables' stored FK clause to say
    // `tasks_old(id)` instead of `tasks(id)` - invisible until something
    // actually INSERTs into one of their FK columns, which is exactly what
    // this test does that the "preserves existing rows" test above doesn't.
    const db = openPreCancellationDb();
    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'A', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t2', 'p1', 'B', 'now', 'now')`,
    ).run();

    runMigrations(db);

    expect(() =>
      db.prepare(`INSERT INTO task_files (task_id, file_path) VALUES ('t1', 'src/new.ts')`).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('t2', 't1')`).run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO handoff_notes (id, task_id, session_id, decisions, created_at)
           VALUES ('h-new', 't1', 's1', 'note', 'now')`,
        )
        .run(),
    ).not.toThrow();
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

describe("widenReleaseStatusCheck (via runMigrations)", () => {
  /**
   * The schema exactly as it stood before release cancellation: `releases`
   * carries the baked-in 2-value status CHECK and no cancellation_reason, and
   * `tasks` is already fully migrated (4-value CHECK, release_id FK) so this
   * fixture isolates the releases rebuild from widenTaskStatusCheck's.
   *
   * The 2-value CHECK is the whole point of a separate fixture:
   * openPreCancellationDb above declares releases.status with *no* CHECK at
   * all, which the sniff reads as "not migrated" and rebuilds anyway - so it
   * exercises the code path but never the thing that actually needs proving,
   * that an existing constraint rejecting 'cancelled' gets replaced by one
   * that accepts it.
   */
  function openPreReleaseCancellationDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, code_prefix TEXT,
        design_doc_path TEXT, design_doc_hash TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE epics (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE releases (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released')),
        sequence INTEGER NOT NULL,
        release_notes TEXT, released_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_releases_project_id ON releases(project_id);
      CREATE UNIQUE INDEX idx_releases_project_version ON releases(project_id, version);
      CREATE TABLE tasks (
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
        task_number INTEGER,
        completion_summary TEXT,
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
    db.prepare(
      `INSERT INTO projects (id, name, root_path, code_prefix, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'DEM', 'now')`,
    ).run();
    return db;
  }

  function seedRelease(db: Database.Database, id: string, version: string, sequence: number): void {
    db.prepare(
      `INSERT INTO releases (id, project_id, version, name, description, status, sequence, created_at)
       VALUES (?, 'p1', ?, 'Batch', 'notes here', 'planned', ?, 'now')`,
    ).run(id, version, sequence);
  }

  function seedTaskInRelease(db: Database.Database, id: string, releaseId: string | null): void {
    db.prepare(
      `INSERT INTO tasks (id, project_id, release_id, title, task_number, created_at, updated_at)
       VALUES (?, 'p1', ?, ?, 1, 'now', 'now')`,
    ).run(id, releaseId, `Task ${id}`);
  }

  it("rebuilds a 2-value-CHECK releases table in place, preserving rows, then accepts 'cancelled'", () => {
    const db = openPreReleaseCancellationDb();
    seedRelease(db, "r1", "0.1", 10);
    db.prepare(
      `UPDATE releases SET status = 'released', release_notes = '- shipped it', released_at = 'then' WHERE id = 'r1'`,
    ).run();
    seedRelease(db, "r2", "0.2", 20);

    runMigrations(db);

    expect(db.prepare(`SELECT * FROM releases ORDER BY sequence`).all()).toEqual([
      {
        id: "r1",
        project_id: "p1",
        version: "0.1",
        name: "Batch",
        description: "notes here",
        status: "released",
        sequence: 10,
        release_notes: "- shipped it",
        released_at: "then",
        cancellation_reason: null,
        created_at: "now",
      },
      {
        id: "r2",
        project_id: "p1",
        version: "0.2",
        name: "Batch",
        description: "notes here",
        status: "planned",
        sequence: 20,
        release_notes: null,
        released_at: null,
        cancellation_reason: null,
        created_at: "now",
      },
    ]);

    expect(() =>
      db.prepare(`UPDATE releases SET status = 'cancelled', cancellation_reason = 'bench gate' WHERE id = 'r2'`).run(),
    ).not.toThrow();
    expect(() => db.prepare(`UPDATE releases SET status = 'nonsense' WHERE id = 'r2'`).run()).toThrow(
      /CHECK constraint failed/,
    );
  });

  it("preserves every task's release_id through the rebuild", () => {
    // The data-loss regression this whole migration is written around:
    // tasks.release_id is `REFERENCES releases(id) ON DELETE SET NULL`, so a
    // rebuild that drops the renamed original with foreign_keys still ON
    // silently clears the release assignment of every task in the database -
    // no error, no constraint failure, nothing in the result to notice. The
    // rows all still exist afterwards either way, which is exactly why a
    // "preserves rows" assertion alone doesn't catch it.
    const db = openPreReleaseCancellationDb();
    seedRelease(db, "r1", "0.1", 10);
    seedRelease(db, "r2", "0.2", 20);
    seedTaskInRelease(db, "t1", "r1");
    seedTaskInRelease(db, "t2", "r1");
    seedTaskInRelease(db, "t3", "r2");
    seedTaskInRelease(db, "t4", null); // backlog task, unaffected either way

    const assignedBefore = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE release_id IS NOT NULL`)
      .get() as { n: number };
    expect(assignedBefore.n).toBe(3);

    runMigrations(db);

    expect(db.prepare(`SELECT id, release_id FROM tasks ORDER BY id`).all()).toEqual([
      { id: "t1", release_id: "r1" },
      { id: "t2", release_id: "r1" },
      { id: "t3", release_id: "r2" },
      { id: "t4", release_id: null },
    ]);

    // The FK itself has to survive too, not just the column values: with
    // legacy_alter_table off, RENAME would have rewritten this clause to point
    // at releases_old, leaving every later write to tasks failing with "no
    // such table: releases_old".
    expect(() => seedTaskInRelease(db, "t5", "r1")).not.toThrow();
    expect(() => seedTaskInRelease(db, "t6", "no-such-release")).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("recreates both releases indexes, so version stays unique per project", () => {
    const db = openPreReleaseCancellationDb();
    seedRelease(db, "r1", "0.1", 10);

    runMigrations(db);

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'releases' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_releases_project_id");
    expect(indexes).toContain("idx_releases_project_version");

    expect(() => seedRelease(db, "r-dup", "0.1", 30)).toThrow(/UNIQUE constraint failed/);
  });

  it("is idempotent - a second runMigrations call on an already-migrated DB is a clean no-op", () => {
    const db = openPreReleaseCancellationDb();
    seedRelease(db, "r1", "0.1", 10);
    seedTaskInRelease(db, "t1", "r1");

    runMigrations(db);
    const releasesAfterFirst = db.prepare(`SELECT * FROM releases`).all();
    const tasksAfterFirst = db.prepare(`SELECT * FROM tasks ORDER BY id`).all();

    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare(`SELECT * FROM releases`).all()).toEqual(releasesAfterFirst);
    expect(db.prepare(`SELECT * FROM tasks ORDER BY id`).all()).toEqual(tasksAfterFirst);
  });

  it("already-current DBs are untouched - runMigrations leaves a fresh :memory: releases table as SCHEMA_SQL wrote it", async () => {
    const { openDatabase } = await import("../src/db/connection.js");
    const db = openDatabase(":memory:");

    const before = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'releases'`).get() as { sql: string }
    ).sql;
    runMigrations(db);
    const after = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'releases'`).get() as { sql: string }
    ).sql;

    expect(after).toBe(before);
    expect(before).toContain("'cancelled'");
  });
});

describe("repairDanglingTasksOldReferences (via runMigrations)", () => {
  /**
   * Builds a DB in the exact broken end-state widenTaskStatusCheck's rebuild
   * used to leave behind before the legacy_alter_table fix: `tasks` already
   * has the widened CHECK (the rebuild "succeeded"), but `task_files`/
   * `task_dependencies`/`handoff_notes` still have their FK clause pointing
   * at the now-nonexistent `tasks_old` (SQLite allows CREATE TABLE with a
   * dangling REFERENCES target - it's only validated at DML time).
   */
  function openCorruptedPostRebuildDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
        design_doc_path TEXT, design_doc_hash TEXT, created_at TEXT NOT NULL
      );
      /* Present for the same reason openPreCancellationDb's is (SCHEMA_SQL
         creates it unconditionally before runMigrations, so it exists on every
         real upgrade), and given the *current* shape - already carrying the
         3-value CHECK and cancellation_reason - so this fixture keeps testing
         only the dangling-tasks_old repair rather than also dragging in the
         releases rebuild. */
      CREATE TABLE releases (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'cancelled')),
        sequence INTEGER NOT NULL, release_notes TEXT, released_at TEXT,
        cancellation_reason TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        epic_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        owner_session_id TEXT,
        lock_expires_at TEXT,
        complexity_hint TEXT NOT NULL DEFAULT 'normal',
        cancellation_reason TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        release_id TEXT,
        completion_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_files (
        task_id TEXT NOT NULL REFERENCES tasks_old(id) ON DELETE CASCADE, file_path TEXT NOT NULL
      );
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks_old(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks_old(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id)
      );
      CREATE TABLE handoff_notes (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_old(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, decisions TEXT NOT NULL DEFAULT '', remaining_work TEXT NOT NULL DEFAULT '',
        discoveries TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
    `);
    return db;
  }

  it("repairs a DB already left with dangling tasks_old FKs, preserving existing rows", () => {
    const db = openCorruptedPostRebuildDb();
    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'A', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t2', 'p1', 'B', 'now', 'now')`,
    ).run();
    // In reality these rows were inserted *before* the rebuild corrupted the
    // FK clause (SQLite doesn't re-validate existing rows when a table's
    // schema text changes) - foreign_keys has to be off for the fixture's own
    // setup insert here since, unlike the real sequence of events, this
    // fixture's task_files/handoff_notes never had a valid tasks_old to
    // insert against in the first place.
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO task_files (task_id, file_path) VALUES ('t1', 'old.ts')`).run();
    db.prepare(
      `INSERT INTO handoff_notes (id, task_id, session_id, decisions, created_at)
       VALUES ('h1', 't1', 's1', 'pre-existing note', 'now')`,
    ).run();
    db.pragma("foreign_keys = ON");

    runMigrations(db);

    expect(db.prepare(`SELECT * FROM task_files WHERE task_id = 't1'`).all()).toEqual([
      { task_id: "t1", file_path: "old.ts" },
    ]);
    expect(db.prepare(`SELECT * FROM handoff_notes WHERE task_id = 't1'`).all()).toMatchObject([
      { id: "h1", decisions: "pre-existing note" },
    ]);

    expect(() =>
      db.prepare(`INSERT INTO task_files (task_id, file_path) VALUES ('t2', 'new.ts')`).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('t2', 't1')`).run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO handoff_notes (id, task_id, session_id, decisions, created_at)
           VALUES ('h2', 't2', 's1', 'new note', 'now')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("is idempotent - a second runMigrations call on an already-repaired DB is a clean no-op", () => {
    const db = openCorruptedPostRebuildDb();
    db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'A', 'now', 'now')`,
    ).run();

    runMigrations(db);
    const afterFirst = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'task_files'`).get();

    expect(() => runMigrations(db)).not.toThrow();
    const afterSecond = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'task_files'`).get();

    expect(afterSecond).toEqual(afterFirst);
  });
});

describe("task numbering backfill (via runMigrations)", () => {
  function seedProject(db: Database.Database, id: string, name: string, createdAt = "now"): void {
    db.prepare(`INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)`).run(
      id,
      name,
      `/tmp/${id}`,
      createdAt,
    );
  }

  function seedTask(db: Database.Database, id: string, projectId: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, projectId, `Task ${id}`, createdAt, createdAt);
  }

  function numbersOf(db: Database.Database, projectId: string): Array<{ id: string; task_number: number }> {
    return db
      .prepare(`SELECT id, task_number FROM tasks WHERE project_id = ? ORDER BY task_number ASC`)
      .all(projectId) as Array<{ id: string; task_number: number }>;
  }

  it("derives a prefix per project and numbers its existing tasks 1..N in created_at order", () => {
    const db = openPreCancellationDb();
    seedProject(db, "p1", "task-tracker-mcp");
    seedProject(db, "p2", "g-mesh");
    // Deliberately inserted out of chronological order, so passing this test
    // requires ordering by created_at rather than by insertion order.
    seedTask(db, "t-third", "p1", "2026-01-03T00:00:00.000Z");
    seedTask(db, "t-first", "p1", "2026-01-01T00:00:00.000Z");
    seedTask(db, "t-second", "p1", "2026-01-02T00:00:00.000Z");
    seedTask(db, "other-1", "p2", "2026-01-05T00:00:00.000Z");

    runMigrations(db);

    expect(db.prepare(`SELECT id, code_prefix FROM projects ORDER BY id`).all()).toEqual([
      { id: "p1", code_prefix: "TTM" },
      { id: "p2", code_prefix: "GM" },
    ]);
    expect(numbersOf(db, "p1")).toEqual([
      { id: "t-first", task_number: 1 },
      { id: "t-second", task_number: 2 },
      { id: "t-third", task_number: 3 },
    ]);
    // Counters are per project, so the second project restarts at 1.
    expect(numbersOf(db, "p2")).toEqual([{ id: "other-1", task_number: 1 }]);
  });

  it("de-duplicates a collision between two projects deriving the same prefix, oldest keeping the bare one", () => {
    const db = openPreCancellationDb();
    seedProject(db, "p1", "g-mesh", "2026-01-01T00:00:00.000Z");
    seedProject(db, "p2", "game-mode", "2026-01-02T00:00:00.000Z");
    seedProject(db, "p3", "grand.machine", "2026-01-03T00:00:00.000Z");

    runMigrations(db);

    expect(db.prepare(`SELECT id, code_prefix FROM projects ORDER BY created_at`).all()).toEqual([
      { id: "p1", code_prefix: "GM" },
      { id: "p2", code_prefix: "GM2" },
      { id: "p3", code_prefix: "GM3" },
    ]);
  });

  it("is a no-op on re-run - prefixes and task numbers stay exactly as first assigned", () => {
    const db = openPreCancellationDb();
    seedProject(db, "p1", "task-tracker-mcp");
    seedTask(db, "t1", "p1", "2026-01-01T00:00:00.000Z");
    seedTask(db, "t2", "p1", "2026-01-02T00:00:00.000Z");

    runMigrations(db);
    const projectsAfterFirst = db.prepare(`SELECT * FROM projects`).all();
    const tasksAfterFirst = db.prepare(`SELECT * FROM tasks ORDER BY id`).all();

    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare(`SELECT * FROM projects`).all()).toEqual(projectsAfterFirst);
    expect(db.prepare(`SELECT * FROM tasks ORDER BY id`).all()).toEqual(tasksAfterFirst);
  });

  it("resumes from the project's highest existing number instead of restarting at 1", () => {
    // A DB numbered by one build, then written to by an older one that didn't
    // know about task_number: the leftovers must not collide with 1..N.
    const db = openPreCancellationDb();
    seedProject(db, "p1", "task-tracker-mcp");
    seedTask(db, "t1", "p1", "2026-01-01T00:00:00.000Z");
    seedTask(db, "t2", "p1", "2026-01-02T00:00:00.000Z");

    runMigrations(db);

    seedTask(db, "t3", "p1", "2026-01-03T00:00:00.000Z");
    runMigrations(db);

    expect(numbersOf(db, "p1")).toEqual([
      { id: "t1", task_number: 1 },
      { id: "t2", task_number: 2 },
      { id: "t3", task_number: 3 },
    ]);
  });

  it("leaves an existing project's prefix alone when a newly added project would derive the same one", () => {
    const db = openPreCancellationDb();
    seedProject(db, "p1", "g-mesh", "2026-01-01T00:00:00.000Z");
    runMigrations(db);

    seedProject(db, "p2", "game-mode", "2026-01-02T00:00:00.000Z");
    runMigrations(db);

    expect(db.prepare(`SELECT id, code_prefix FROM projects ORDER BY created_at`).all()).toEqual([
      { id: "p1", code_prefix: "GM" },
      { id: "p2", code_prefix: "GM2" },
    ]);
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

describe("release_plans / release_plan_items (via SCHEMA_SQL)", () => {
  /**
   * These two tables are created by SCHEMA_SQL rather than by a
   * runMigrations entry, and that is the thing worth testing: a *table* that
   * doesn't exist anywhere yet is created by `CREATE TABLE IF NOT EXISTS` on
   * an existing database just as much as on a fresh one, so unlike
   * tasks.priority or tasks.release_id it needs no ensureColumn. Every case
   * below goes through the real openDatabase(), because that is what execs
   * SCHEMA_SQL before runMigrations - calling runMigrations() directly, as
   * most fixtures in this file do, would test nothing here.
   */

  async function openFresh() {
    const { openDatabase } = await import("../src/db/connection.js");
    return openDatabase(":memory:");
  }

  function tableColumns(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
  }

  it("creates both tables and the item index on a brand-new DB", async () => {
    const db = await openFresh();

    expect(tableColumns(db, "release_plans")).toEqual([
      "approval_note",
      "approved_at",
      "approved_by",
      "created_at",
      "id",
      "rationale",
      "release_id",
      "status",
      "updated_at",
    ]);
    expect(tableColumns(db, "release_plan_items")).toEqual([
      "added_at",
      "note",
      "plan_id",
      "position",
      "step",
      "task_id",
    ]);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'release_plan_items'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_release_plan_items_task_id");

    db.close();
  });

  it("defaults a plan to draft and rejects a status outside the CHECK", async () => {
    const db = await openFresh();
    db.exec(`
      INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now');
      INSERT INTO releases (id, project_id, version, sequence, created_at) VALUES ('r1', 'p1', '1.0.0', 10, 'now');
      INSERT INTO release_plans (id, release_id, created_at, updated_at) VALUES ('pl1', 'r1', 'now', 'now');
    `);

    expect(db.prepare(`SELECT status, rationale, approved_at FROM release_plans WHERE id = 'pl1'`).get()).toEqual({
      status: "draft",
      rationale: "",
      approved_at: null,
    });

    expect(() =>
      db.exec(`UPDATE release_plans SET status = 'approved' WHERE id = 'pl1'`),
    ).not.toThrow();
    expect(() =>
      db.exec(`UPDATE release_plans SET status = 'superseded' WHERE id = 'pl1'`),
    ).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it("allows only one plan per release", async () => {
    const db = await openFresh();
    db.exec(`
      INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now');
      INSERT INTO releases (id, project_id, version, sequence, created_at) VALUES ('r1', 'p1', '1.0.0', 10, 'now');
      INSERT INTO release_plans (id, release_id, created_at, updated_at) VALUES ('pl1', 'r1', 'now', 'now');
    `);

    expect(() =>
      db.exec(`INSERT INTO release_plans (id, release_id, created_at, updated_at) VALUES ('pl2', 'r1', 'now', 'now')`),
    ).toThrow(/UNIQUE constraint failed/);

    db.close();
  });

  it("cascades: dropping a release takes its plan and items, dropping a task takes only its item", async () => {
    const db = await openFresh();
    db.exec(`
      INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'Demo', '/tmp/demo', 'now');
      INSERT INTO releases (id, project_id, version, sequence, created_at) VALUES ('r1', 'p1', '1.0.0', 10, 'now');
      INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'A', 'now', 'now');
      INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t2', 'p1', 'B', 'now', 'now');
      INSERT INTO release_plans (id, release_id, created_at, updated_at) VALUES ('pl1', 'r1', 'now', 'now');
      INSERT INTO release_plan_items (plan_id, task_id, step, position, added_at) VALUES ('pl1', 't1', 1, 0, 'now');
      INSERT INTO release_plan_items (plan_id, task_id, step, position, added_at) VALUES ('pl1', 't2', 2, 0, 'now');
    `);

    db.exec(`DELETE FROM tasks WHERE id = 't1'`);
    expect(
      (db.prepare(`SELECT task_id FROM release_plan_items WHERE plan_id = 'pl1'`).all() as Array<{ task_id: string }>)
        .map((r) => r.task_id),
    ).toEqual(["t2"]);
    // The plan itself outlives one of its tasks - a task leaving the batch is
    // an item's problem, not the plan's.
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM release_plans`).get()).toEqual({ cnt: 1 });

    db.exec(`DELETE FROM releases WHERE id = 'r1'`);
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM release_plans`).get()).toEqual({ cnt: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM release_plan_items`).get()).toEqual({ cnt: 0 });

    db.close();
  });

  it("adds both tables to a real pre-plan DB file without disturbing a single existing row", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-pre-plan-"));
    const dbPath = path.join(dir, "tracker.db");
    try {
      // The shape on disk at 0.6.0: everything the current SCHEMA_SQL has
      // except the two plan tables.
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, code_prefix TEXT,
          design_doc_path TEXT, design_doc_hash TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE releases (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'cancelled')),
          sequence INTEGER NOT NULL, release_notes TEXT, released_at TEXT,
          cancellation_reason TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          epic_id TEXT, release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
          title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          acceptance_criteria TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
          estimated_tokens INTEGER NOT NULL DEFAULT 0, owner_session_id TEXT, lock_expires_at TEXT,
          complexity_hint TEXT NOT NULL DEFAULT 'normal' CHECK (complexity_hint IN ('normal', 'high')),
          cancellation_reason TEXT, priority INTEGER NOT NULL DEFAULT 0, task_number INTEGER,
          completion_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
        INSERT INTO projects (id, name, root_path, code_prefix, created_at)
          VALUES ('p1', 'Demo', '/tmp/demo', 'DEM', 'then');
        INSERT INTO releases (id, project_id, version, sequence, created_at)
          VALUES ('r1', 'p1', '0.6.0', 10, 'then');
        INSERT INTO tasks (id, project_id, release_id, title, status, priority, task_number, created_at, updated_at)
          VALUES ('t1', 'p1', 'r1', 'Shipped task', 'done', 7, 1, 'then', 'then');
        INSERT INTO task_files (task_id, file_path) VALUES ('t1', 'src/a.ts');
      `);
      const before = {
        project: seed.prepare(`SELECT * FROM projects WHERE id = 'p1'`).get(),
        release: seed.prepare(`SELECT * FROM releases WHERE id = 'r1'`).get(),
        task: seed.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get(),
        files: seed.prepare(`SELECT * FROM task_files`).all(),
      };
      seed.close();

      const { openDatabase } = await import("../src/db/connection.js");
      let db: import("better-sqlite3").Database | undefined;
      expect(() => {
        db = openDatabase(dbPath);
      }).not.toThrow();

      expect(tableColumns(db!, "release_plans")).toContain("approval_note");
      expect(tableColumns(db!, "release_plan_items")).toContain("step");
      expect(db!.prepare(`SELECT COUNT(*) AS cnt FROM release_plans`).get()).toEqual({ cnt: 0 });

      // Not "looks similar" - every column of every seeded row, unchanged.
      // The release link is the one most at risk: a rebuild with foreign_keys
      // left on would have quietly SET NULL it (see widenReleaseStatusCheck).
      expect(db!.prepare(`SELECT * FROM projects WHERE id = 'p1'`).get()).toEqual(before.project);
      expect(db!.prepare(`SELECT * FROM releases WHERE id = 'r1'`).get()).toEqual(before.release);
      expect(db!.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get()).toEqual(before.task);
      expect(db!.prepare(`SELECT * FROM task_files`).all()).toEqual(before.files);
      db!.close();

      // Second open: the tables are already there, a plan written through the
      // first open survives, and nothing is recreated under it.
      const again = openDatabase(dbPath);
      expect(() =>
        again.exec(
          `INSERT INTO release_plans (id, release_id, created_at, updated_at) VALUES ('pl1', 'r1', 'now', 'now')`,
        ),
      ).not.toThrow();
      again.close();
      const third = openDatabase(dbPath);
      expect(third.prepare(`SELECT id, status FROM release_plans`).all()).toEqual([
        { id: "pl1", status: "draft" },
      ]);
      expect(third.prepare(`SELECT * FROM tasks WHERE id = 't1'`).get()).toEqual(before.task);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task_slices (via SCHEMA_SQL)", () => {
  /**
   * Same mechanism as release_plans above: a new table, created by SCHEMA_SQL's
   * `CREATE TABLE IF NOT EXISTS` on every open, with no runMigrations entry.
   * The seed is the current SCHEMA_SQL cut just before task_slices - exactly
   * the shape a 0.8.0 tracker.db has on disk - so this cannot drift from the
   * real previous schema the way a hand-copied fixture would.
   */
  it("adds task_slices to a pre-slices DB file without disturbing a single existing row", async () => {
    const { SCHEMA_SQL } = await import("../src/db/schema.js");
    const cut = SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS task_slices");
    expect(cut).toBeGreaterThan(0);
    const previousSchema = SCHEMA_SQL.slice(0, cut);

    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-pre-slices-"));
    const dbPath = path.join(dir, "tracker.db");
    try {
      const seed = new Database(dbPath);
      seed.exec(previousSchema);
      seed.exec(`
        INSERT INTO projects (id, name, root_path, code_prefix, created_at)
          VALUES ('p1', 'Demo', '/tmp/demo', 'DEM', 'then');
        INSERT INTO releases (id, project_id, version, sequence, created_at)
          VALUES ('r1', 'p1', '0.8.0', 10, 'then');
        INSERT INTO tasks (id, project_id, release_id, title, status, priority, task_number, created_at, updated_at)
          VALUES ('t1', 'p1', 'r1', 'Existing task', 'in_progress', 3, 1, 'then', 'then');
        INSERT INTO task_files (task_id, file_path) VALUES ('t1', 'src/a.ts');
        INSERT INTO release_plans (id, release_id, status, created_at, updated_at)
          VALUES ('pl1', 'r1', 'approved', 'then', 'then');
        INSERT INTO release_plan_items (plan_id, task_id, step, position, added_at)
          VALUES ('pl1', 't1', 1, 1, 'then');
      `);
      expect(
        seed.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_slices'`).get(),
      ).toBeUndefined();
      const tables = ["projects", "releases", "tasks", "task_files", "release_plans", "release_plan_items"];
      const before = Object.fromEntries(tables.map((t) => [t, seed.prepare(`SELECT * FROM ${t}`).all()]));
      seed.close();

      const { openDatabase } = await import("../src/db/connection.js");
      let db: import("better-sqlite3").Database | undefined;
      expect(() => {
        db = openDatabase(dbPath);
      }).not.toThrow();

      const columns = (db!.prepare(`PRAGMA table_info(task_slices)`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
      expect(columns).toEqual(
        [
          "id",
          "task_id",
          "phase",
          "step",
          "position",
          "title",
          "brief",
          "exit_criterion",
          "status",
          "model",
          "result",
          "artifacts",
          "metrics",
          "started_at",
          "completed_at",
          "created_at",
          "updated_at",
          "label_number",
        ].sort(),
      );
      expect(db!.prepare(`SELECT COUNT(*) AS cnt FROM task_slices`).get()).toEqual({ cnt: 0 });
      for (const table of tables) {
        expect(db!.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before[table]);
      }

      // The new table is usable against an existing task, and its CHECKs hold.
      expect(() =>
        db!.exec(
          `INSERT INTO task_slices (id, task_id, phase, step, position, title, created_at, updated_at)
           VALUES ('s1', 't1', 'design', 1, 1, 'Decide', 'now', 'now')`,
        ),
      ).not.toThrow();
      expect(() =>
        db!.exec(
          `INSERT INTO task_slices (id, task_id, phase, step, position, title, created_at, updated_at)
           VALUES ('s2', 't1', 'deploy', 2, 1, 'Nope', 'now', 'now')`,
        ),
      ).toThrow(/CHECK constraint failed/);
      db!.close();

      // Reopen: the slice written through the first open survives.
      const again = openDatabase(dbPath);
      expect(again.prepare(`SELECT id, status, artifacts, metrics FROM task_slices`).all()).toEqual([
        { id: "s1", status: "pending", artifacts: "[]", metrics: null },
      ]);
      expect(again.prepare(`SELECT * FROM tasks`).all()).toEqual(before.tasks);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task_slices.label_number (TTM-89, via runMigrations)", () => {
  /**
   * The seed is the current SCHEMA_SQL with task_slices cut back to its
   * pre-TTM-89 shape (no label_number) and without task_slice_revisions - the
   * shape a 0.10.0 tracker.db has on disk - so it cannot drift from the real
   * previous schema the way a hand-copied fixture would.
   */
  async function preLabelSchema(): Promise<string> {
    const { SCHEMA_SQL } = await import("../src/db/schema.js");
    const cut = SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS task_slice_revisions");
    expect(cut).toBeGreaterThan(0);
    const withoutRevisions = SCHEMA_SQL.slice(0, cut);
    const labelColumn = "  label_number INTEGER,\n";
    expect(withoutRevisions).toContain(labelColumn);
    return withoutRevisions.replace(labelColumn, "");
  }

  it("labels existing slices exactly as the old read-time numbering did, and keeps them through a revision", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-pre-labels-"));
    const dbPath = path.join(dir, "tracker.db");
    try {
      const seed = new Database(dbPath);
      seed.exec(await preLabelSchema());
      // Inserted out of step/position order, so a backfill that followed rowid
      // instead of step/position would number them differently.
      seed.exec(`
        INSERT INTO projects (id, name, root_path, code_prefix, created_at)
          VALUES ('p1', 'Demo', '/tmp/demo', 'DEM', 'then');
        INSERT INTO tasks (id, project_id, title, status, task_number, created_at, updated_at)
          VALUES ('t1', 'p1', 'Sliced', 'in_progress', 1, 'then', 'then'),
                 ('t2', 'p1', 'Other', 'pending', 2, 'then', 'then');
        INSERT INTO task_slices (id, task_id, phase, step, position, title, status, result, created_at, updated_at)
          VALUES ('c', 't1', 'verify', 3, 1, 'Check', 'pending', NULL, 'then', 'then'),
                 ('b2', 't1', 'implement', 2, 2, 'Build B', 'in_progress', NULL, 'then', 'then'),
                 ('a', 't1', 'design', 1, 1, 'Decide', 'done', 'decided', 'then', 'then'),
                 ('b1', 't1', 'implement', 2, 1, 'Build A', 'pending', NULL, 'then', 'then'),
                 ('x', 't2', 'implement', 1, 1, 'Only', 'pending', NULL, 'then', 'then');
      `);
      const rowsBefore = seed.prepare(`SELECT * FROM task_slices ORDER BY id`).all();
      seed.close();

      const { openDatabase } = await import("../src/db/connection.js");
      const db = openDatabase(dbPath);
      expect(db.prepare(`SELECT id, label_number FROM task_slices ORDER BY task_id, label_number`).all()).toEqual([
        { id: "a", label_number: 1 },
        { id: "b1", label_number: 2 },
        { id: "b2", label_number: 3 },
        { id: "c", label_number: 4 },
        { id: "x", label_number: 1 },
      ]);
      // Nothing but the new column changed on any existing row.
      const rowsAfter = (db.prepare(`SELECT * FROM task_slices ORDER BY id`).all() as Array<Record<string, unknown>>).map(
        ({ label_number: _label, ...rest }) => rest,
      );
      expect(rowsAfter).toEqual(rowsBefore);

      const { listTaskSlices, requireSlice, reviseTaskSlices } = await import("../src/domain/slices.js");
      expect(listTaskSlices(db, "DEM-1").map((s) => [s.ref, s.title])).toEqual([
        ["DEM-1/S1", "Decide"],
        ["DEM-1/S2", "Build A"],
        ["DEM-1/S3", "Build B"],
        ["DEM-1/S4", "Check"],
      ]);

      // A migrated task revises like a new one: S2 (pending, before kept S3)
      // goes, S3 keeps its label, the new slice is numbered after S4.
      reviseTaskSlices(db, "DEM-1", [{ phase: "implement", title: "Rework" }], "migrated re-cut");
      expect(requireSlice(db, "DEM-1/S3").id).toBe("b2");
      expect(listTaskSlices(db, "DEM-1").map((s) => s.label)).toEqual(["S1", "S3", "S5"]);
      db.close();

      // Reopen: the backfill does not touch an already-labelled task, gaps included.
      const again = openDatabase(dbPath);
      expect(listTaskSlices(again, "DEM-1").map((s) => [s.label, s.title])).toEqual([
        ["S1", "Decide"],
        ["S3", "Build B"],
        ["S5", "Rework"],
      ]);
      expect(() =>
        again.exec(
          `INSERT INTO task_slices (id, task_id, phase, step, position, title, label_number, created_at, updated_at)
           VALUES ('dup', 't1', 'verify', 9, 1, 'Dup', 3, 'now', 'now')`,
        ),
      ).toThrow(/UNIQUE constraint failed/);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
