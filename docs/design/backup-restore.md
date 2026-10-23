# Backup & restore: TTM-106 export, TTM-107 import, TTM-108 MCP tools

Status: draft for owner review, 2026-10-23.
Branch `feat/TTM-106-export-projects`, off `release-0.15.0`.

One note for the whole epic: the three tasks share one file format, one table
registry and one domain module, so they are designed together and built in
order 106 -> 107 -> 108.

## What exists today (facts the design rests on)

- Twelve tables, all project-owned, none excluded (src/db/schema.ts:1-230;
  tests/db.test.ts:4-30 pins the exact list). No `AUTOINCREMENT` (so no
  `sqlite_sequence`), no triggers, no views, no FTS. The live DB confirms it
  (`sqlite_master` read-only probe, 2026-10-23). `*_old` tables exist only
  transiently inside the CHECK-widening rebuilds.
- No schema version: `PRAGMA user_version` is 0 on the live DB; migrations in
  `runMigrations` (schema.ts:636-706) probe columns with `ensureColumn` and
  are idempotent.
- Column order differs between DBs at the same logical schema: a fresh DB gets
  `code_prefix`, `task_number`, ... at their SCHEMA_SQL positions, an old one
  gets them appended by `ALTER TABLE`. Anything positional (`SELECT *` row
  arrays, a hash of `sqlite_master.sql`) is therefore not comparable across DBs.
- Counters are derived from stored rows, not from a sequence table:
  `nextTaskNumber` = `MAX(task_number)+1` per project (src/domain/tasks.ts:48),
  release `sequence` = `MAX(sequence)+1` (src/domain/releases.ts:47), slice
  `label_number` is stored. Inserting rows with their original values is
  enough; nothing to reset afterwards.
- Unique constraints an import can hit: `projects.id`, `idx_projects_name`,
  `idx_projects_code_prefix` (schema.ts:681, 686), plus every PK.
- Cross-project references are not guarded by the domain: `addDependency`
  (src/domain/dependencies.ts:29-49) accepts a dependency on another project's
  task. The live DB has two: GMB-22 -> GM-79 and GMB-22 -> GM-80. Epics,
  releases and plans are resolved inside their project (epics.ts:58,
  releases.ts:97), and the live DB has 0 cross-project
  `tasks.epic_id`/`tasks.release_id`/`release_plan_items.task_id` rows.
