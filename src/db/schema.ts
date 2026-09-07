export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  code_prefix TEXT,
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
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'cancelled')),
  sequence INTEGER NOT NULL,
  release_notes TEXT,
  released_at TEXT,
  cancellation_reason TEXT,
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
  task_number INTEGER,
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

-- The execution order for one release batch, plus the record that a human
-- approved it. The order was already expressible (tasks.priority, plus
-- task_dependencies); an approval was not, and that is what this table is
-- for: approved once, a whole batch can be worked without stopping every
-- two or three tasks to re-earn permission.
--
-- status is two values and that is the whole state space - sending an
-- approved plan back to 'draft' IS the supersede mechanism, so no third
-- value is invented. If a third one ever is needed, note that SQLite bakes
-- a CHECK into the stored schema permanently and no ALTER widens one: it
-- needs the rename -> recreate -> copy -> drop rebuild that
-- widenTaskStatusCheck and widenReleaseStatusCheck below already implement
-- twice, pragma handling and all. Copy one of those; do not rediscover it.
--
-- approval_note holds the approver's own words, not a paraphrase. The party
-- an approval authorises is the same party that calls approve_plan, so this
-- is an audit trail rather than an enforcement boundary, and a trail that
-- quotes is checkable where one that summarises is not.
CREATE TABLE IF NOT EXISTS release_plans (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL UNIQUE REFERENCES releases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  rationale TEXT NOT NULL DEFAULT '',
  approved_by TEXT,
  approval_note TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One task's place in a plan. Items sharing a step may run in parallel;
-- position only orders them inside that step, so a display stays stable.
--
-- Deliberately NO added_after_approval flag: "new since approval" is
-- added_at > release_plans.approved_at, computed at read time. A stored
-- boolean would need clearing on every approval and could drift out of
-- sync with it - the same reason displayStatus keeps blocked computed
-- from the dependency graph rather than storing it on the row.
--
-- Nothing here duplicates the task's title or status either. Both are one
-- join away and both change under the plan's feet; a copy would be a second
-- truth to keep.
CREATE TABLE IF NOT EXISTS release_plan_items (
  plan_id TEXT NOT NULL REFERENCES release_plans(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  position INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_release_plan_items_task_id ON release_plan_items(task_id);
`;

import type { DatabaseInstance } from "./connection.js";
import { dedupePrefix, derivePrefix } from "../domain/projects.js";

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
  // Modern SQLite's `ALTER TABLE ... RENAME TO` doesn't just rename `tasks` -
  // by default it also rewrites every OTHER table's stored FK clause that
  // references `tasks(id)` to say `tasks_old(id)` instead, "helpfully"
  // keeping foreign keys pointed at the renamed table. That's exactly wrong
  // here: `task_files`/`task_dependencies`/`handoff_notes` end up with a
  // dangling FK to `tasks_old` once it's dropped below, and every future
  // INSERT touching those FK columns then fails with "no such table:
  // tasks_old" (foreign_keys enforcement has to resolve the parent table).
  // `legacy_alter_table` disables that auto-rewrite, so RENAME only touches
  // `tasks` itself - dependent tables keep saying `tasks(id)`, which
  // correctly resolves once the new `tasks` table is created under that same
  // name a few lines down. (Any DB that already ran this rebuild before this
  // pragma was added is fixed once by repairDanglingTasksOldReferences below.)
  db.pragma("legacy_alter_table = ON");
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
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Same sniff as taskStatusCheckAllowsCancelled, with one deliberate
 * difference: it matches the *quoted* literal `'cancelled'` rather than the
 * bare word. `releases` also carries a `cancellation_reason` column, and while
 * that string happens not to contain "cancelled" today ("cancella-tion" vs
 * "cancell-ed"), depending on that near-miss to tell a CHECK constraint apart
 * from a column name is one rename away from silently reporting a DB as
 * already migrated - which would leave its CHECK permanently rejecting
 * `cancelled` with no error anywhere to explain why.
 */
function releaseStatusCheckAllowsCancelled(db: DatabaseInstance): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'releases'`)
    .get() as { sql: string } | undefined;
  return row?.sql.includes("'cancelled'") ?? true;
}

/**
 * The releases-table counterpart of widenTaskStatusCheck, needed for the same
 * reason: every existing tracker.db has the 2-value `status` CHECK
 * (`'planned', 'released'`) baked into its `releases` table, and SQLite has no
 * ALTER that widens one - only a full rename -> recreate -> copy -> drop
 * rebuild.
 *
 * The pragma handling is copied verbatim from widenTaskStatusCheck rather than
 * re-derived, because the failure mode here is worse than the one there.
 * `tasks.release_id` is `REFERENCES releases(id) ON DELETE SET NULL`, so:
 *
 * 1. `foreign_keys = OFF` *before* the transaction opens and back ON *after*
 *    it commits (SQLite ignores the pragma mid-transaction). Left on, dropping
 *    the renamed original is treated as deleting every release row and fires
 *    ON DELETE SET NULL across `tasks` - every task in the project silently
 *    loses its release assignment, with no error and nothing in the data to
 *    show it ever had one. See the "task->release links survive" case in
 *    tests/migration.test.ts.
 * 2. `legacy_alter_table = ON` so `RENAME TO releases_old` doesn't rewrite
 *    `tasks`' stored FK clause to point at the renamed table (which would both
 *    leave tasks dangling once it's dropped and, combined with (1) being
 *    forgotten, aim that SET NULL squarely at the rows we're protecting).
 *
 * The `.immediate()` transaction and the re-check of the sniff *inside* it are
 * likewise deliberate: the MCP server and the Status CLI each call
 * openDatabase() independently, so the second one to arrive waits on the write
 * lock (see busy_timeout in connection.ts) and then sees the rebuild is
 * already done instead of running it twice.
 */
function widenReleaseStatusCheck(db: DatabaseInstance): void {
  if (releaseStatusCheckAllowsCancelled(db)) return;

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    const rebuild = db.transaction(() => {
      if (releaseStatusCheckAllowsCancelled(db)) return; // someone else won the race while we waited for the lock

      db.exec(`ALTER TABLE releases RENAME TO releases_old`);
      db.exec(`
        CREATE TABLE releases (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'cancelled')),
          sequence INTEGER NOT NULL,
          release_notes TEXT,
          released_at TEXT,
          cancellation_reason TEXT,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO releases (id, project_id, version, name, description, status, sequence, release_notes, released_at, cancellation_reason, created_at)
        SELECT id, project_id, version, name, description, status, sequence, release_notes, released_at, cancellation_reason, created_at
        FROM releases_old
      `);
      db.exec(`DROP TABLE releases_old`);

      // After the DROP, never before: the old table's indexes are renamed
      // along with it and keep their names, so recreating them while
      // releases_old still exists would silently no-op on `IF NOT EXISTS` and
      // leave the new table unindexed - including the UNIQUE one that enforces
      // one version per project.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_project_id ON releases(project_id)`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_project_version ON releases(project_id, version)`,
      );
    });

    rebuild.immediate();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

function referencesTasksOld(db: DatabaseInstance, table: string): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  return row?.sql.includes("tasks_old") ?? false;
}

