import fs from "node:fs";
import path from "node:path";
import type { DatabaseInstance } from "../db/connection.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { getProject } from "./projects.js";

/**
 * Backup export (docs/design/backup-restore.md, TTM-106). The file is one
 * canonical JSON document: an envelope versioned by FORMAT_VERSION, rows
 * versioned by SCHEMA_VERSION, every project-owned row as a column -> value
 * object read with `SELECT *`.
 */

export const FORMAT_NAME = "task-tracker-export";
/** Versions the envelope shape (D1); moves independently of SCHEMA_VERSION. */
export const FORMAT_VERSION = 1;

/** SQL for the selected project ids, bound as a JSON array to `:ids`. */
const IDS = `(SELECT value FROM json_each(:ids))`;
const TASKS_OF_IDS = `(SELECT id FROM tasks WHERE project_id IN ${IDS})`;

export interface BackupTable {
  table: string;
  /** WHERE predicate selecting the rows owned by the projects in `:ids` (D4). */
  owner: string;
  /** Deterministic row order: the PK, or the full column tuple without one (D5). */
  orderBy: string;
}

/**
 * Every exported table, parent-first (an import inserts in this order).
 * `projects` is the head; each other table hangs off it through `owner`.
 * The table guard test requires BACKUP_TABLES + EXCLUDED_TABLES to equal the
 * tables of a fresh database exactly. New columns need no change here.
 */
export const BACKUP_TABLES: readonly BackupTable[] = [
  { table: "projects", owner: `id IN ${IDS}`, orderBy: "created_at, id" },
  { table: "epics", owner: `project_id IN ${IDS}`, orderBy: "id" },
  { table: "releases", owner: `project_id IN ${IDS}`, orderBy: "id" },
  { table: "tasks", owner: `project_id IN ${IDS}`, orderBy: "id" },
  {
    table: "release_plans",
    owner: `release_id IN (SELECT id FROM releases WHERE project_id IN ${IDS})`,
    orderBy: "id",
  },
  {
    table: "release_plan_items",
    owner:
      `plan_id IN (SELECT rp.id FROM release_plans rp JOIN releases r ON r.id = rp.release_id ` +
      `WHERE r.project_id IN ${IDS})`,
    orderBy: "plan_id, task_id",
  },
  // The dependent side owns the edge, even when depends_on_task_id belongs to
  // another project (D9).
  { table: "task_dependencies", owner: `task_id IN ${TASKS_OF_IDS}`, orderBy: "task_id, depends_on_task_id" },
  // No PK: ordered by the full column tuple; rowid is not data and is not exported.
  { table: "task_files", owner: `task_id IN ${TASKS_OF_IDS}`, orderBy: "task_id, file_path" },
  { table: "handoff_notes", owner: `task_id IN ${TASKS_OF_IDS}`, orderBy: "id" },
  { table: "task_amendments", owner: `task_id IN ${TASKS_OF_IDS}`, orderBy: "id" },
  { table: "task_slices", owner: `task_id IN ${TASKS_OF_IDS}`, orderBy: "id" },
  { table: "task_slice_revisions", owner: `task_id IN ${TASKS_OF_IDS}`, orderBy: "id" },
];

/**
 * Tables deliberately left out of backups. Only a table that is not owned by
 * a project, or that is derived and rebuilt from other rows, may go here, each
 * with a comment saying why. Empty today: all twelve tables are project-owned.
 */
export const EXCLUDED_TABLES: readonly string[] = [];

export type BackupRow = Record<string, unknown>;

export interface ExportProjectEntry {
  project: BackupRow;
  /** Every BACKUP_TABLES table except `projects`, possibly empty. */
  rows: Record<string, BackupRow[]>;
}

export interface ExportDocument {
  exported_at: string;
  format: typeof FORMAT_NAME;
  format_version: number;
  schema_version: number;
  projects: ExportProjectEntry[];
}

export type BackupRefusalCode =
  | "unsupported_format"
  | "schema_mismatch"
  | "clash"
  | "dangling_reference"
  | "unknown_project"
  | "forbidden_out_path";

/** A typed refusal shared by the CLI bins and the MCP tools: same code, same message. */
export class BackupRefusal extends Error {
  constructor(
    readonly code: BackupRefusalCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BackupRefusal";
  }
}

/** One project reference (id or name), or every project. */
export type ExportSelection = string | { all: true };

/**
 * Resolves a selection to project ids ordered by `created_at, id`. Single
 * and `--all` share every later step; a single project is a one-element list.
 */