- Paths: `projects.root_path` is absolute; `design_doc_path` is relative to it
  (`hashDesignDoc` does `path.resolve(rootPath, designDocPath)`,
  src/domain/projects.ts:76-83); `design_doc_hash` is a sha256 of the doc's
  content, not of its path. `task_files.file_path` is free text (2 absolute
  rows in the live DB, none under their project's root). `task_slices.artifacts`
  is a JSON array of repo-relative paths.
- DB path: `defaultDbPath()` = `TASK_TRACKER_DB_PATH` or
  `~/.task-tracker/tracker.db`; `openDatabase()` turns on `foreign_keys`,
  `busy_timeout = 5000`, WAL, then runs SCHEMA_SQL + migrations
  (src/db/connection.ts:7-31). Every bin calls `openDatabase()` with no
  argument (src/cli/status.ts:29) and is listed in package.json `bin` as
  `dist/cli/<name>.js`, with a `#!/usr/bin/env node` shebang.
- MCP tools: one `register<Area>Tools(server, db)` per file in
  src/mcp/tools/, wired in `createServer` (src/mcp/server.ts:16-36). Results go
  through `jsonResult`/`errorResult` (src/mcp/toolResult.ts); typed domain
  errors are mapped to named results in a `try/catch` (lifecycle.ts:41-60 is
  the pattern).

## Decisions

### D1. File format

```json
{
  "exported_at": "2026-10-23T12:00:00.000Z",
  "format": "task-tracker-export",
  "format_version": 1,
  "projects": [
    {
      "project": { "code_prefix": "TTM", "created_at": "...", "design_doc_hash": null, ... },
      "rows": {
        "epics": [ ... ], "handoff_notes": [ ... ], "release_plan_items": [ ... ],
        "release_plans": [ ... ], "releases": [ ... ], "task_amendments": [ ... ],
        "task_dependencies": [ ... ], "task_files": [ ... ],
        "task_slice_revisions": [ ... ], "task_slices": [ ... ], "tasks": [ ... ]
      }
    }
  ],
  "schema_version": 1
}
```

- Each row is an object of column name -> value, every column present (NULL as
  `null`), values exactly as better-sqlite3 returns them. JSON-in-TEXT columns
  (`artifacts`, `metrics`, `replaced_slices`, `previous_value`) stay strings,
  never parsed: lossless and schema-agnostic.
  Trade-off: the file is less readable for those columns; in exchange nothing
  is re-serialised.
- `format_version` versions the envelope (this shape); `schema_version` versions
  the rows (D2). They move independently.
- Single project and `--all` produce the same shape; single is just a
  one-element `projects` array. One code path: the selection is a list of
  project ids (one, or all).

### D2. schema_version: a hand-bumped constant pinned by a fingerprint test

`export const SCHEMA_VERSION = 1` in src/db/schema.ts, plus a guard test that
computes a normalised fingerprint of a fresh `openDatabase(":memory:")` - for
each table in name order, its columns in name order as
`name|type|notnull|dflt_value|pk` from `PRAGMA table_info` - and asserts
`{ SCHEMA_VERSION, fingerprint }` equals a literal kept in the test. Any column
or table change breaks the test, and the fix is to bump the constant and update
the literal in the same commit. Import additionally compares each table's
column-name set in the file with the target's `PRAGMA table_info` (runtime
safety net).

Trade-off: needs a human bump (the test forces it, so it cannot be forgotten);
rejected alternatives -
`PRAGMA user_version` would be a second copy of the same constant written by
`openDatabase`, and adds a write on open of every DB for no extra guarantee; a
runtime hash of `sqlite_master.sql` differs between a fresh and a migrated DB
(column order, rebuilt CHECK text) at the same logical schema, so it would
refuse valid imports.

Import rule: `schema_version > SCHEMA_VERSION` -> refuse "file is newer than
this build"; `< SCHEMA_VERSION` -> refuse "older schema, no upgrade path yet"
(see Must confirm 1). Both before any write.

### D3. Table registry and the guard test

`BACKUP_TABLES` in src/domain/backup.ts: an ordered array of
`{ table, owner, orderBy }`, parent-first (D5 order). `projects` is the head;
the other eleven carry an ownership predicate (D4). `EXCLUDED_TABLES` is an
empty array with a comment saying what may go there (non-project-owned or
derived tables) and why each entry is excluded.

Guard test: `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT
LIKE 'sqlite_%'` on a fresh DB must equal `BACKUP_TABLES ∪ EXCLUDED_TABLES`,
exactly. A table added to SCHEMA_SQL without a registry entry fails it (and so
does the fingerprint test of D2). New *columns* need no registry change:
export reads `SELECT *` and writes by name.

Trade-off: two guard tests (tables here, columns in D2) instead of one, but
each failure message says exactly what to do.

### D4. Ownership: how each table hangs off a project

`:ids` = the selected project ids (bound as a JSON array via
`json_each(:ids)`, so one query per table serves single and `--all`).