/**
 * One-time repair for a DB that already ran `widenTaskStatusCheck`'s rebuild
 * before the `legacy_alter_table` fix above existed: `task_files`,
 * `task_dependencies`, and/or `handoff_notes` are left with their FK clause
 * permanently pointing at the now-dropped `tasks_old`, so any INSERT setting
 * those FK columns fails with "no such table: tasks_old". Detected the same
 * way `taskStatusCheckAllowsCancelled` detects its own migration state - by
 * reading the affected table's stored SQL back from `sqlite_master` - so this
 * is a no-op (and safe to call unconditionally on every startup) once fixed.
 * Rebuilt the same way `widenTaskStatusCheck` rebuilds `tasks`: rename,
 * recreate with the correct `tasks(id)` FK, copy rows, drop the renamed
 * original, inside one `.immediate()` transaction with `foreign_keys` off for
 * the same CASCADE-safety reason documented on `widenTaskStatusCheck`.
 */
function repairDanglingTasksOldReferences(db: DatabaseInstance): void {
  const affected = ["task_files", "task_dependencies", "handoff_notes"].filter((table) =>
    referencesTasksOld(db, table),
  );
  if (affected.length === 0) return;

  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      if (affected.includes("task_files")) {
        db.exec(`ALTER TABLE task_files RENAME TO task_files_old`);
        db.exec(`
          CREATE TABLE task_files (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL
          )
        `);
        db.exec(`INSERT INTO task_files (task_id, file_path) SELECT task_id, file_path FROM task_files_old`);
        db.exec(`DROP TABLE task_files_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id)`);
      }

      if (affected.includes("task_dependencies")) {
        db.exec(`ALTER TABLE task_dependencies RENAME TO task_dependencies_old`);
        db.exec(`
          CREATE TABLE task_dependencies (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, depends_on_task_id)
          )
        `);
        db.exec(`
          INSERT INTO task_dependencies (task_id, depends_on_task_id)
          SELECT task_id, depends_on_task_id FROM task_dependencies_old
        `);
        db.exec(`DROP TABLE task_dependencies_old`);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id)`,
        );
      }

      if (affected.includes("handoff_notes")) {
        db.exec(`ALTER TABLE handoff_notes RENAME TO handoff_notes_old`);
        db.exec(`
          CREATE TABLE handoff_notes (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            decisions TEXT NOT NULL DEFAULT '',
            remaining_work TEXT NOT NULL DEFAULT '',
            discoveries TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          )
        `);
        db.exec(`
          INSERT INTO handoff_notes (id, task_id, session_id, decisions, remaining_work, discoveries, created_at)
          SELECT id, task_id, session_id, decisions, remaining_work, discoveries, created_at FROM handoff_notes_old
        `);
        db.exec(`DROP TABLE handoff_notes_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_handoff_notes_task_id ON handoff_notes(task_id)`);
      }
    });

    rebuild.immediate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Gives every project that predates `code_prefix` one derived from its name,
 * so task codes (`TTM-42`) work on an existing tracker.db without anyone
 * having to name a prefix by hand. Projects are walked in creation order, and
 * the set of prefixes already handed out grows as we go, so a collision
 * between two *derived* prefixes resolves deterministically in favour of the
 * older project (`g-mesh` keeps `GM`, a later `game-mode` becomes `GM2`) - a
 * prefix, once assigned, is a stable public handle and must never shift under
 * an existing project.
 *
 * Cheap enough to call on every startup: the only query that runs on an
 * already-backfilled DB is the single SELECT below, which finds nothing to do.
 */
function backfillProjectPrefixes(db: DatabaseInstance): void {
  const projects = db
    .prepare(`SELECT id, name, code_prefix FROM projects ORDER BY created_at ASC, rowid ASC`)
    .all() as Array<{ id: string; name: string; code_prefix: string | null }>;

  const unprefixed = projects.filter((project) => project.code_prefix === null);
  if (unprefixed.length === 0) return;

  const taken = new Set(
    projects
      .map((project) => project.code_prefix)
      .filter((prefix): prefix is string => prefix !== null),
  );
  const update = db.prepare(`UPDATE projects SET code_prefix = ? WHERE id = ?`);

  db.transaction(() => {
    for (const project of unprefixed) {
      const prefix = dedupePrefix(derivePrefix(project.name), taken);
      taken.add(prefix);
      update.run(prefix, project.id);
    }
  })();
}

/**
 * Numbers every pre-existing task 1..N within its project, in creation order,
 * so the display codes read as a history of the project rather than in
 * whatever order the backfill happened to visit rows.
 *
 * Numbering resumes from the project's current MAX rather than restarting at
 * 1, which matters for the partially-numbered case: a DB migrated by an older
 * build and then written to by a newer one would otherwise hand already-taken
 * numbers to the un-numbered leftovers. `rowid` breaks created_at ties -
 * create_tasks stamps a whole batch with millisecond-identical timestamps, so
 * created_at alone leaves the order inside a batch up to SQLite; rowid falls
 * back to actual insertion order.
 */
function backfillTaskNumbers(db: DatabaseInstance): void {
  const projectIds = (
    db.prepare(`SELECT DISTINCT project_id FROM tasks WHERE task_number IS NULL`).all() as Array<{
      project_id: string;
    }>
  ).map((row) => row.project_id);
  if (projectIds.length === 0) return;

  const maxNumber = db.prepare(
    `SELECT COALESCE(MAX(task_number), 0) AS max FROM tasks WHERE project_id = ?`,
  );
  const unnumbered = db.prepare(
    `SELECT id FROM tasks WHERE project_id = ? AND task_number IS NULL ORDER BY created_at ASC, rowid ASC`,
  );
  const update = db.prepare(`UPDATE tasks SET task_number = ? WHERE id = ?`);

  db.transaction(() => {
    for (const projectId of projectIds) {
      let next = (maxNumber.get(projectId) as { max: number }).max + 1;
      for (const task of unnumbered.all(projectId) as Array<{ id: string }>) {
        update.run(next, task.id);
        next += 1;
      }
    }
  })();
}

/**
 * `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL only shapes brand-new databases -
 * it's a no-op against tables that already exist (e.g. this project's own
 * ~/.task-tracker/tracker.db). New nullable columns need an explicit
 * ALTER TABLE so existing databases pick them up too.
 *
 * A new *table* is the exception and needs nothing here: it doesn't exist
 * yet in any database, so `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL creates
 * it on old and new ones alike (openDatabase execs SCHEMA_SQL on every open,
 * before calling this). That is why `release_plans`/`release_plan_items` are
 * absent below and why adding an entry for them would be dead code - unlike
 * tasks.priority or tasks.release_id, there is no ADD COLUMN to sequence and
 * no ordering constraint against the CHECK-widening rebuilds.
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
  // Must run before widenReleaseStatusCheck(), for the same reason tasks'
  // cancellation_reason has to precede widenTaskStatusCheck(): the rebuild
  // copies this column out of releases_old, which only has it once this
  // ensureColumn has already added it.
  ensureColumn(db, "releases", "cancellation_reason", "TEXT");
  // Order relative to the tasks.release_id lines above doesn't matter (the
  // rebuild preserves that FK either way - see widenReleaseStatusCheck), but
  // they're kept adjacent since they're the two halves of the same
  // task<->release relationship.
  widenReleaseStatusCheck(db);
  ensureColumn(db, "tasks", "completion_summary", "TEXT");
  ensureColumn(db, "projects", "code_prefix", "TEXT");
  // Nullable with no default (so the backfill below can tell "never assigned"
  // from "assigned") and added *after* widenTaskStatusCheck - its rebuild
  // recreates `tasks` from a fixed column list that doesn't include this one,
  // so adding it earlier would just be dropped again.
  ensureColumn(db, "tasks", "task_number", "INTEGER");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name)`);
  // A task code (`TTM-63`) is only a unique handle if prefixes are unique.
  // `dedupePrefix` already guarantees that at assignment time, in both
  // createProject and the backfill - but that is application code, and a code
  // is now something branches, commits and summaries are written against.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_code_prefix ON projects(code_prefix)`);
  // Both no-op after the first run (each starts with a "what's still NULL?"
  // query that comes back empty), so they're safe on every startup. Order
  // matters only in that both must follow their ensureColumn above.
  backfillProjectPrefixes(db);
  backfillTaskNumbers(db);
  // No ordering constraint relative to widenTaskStatusCheck() above - this
  // repairs damage from *previous* runs of it (see repairDanglingTasksOldReferences),
  // it doesn't interact with a fresh run happening in this same call.
  repairDanglingTasksOldReferences(db);
}