export function resolveSelection(db: DatabaseInstance, selection: ExportSelection): string[] {
  if (typeof selection !== "string") {
    const rows = db.prepare(`SELECT id FROM projects ORDER BY created_at, id`).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
  // getProject returns undefined only when nothing matches, so a DB error
  // propagates instead of being reported as an unknown project.
  const project = getProject(db, selection);
  if (!project) {
    throw new BackupRefusal("unknown_project", `Unknown project: ${selection}`, { ref: selection });
  }
  return [project.id];
}

export interface ExportOptions {
  now?: () => Date;
}

/**
 * Reads the selected projects into an ExportDocument inside one read
 * transaction, so every SELECT (selection included) sees one WAL snapshot.
 */
export function exportProjects(
  db: DatabaseInstance,
  selection: ExportSelection,
  { now = () => new Date() }: ExportOptions = {},
): ExportDocument {
  const statements = BACKUP_TABLES.map((t) => ({
    table: t.table,
    stmt: db.prepare(`SELECT * FROM ${t.table} WHERE ${t.owner} ORDER BY ${t.orderBy}`),
  }));

  const read = db.transaction((): ExportProjectEntry[] => {
    const ids = resolveSelection(db, selection);
    return ids.map((id) => {
      const params = { ids: JSON.stringify([id]) };
      let project: BackupRow | undefined;
      const rows: Record<string, BackupRow[]> = {};
      for (const { table, stmt } of statements) {
        const result = stmt.all(params) as BackupRow[];
        if (table === "projects") project = result[0];
        else rows[table] = result;
      }
      if (!project) {
        throw new BackupRefusal("unknown_project", `Unknown project: ${id}`, { ref: id });
      }
      return { project, rows };
    });
  });

  return {
    exported_at: now().toISOString(),
    format: FORMAT_NAME,
    format_version: FORMAT_VERSION,
    schema_version: SCHEMA_VERSION,
    projects: read(),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical JSON: keys sorted at every level, 2-space indentation, trailing
 * newline. `exported_at` sorts first and sits on its own line.
 */
export function serializeExport(doc: ExportDocument): string {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}

/** `dirname` resolved through symlinks, basename kept; undefined when the directory is missing. */
function realTarget(p: string): string | undefined {
  const abs = path.resolve(p);
  try {
    return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {
    return undefined;
  }
}

function sameExistingFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Refuses (`forbidden_out_path`) an out path that is the open database file or
 * its `-wal`/`-shm` companion, compared after resolving the parent directory
 * through symlinks (and by inode when both files exist). The DB side covers
 * both its directory-resolved path and the fully resolved file (a symlinked
 * DB file keeps its -wal/-shm beside the real file). Skipped for an
 * in-memory database. A missing parent directory is left to the write to fail.
 */
export function assertOutPathAllowed(db: DatabaseInstance, outPath: string): void {
  if (db.memory || db.name === ":memory:" || db.name === "") return;
  const out = realTarget(outPath);
  if (!out) return;
  // SQLite keeps -wal/-shm next to the file the DB path finally resolves to,
  // so a symlinked DB file protects the real file's siblings; the symlink
  // path's own siblings are kept as well.
  const dbFiles = new Set<string>();
  const viaDir = realTarget(db.name);
  if (viaDir) dbFiles.add(viaDir);
  try {
    dbFiles.add(fs.realpathSync(db.name));
  } catch {
    // DB file not on disk (yet): the directory-resolved path is all there is.
  }
  const forbiddenPaths = [...dbFiles].flatMap((f) => [f, `${f}-wal`, `${f}-shm`]);
  for (const forbidden of forbiddenPaths) {
    if (out === forbidden || sameExistingFile(out, forbidden)) {
      throw new BackupRefusal(
        "forbidden_out_path",
        `Refusing to write the export over the database file: ${forbidden}`,
        { out_path: outPath, forbidden },
      );
    }
  }
}

/**
 * Writes `text` to `<outPath>.tmp-<pid>` in the same directory, then renames
 * it over `outPath`: an existing file is replaced atomically, and a failure
 * leaves neither a partial `outPath` nor the temp file.
 */
export function writeExportFile(outPath: string, text: string): void {
  const target = path.resolve(outPath);
  const tmp = path.join(path.dirname(target), `${path.basename(target)}.tmp-${process.pid}`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface ExportResult {
  path: string;
  projects: Array<{ id: string; name: string }>;
  /** Exported rows per BACKUP_TABLES table, summed over the selection. */
  counts: Record<string, number>;
  /** Exported dependency edges whose depends_on task is outside the selection (D9). */
  external_dependencies: number;
}

/** Counts rows per table and edges pointing outside the exported tasks. */
export function summarizeExport(doc: ExportDocument): Omit<ExportResult, "path"> {
  const counts: Record<string, number> = {};
  for (const { table } of BACKUP_TABLES) counts[table] = 0;
  const taskIds = new Set<string>();
  for (const entry of doc.projects) {
    counts.projects += 1;
    for (const [table, rows] of Object.entries(entry.rows)) counts[table] += rows.length;
    for (const task of entry.rows.tasks ?? []) taskIds.add(task.id as string);
  }
  let external = 0;
  for (const entry of doc.projects) {
    for (const edge of entry.rows.task_dependencies ?? []) {
      if (!taskIds.has(edge.depends_on_task_id as string)) external += 1;
    }
  }
  return {
    projects: doc.projects.map((e) => ({ id: e.project.id as string, name: e.project.name as string })),
    counts,
    external_dependencies: external,
  };
}

/**
 * The one export entry point for the CLI and the MCP tool: refuse forbidden
 * targets, resolve and read in one snapshot (unknown project refuses before
 * any file is touched), serialise, write atomically.
 */
export function exportToFile(
  db: DatabaseInstance,
  selection: ExportSelection,
  outPath: string,
  options: ExportOptions = {},
): ExportResult {
  assertOutPathAllowed(db, outPath);
  const doc = exportProjects(db, selection, options);
  const target = path.resolve(outPath);
  writeExportFile(target, serializeExport(doc));
  return { path: target, ...summarizeExport(doc) };
}