| table | owner predicate | orderBy |
|---|---|---|
| projects | `id IN ids` | `created_at, id` |
| epics | `project_id IN ids` | `id` |
| releases | `project_id IN ids` | `id` |
| tasks | `project_id IN ids` | `id` |
| release_plans | `release_id IN (SELECT id FROM releases WHERE project_id IN ids)` | `id` |
| release_plan_items | `plan_id IN (SELECT rp.id FROM release_plans rp JOIN releases r ON r.id = rp.release_id WHERE r.project_id IN ids)` | `plan_id, task_id` |
| task_dependencies | `task_id IN (SELECT id FROM tasks WHERE project_id IN ids)` (the dependent side owns the edge) | `task_id, depends_on_task_id` |
| task_files | `task_id IN (tasks of ids)` | `task_id, file_path` |
| handoff_notes | `task_id IN (tasks of ids)` | `id` |
| task_amendments | `task_id IN (tasks of ids)` | `id` |
| task_slices | `task_id IN (tasks of ids)` | `id` |
| task_slice_revisions | `task_id IN (tasks of ids)` | `id` |

Rows are grouped per project afterwards (the per-project split uses the same
predicates with a single id). Every row has exactly one owner, so with `--all`
the per-table sums equal `SELECT COUNT(*)`.

`task_files` has no PK; `rowid` is not exported (it is not data and would not
survive import). `(task_id, file_path)` order matches what `listTaskFilePaths`
already returns (tasks.ts:203-210, `ORDER BY file_path`). Duplicate
`(task_id, file_path)` pairs are possible in principle (no unique index; 0 in
the live DB); they export as identical adjacent rows and round-trip fine.

Trade-off: per-project grouping costs a second pass over rows in memory; it
buys a file where one project's data can be read or cut out on its own.

### D5. Determinism

- One read transaction: `db.transaction(() => { ...all SELECTs... })()`. In
  WAL every read in it sees one snapshot, so a concurrently running MCP server
  cannot tear the export. (A deferred transaction takes its snapshot at the
  first read; all reads are inside.)
- Keys sorted alphabetically at every level (envelope, project entry, `rows`,
  each row) by a recursive canonicaliser before `JSON.stringify(value, null,
  2)`, plus a trailing `\n`. Sorted row keys also erase the column-order
  difference between fresh and migrated DBs.
- Row order: the table's PK, or the full column tuple where there is no PK
  (D4); projects by `created_at, id`.
- `exported_at`: the domain function takes `now: () => Date` (default the real
  clock); the CLI and MCP tool use the real clock. "Two exports of an unchanged
  DB are byte-identical" is pinned with an injected fixed clock, and a second
  test pins that two real-clock exports differ *only* on the `exported_at` line
  (it is on its own line because of 2-space indentation).
  Trade-off: byte-identity holds for a fixed clock, not for wall-clock runs;
  the rejected alternatives were dropping `exported_at` (loses the one field a
  person reads first) or deriving it from the data's max timestamp (wrong name
  for what it is).

### D6. Writing the export file

Resolve the selection first (unknown project -> `Unknown project: <ref>`,
non-zero exit, no file touched), run the read transaction, serialise, then
write `<out>.tmp-<pid>` in the same directory and `rename` it over `<out>`. A
failure at any step leaves no file and no partial file.
Trade-off: overwrites an existing `<out>` silently (see Must confirm 3).

### D7. Import

Order of operations - everything up to step 5 runs before any write:

1. Parse JSON; refuse non-object / missing `format` / `format !==
   "task-tracker-export"` / `format_version !== 1` (`unsupported_format`).
2. `schema_version` against `SCHEMA_VERSION` (D2) (`schema_mismatch`).
3. Shape: each project entry has `project` and `rows`; `rows` keys equal the
   registry minus `projects`; each row's key set equals the target table's
   column set (`schema_mismatch`, naming table and column).
4. Root-path map (D8) applied in memory; malformed `old=new` -> usage error.
5. Clash: every file project's `id`, `name` and `code_prefix` checked against
   the target `projects` table, and against each other inside the file; any
   hit refuses the whole import naming each clash (`clash`, e.g.
   `project name already exists: task-tracker-mcp`). `code_prefix` is
   included because `idx_projects_code_prefix` is unique and a remapped prefix
   would break every task code written into commits.
6. Reference closure: every FK value in the file (`tasks.epic_id`,
   `tasks.release_id`, `release_plans.release_id`, `release_plan_items.plan_id`
   and `.task_id`, `task_dependencies.*`, every `task_id`) must resolve to a
   row in the file. The only exception is a `task_dependencies.depends_on_task_id`
   pointing outside the file (cross-project edge): see D9.
7. One write transaction, `foreign_keys` left ON (it cannot be toggled inside a
   transaction, and keeping it on means SQLite re-checks step 6). Inserts are
   by table, across all projects, in registry order: projects, epics,
   releases, tasks, release_plans, release_plan_items, task_dependencies,
   task_files, handoff_notes, task_amendments, task_slices,
   task_slice_revisions. Table-major rather than project-major so an edge
   between two projects in the same file finds both tasks. Each insert is
   `INSERT INTO t (<sorted cols>) VALUES (...)`, by name, never positional.
   Any SQLite error (e.g. a UUID PK clash on a non-project table, practically
   impossible) rolls the whole transaction back.

Preserved as-is: UUIDs, `task_number`, `sequence`, `label_number`, all
timestamps, leases (`owner_session_id`, `lock_expires_at` - a lapsed lease is
reclaimable as on the source), `design_doc_hash`. No trigger or counter needs
touching (none exists; D-facts above). Import never re-hashes the design doc:
the hash is the reconciled baseline, and `check_doc_sync` on the target then
truthfully reports whether the doc at the new root still matches it.

Result: `{ projects: [{ id, name, code_prefix }], counts: { <table>: n } }`
where counts are rows inserted.

Trade-off: a pre-check (steps 1-6) duplicates some of what FKs and unique
indexes would catch, but it is what lets the refusal name the problem and
guarantee nothing was written.

### D8. Root-path map scope

`--root-path-map old=new` (repeatable; split on the first `=`; both sides
`path.resolve`d, trailing slash stripped). For each project, the longest `old`
that equals `root_path` or is a prefix of it at a `/` boundary is replaced by
`new`. Also rewritten: `design_doc_path` only when it is absolute and under
`old` (relative ones, the normal case, follow the root automatically). Not
rewritten: `task_files.file_path`, `task_slices.artifacts`, any free text -
they are history, not live locations. A map entry that matches no project is
reported in the result (`unused_root_path_maps`), not refused.

Trade-off: absolute paths inside task files/artifacts keep pointing at the
old machine; rewriting free text was judged riskier than stale history.

### D9. Cross-project dependency edges (the GMB-22 -> GM-79 case)

Export: an edge belongs to its dependent task's project and is exported with
it even when the other end is outside the selection; the export result counts
them (`external_dependencies`).

Import: such an edge is inserted when its `depends_on_task_id` exists in the
target DB or the file; otherwise it is skipped and listed in the result
(`skipped_dependencies: [{ task_id, depends_on_task_id }]`), not refused.
Recommended because a dependency on another project's task is an annotation,
and refusing would make a single-project backup of GMB unrestorable into an
empty DB. Any other dangling reference is refused (step 6). See Must confirm 2.

### D10. Bins

`src/cli/export.ts` -> `task-tracker-export`, `src/cli/import.ts` ->
`task-tracker-import`, both `#!/usr/bin/env node`, `openDatabase()` with no
argument (so `TASK_TRACKER_DB_PATH` works as for every other bin), argv parsed
with `node:util` `parseArgs` (strict). Exit codes: 0 ok, 1 refusal or error
(message on stderr, naming the cause), 2 usage error. stdout on success: the
out path and per-table counts, one line per table. `--all` and a project ref
are mutually exclusive; neither -> usage error.

Note: `openDatabase()` runs migrations, so exporting from an older-schema DB
migrates it first (same as `task-tracker-status`). For import into a missing
path, `openDatabase` creates a fresh DB - that is the "restore into empty DB"
path.

### D11. MCP tools (TTM-108)

`src/mcp/tools/backup.ts`, `registerBackupTools(server, db)`, registered in
`createServer` after `registerSliceTools`.

- `export_projects { project_id?: string, all?: boolean, out_path: string }` ->
  `{ path, projects: [{ id, name }], counts, external_dependencies }`.
- `import_projects { path: string, root_path_map?: Record<string, string> }` ->
  `{ path, projects: [{ id, name, code_prefix }], counts,
  skipped_dependencies, unused_root_path_maps }`.
- Never the JSON body in a result.
- `out_path`/`path` must be absolute (the server's cwd is whatever the client
  launched it in) -> `errorResult` otherwise. Exactly one of `project_id`/`all`.
- Refusals: domain throws `BackupRefusal` with `code` in
  `unsupported_format | schema_mismatch | clash | dangling_reference |
  unknown_project`; the tool maps it to
  `{ error: code, message, details }` with `isError: true` (new
  `backupRefusalResult` in toolResult.ts, same style as `conflictResult`). The
  CLI prints the same message. Same refusals, one source.

Trade-off: absolute-only paths are less convenient for a human typing into a
chat, but remove any guess about which directory a relative path means.

## Edit map

### TTM-106 code slice (export)

- src/db/schema.ts: add `export const SCHEMA_VERSION = 1;` after SCHEMA_SQL
  (after line 230), with a comment pointing at the fingerprint test. Read for
  context: `runMigrations` (636-706), `ensureColumn` (235-240).
- src/domain/backup.ts (new): `BACKUP_TABLES`, `EXCLUDED_TABLES`,
  `FORMAT_VERSION`, `ExportDocument` type, `BackupRefusal` class,
  `resolveSelection(db, ref | { all: true })` (uses `requireProject`,
  projects.ts:101-107, throwing `BackupRefusal("unknown_project")`),
  `exportProjects(db, selection, { now })` (one read transaction),
  `serializeExport(doc)` (canonical JSON), `writeExportFile(outPath, text)`
  (tmp + rename), `exportToFile(db, selection, outPath, { now })` returning
  `{ path, projects, counts, external_dependencies }` (the one entry point the
  CLI and MCP tool both call).
- src/cli/export.ts (new): copy the shape of src/cli/status.ts:28-57.
- package.json: `bin` (lines 8-12) add `task-tracker-export`; `scripts`
  (13-22) optional `export` alias.
- README.md: a bins paragraph next to the existing ones (lines ~59-90).
- tests: tests/backup-export.test.ts (domain), tests/schema-version.test.ts
  (fingerprint), CLI cases spawned with the `runCli` pattern of
  tests/cli.test.ts:37-63 (tsx + `TASK_TRACKER_DB_PATH`).

### TTM-107 code slice (import)

- src/domain/backup.ts: `parseExport(text)` (steps 1-3),
  `parseRootPathMap(entries)`, `applyRootPathMap(doc, map)` (D8),
  `findClashes(db, doc)` (step 5), `checkReferences(db, doc)` (step 6, D9),
  `importProjects(db, doc, { rootPathMap })` (step 7), `importFromFile(db,
  path, opts)` - the shared entry point.
- src/cli/import.ts (new); package.json `bin` add `task-tracker-import`;
  README.
- tests: tests/backup-import.test.ts, round trip in the same file, CLI cases.
  Read for context: `getProjectStatus` (src/domain/status.ts:624), `listTasks` (:553),
  `getNextTask` (:489), used for
  the equivalence test.

### TTM-108 code slice (MCP)

- src/mcp/tools/backup.ts (new): `registerBackupTools`; pattern from
  src/mcp/tools/projects.ts and the catch mapping of lifecycle.ts:41-60.
- src/mcp/toolResult.ts: add `backupRefusalResult`.
- src/mcp/server.ts: import (lines 5-13) and register after line 34.
- tests/mcp-smoke.test.ts: add both names to the exact tool list (62-103) and
  an end-to-end export -> import over `InMemoryTransport` into a second DB.

## Behaviours to pin

### TTM-106

1. Per table, exported row count == `SELECT COUNT(*)` with the D4 predicate;
   with `--all`, == unfiltered `SELECT COUNT(*)` for all twelve tables.
2. Every column of every table appears in every row (incl. NULLs), keys sorted.
3. Fixed clock: two exports of an unchanged DB are byte-identical. Real clock:
   they differ only on the `exported_at` line.
4. A DB built by migrating a legacy fixture (different physical column order)
   and a fresh DB with the same rows export byte-identically (fixed clock).
5. Table guard: a table created in the test DB that is in neither registry
   fails the guard (control: add `CREATE TABLE extra(...)` to SCHEMA_SQL).
6. Fingerprint: `{SCHEMA_VERSION, fingerprint}` equals the literal; a migrated
   legacy DB has the same fingerprint as a fresh one.
7. Unknown project -> exit 1, stderr names it, `--out` path does not exist
   afterwards (also when it did not exist before; and an existing file is not
   modified - only if Must confirm 3 picks refuse/keep).
8. Consistency under a concurrent writer: rows written by a second connection
   after the export's transaction started are absent from the file (one
   snapshot).
9. Single project and `--all` go through the same function (an `--all` export
   of a one-project DB equals that project's single export).
10. Cross-project edge is exported with its dependent task and counted in
    `external_dependencies`.

### TTM-107

1. Round trip: export (fixed clock) -> import into empty DB -> export (same
   clock) is byte-identical, for a DB exercising every table (incl. a slice
   revision, an amendment, a plan with items, an in_progress task with a lease,
   a cancelled release).
2. Clash on id, on name, on code_prefix: non-zero exit naming the clash; target
   DB byte-for-byte unchanged (compare a full export before/after).
3. `format_version` unknown, `format` missing, newer `schema_version`, older
   `schema_version`, extra/missing column: refused before any write.
4. Imported DB answers `get_project_status`, `list_tasks`, `get_next_task` the
   same as the source (same root_path, so doc drift matches too).
5. After import, `create_task` gets `MAX(task_number)+1` and `create_release`
   gets the next `sequence` (counters continue, not restart).
6. `--root-path-map`: root_path rewritten at prefix boundary only
   (`/a/b` does not match `/a/bc`); relative `design_doc_path` untouched;
   `design_doc_hash` untouched; unused map reported.
7. Mid-transaction failure (e.g. a forged PK clash in `handoff_notes`) leaves
   the target unchanged.
8. Cross-project edge: inserted when the target task exists, skipped and
   listed when not (per Must confirm 2's answer).

### TTM-108

1. Both tools in the exact smoke list; results contain path and counts and no
   row data (assert result text length is small / has no `rows` key).
2. Relative paths refused; both or neither of `project_id`/`all` refused.
3. Each `BackupRefusal` code reaches the client as `isError` with the same
   message the CLI prints.
4. Export -> import over the transport into a second DB matches the CLI round
   trip.

## Must confirm (owner)

1. Older `schema_version` in the file: refuse (recommended for v1: no upgrade
   path is written yet, and an import that relies on column defaults could
   silently invent values) vs. accept when the file's columns are a subset and
   the missing ones have defaults.
2. Cross-project dependency edges on import (live case GMB-22 -> GM-79/80):
   skip-and-report (recommended) vs. refuse the import vs. a flag.
3. Existing `--out` file: overwrite atomically (recommended; scripted backups
   reuse names) vs. refuse unless `--force`.
4. `--root-path-map` leaves `task_files` and `artifacts` absolute paths
   unchanged (recommended) - or should prefix-matching absolute paths there be
   rewritten too?
5. Export via MCP writes a file on the server's host with the server's
   permissions; is any directory restriction wanted (e.g. refuse writing into
   `~/.task-tracker/` itself, so a backup cannot overwrite `tracker.db`)?
   Recommended: refuse `out_path` equal to the DB path or its `-wal`/`-shm`.
