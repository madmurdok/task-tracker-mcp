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

// ---------------------------------------------------------------------------
// Import (TTM-107, D7-D9). Steps 1-6 only read; step 7 is one write
// transaction. Every refusal is a BackupRefusal thrown before any insert.
// ---------------------------------------------------------------------------

/** Registry tables other than `projects`, in insert order. */
const ROW_TABLES = BACKUP_TABLES.map((t) => t.table).filter((t) => t !== "projects");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Steps 1-2 and the shape part of step 3 (D7) on an already parsed value:
 * envelope `format`/`format_version`, `schema_version` against
 * `currentSchemaVersion` (newer refused), each project entry with a `project`
 * object and a `rows` object of arrays of objects.
 */
export function validateExport(value: unknown, currentSchemaVersion: number = SCHEMA_VERSION): ExportDocument {
  if (!isPlainObject(value)) {
    throw new BackupRefusal("unsupported_format", "Not a task-tracker export: the file is not a JSON object");
  }
  if (value.format !== FORMAT_NAME) {
    throw new BackupRefusal(
      "unsupported_format",
      value.format === undefined
        ? "Not a task-tracker export: format is missing"
        : `Not a task-tracker export: format is ${JSON.stringify(value.format)}`,
      { format: value.format },
    );
  }
  if (value.format_version !== FORMAT_VERSION) {
    throw new BackupRefusal(
      "unsupported_format",
      `Unsupported format_version ${JSON.stringify(value.format_version)} (this build reads ${FORMAT_VERSION})`,
      { format_version: value.format_version },
    );
  }
  const sv = value.schema_version;
  if (typeof sv !== "number" || !Number.isInteger(sv) || sv < 1) {
    throw new BackupRefusal(
      "unsupported_format",
      `Invalid schema_version ${JSON.stringify(sv)}: expected a positive integer`,
      { schema_version: sv },
    );
  }
  if (sv > currentSchemaVersion) {
    throw new BackupRefusal(
      "schema_mismatch",
      `The file is newer than this build: schema_version ${sv}, this build reads up to ${currentSchemaVersion}`,
      { schema_version: sv, current: currentSchemaVersion },
    );
  }
  if (!Array.isArray(value.projects)) {
    throw new BackupRefusal("unsupported_format", "Not a task-tracker export: projects is not an array");
  }
  value.projects.forEach((entry: unknown, i: number) => {
    if (!isPlainObject(entry) || !isPlainObject(entry.project) || !isPlainObject(entry.rows)) {
      throw new BackupRefusal(
        "unsupported_format",
        `projects[${i}] must be an object with a project object and a rows object`,
      );
    }
    for (const [table, rows] of Object.entries(entry.rows)) {
      if (!Array.isArray(rows) || !rows.every(isPlainObject)) {
        throw new BackupRefusal("unsupported_format", `projects[${i}].rows.${table} must be an array of objects`);
      }
    }
  });
  return value as unknown as ExportDocument;
}

/** Steps 1-2 of D7 (plus the entry shape): JSON text -> a validated document. */
export function parseExport(text: string, currentSchemaVersion: number = SCHEMA_VERSION): ExportDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new BackupRefusal("unsupported_format", `Not a task-tracker export: invalid JSON (${(err as Error).message})`);
  }
  return validateExport(value, currentSchemaVersion);
}

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

function tableColumns(db: DatabaseInstance, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Step 3 of D7, the D2 column rule. `exact` (equal schema_version): every
 * registry table present in `rows`, and each row's key set equal to the
 * target's columns. `subset` (older file): unknown tables and columns refused;
 * a missing table reads as empty; a column absent from a row must be nullable
 * or defaulted in the target. Values must be JSON scalars in both modes.
 */
export function checkColumns(db: DatabaseInstance, doc: ExportDocument, mode: "exact" | "subset"): void {
  const columns = new Map<string, ColumnInfo[]>();
  for (const { table } of BACKUP_TABLES) columns.set(table, tableColumns(db, table));

  const checkRow = (table: string, row: BackupRow): void => {
    const cols = columns.get(table) as ColumnInfo[];
    const names = new Set(cols.map((c) => c.name));
    for (const [key, value] of Object.entries(row)) {
      if (!names.has(key)) {
        throw new BackupRefusal("schema_mismatch", `Unknown column in the file: ${table}.${key}`, {
          table,
          column: key,
        });
      }
      if (!isScalar(value)) {
        throw new BackupRefusal("schema_mismatch", `Value of ${table}.${key} is not a string, number or null`, {
          table,
          column: key,
        });
      }
    }
    for (const col of cols) {
      if (Object.prototype.hasOwnProperty.call(row, col.name)) continue;
      if (mode === "exact") {
        throw new BackupRefusal("schema_mismatch", `Column missing from the file: ${table}.${col.name}`, {
          table,
          column: col.name,
        });
      }
      if (col.notnull !== 0 && col.dflt_value === null) {
        throw new BackupRefusal(
          "schema_mismatch",
          `Column ${table}.${col.name} is required by this build, absent from the file`,
          { table, column: col.name },
        );
      }
    }
  };

  for (const entry of doc.projects) {
    checkRow("projects", entry.project);
    for (const table of Object.keys(entry.rows)) {
      if (!ROW_TABLES.includes(table)) {
        throw new BackupRefusal("schema_mismatch", `Unknown table in the file: ${table}`, { table });
      }
    }
    for (const table of ROW_TABLES) {
      const rows = entry.rows[table];
      if (rows === undefined) {
        if (mode === "exact") {
          throw new BackupRefusal("schema_mismatch", `Table missing from the file: ${table}`, { table });
        }
        continue;
      }
      for (const row of rows) checkRow(table, row);
    }
  }
}

/** One `--root-path-map old=new` entry, both sides absolute without a trailing `/`. */
export interface RootPathMapEntry {
  old: string;
  new: string;
}

/** A malformed `--root-path-map` (a usage error: exit 2 in the CLI). */
export class RootPathMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootPathMapError";
  }
}

function normalizeMapSide(side: string, entry: string): string {
  if (!side || !path.isAbsolute(side)) {
    throw new RootPathMapError(`--root-path-map ${entry}: both sides must be absolute paths`);
  }
  const resolved = path.resolve(side);
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

/** Parses `old=new` entries (split on the first `=`; D8). */
export function parseRootPathMap(entries: readonly string[]): RootPathMapEntry[] {
  return entries.map((entry) => {
    const eq = entry.indexOf("=");
    if (eq < 0) throw new RootPathMapError(`--root-path-map ${entry}: expected old=new`);
    return {
      old: normalizeMapSide(entry.slice(0, eq), entry),
      new: normalizeMapSide(entry.slice(eq + 1), entry),
    };
  });
}

/** The longest entry whose `old` is a whole-segment prefix of absolute `p`. */
function matchRootPath(p: string, maps: readonly RootPathMapEntry[]): RootPathMapEntry | undefined {
  if (!path.isAbsolute(p)) return undefined;
  let best: RootPathMapEntry | undefined;
  for (const m of maps) {
    const prefix = m.old === "/" ? "/" : `${m.old}/`;
    if ((p === m.old || p.startsWith(prefix)) && (!best || m.old.length > best.old.length)) best = m;
  }
  return best;
}

/**
 * D8 match rule: only an absolute `p`; `old` matches `p === old` or a
 * whole-segment prefix (`/a/b` matches `/a/b/x`, not `/a/bc`); the longest
 * `old` wins; the rest of `p` is kept byte for byte.
 */
export function rewritePath(p: string, maps: readonly RootPathMapEntry[]): string {
  const m = matchRootPath(p, maps);
  if (!m) return p;
  // `rest` is "" or starts with "/" (the root map "/" keeps the leading slash).
  const rest = m.old === "/" ? (p === "/" ? "" : p) : p.slice(m.old.length);
  return m.new === "/" ? rest || "/" : m.new + rest;
}

export interface RootPathMapReport {
  root_path_rewrites: Record<
    "projects.root_path" | "projects.design_doc_path" | "task_files.file_path" | "task_slices.artifacts",
    number
  >;
  /** Map entries (as `old=new`) that matched no path in the file. */
  unused_root_path_maps: string[];
  /** Slice ids whose `artifacts` text did not parse to a JSON array. */
  artifacts_not_rewritten: string[];
}

/**
 * D8: rewrites `projects.root_path`, `projects.design_doc_path`,
 * `task_files.file_path` and the string elements of `task_slices.artifacts`
 * on a copy of `doc`. Nothing else (amendments, hashes, free text) changes.
 */
export function applyRootPathMap(
  doc: ExportDocument,
  maps: readonly RootPathMapEntry[],
): { doc: ExportDocument } & RootPathMapReport {
  const report: RootPathMapReport = {
    root_path_rewrites: {
      "projects.root_path": 0,
      "projects.design_doc_path": 0,
      "task_files.file_path": 0,
      "task_slices.artifacts": 0,
    },
    unused_root_path_maps: [],
    artifacts_not_rewritten: [],
  };
  if (maps.length === 0) return { doc, ...report };

  const used = new Set<RootPathMapEntry>();
  const rewrite = (p: string): string => {
    const m = matchRootPath(p, maps);
    if (m) used.add(m);
    return rewritePath(p, maps);
  };
  const rewriteColumn = (row: BackupRow, column: string, key: keyof RootPathMapReport["root_path_rewrites"]) => {
    const value = row[column];
    if (typeof value !== "string") return row;
    const next = rewrite(value);
    if (next === value) return row;
    report.root_path_rewrites[key] += 1;
    return { ...row, [column]: next };
  };

  const projects = doc.projects.map((entry) => {
    let project = rewriteColumn(entry.project, "root_path", "projects.root_path");
    project = rewriteColumn(project, "design_doc_path", "projects.design_doc_path");
    const rows = { ...entry.rows };
    if (rows.task_files) {
      rows.task_files = rows.task_files.map((r) => rewriteColumn(r, "file_path", "task_files.file_path"));
    }
    if (rows.task_slices) {
      rows.task_slices = rows.task_slices.map((slice) => {
        const text = slice.artifacts;
        if (typeof text !== "string") return slice;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        if (!Array.isArray(parsed)) {
          report.artifacts_not_rewritten.push(String(slice.id));
          return slice;
        }
        let changed = false;
        const next = parsed.map((el: unknown) => {
          if (typeof el !== "string") return el;
          const out = rewrite(el);
          if (out !== el) changed = true;
          return out;
        });
        if (!changed) return slice;
        report.root_path_rewrites["task_slices.artifacts"] += 1;
        return { ...slice, artifacts: JSON.stringify(next) };
      });
    }
    return { project, rows };
  });

  report.unused_root_path_maps = maps.filter((m) => !used.has(m)).map((m) => `${m.old}=${m.new}`);
  return { doc: { ...doc, projects }, ...report };
}

/**
 * Step 5 of D7: every file project's `id`, `name` and non-null `code_prefix`
 * against the target `projects` table and against the other file projects.
 * Returns one message per clash (empty when none).
 */
export function findClashes(db: DatabaseInstance, doc: ExportDocument): string[] {
  const clashes: string[] = [];
  const keys = ["id", "name", "code_prefix"] as const;
  const stmts = Object.fromEntries(
    keys.map((k) => [k, db.prepare(`SELECT 1 FROM projects WHERE ${k} = ? LIMIT 1`)]),
  ) as Record<(typeof keys)[number], ReturnType<DatabaseInstance["prepare"]>>;
  const seen = Object.fromEntries(keys.map((k) => [k, new Set<unknown>()])) as Record<
    (typeof keys)[number],
    Set<unknown>
  >;
  for (const { project } of doc.projects) {
    for (const key of keys) {
      const value = project[key];
      if (value === null || value === undefined) continue;
      if (stmts[key].get(value)) clashes.push(`project ${key} already exists: ${String(value)}`);
      if (seen[key].has(value)) clashes.push(`project ${key} appears twice in the file: ${String(value)}`);
      seen[key].add(value);
    }
  }
  return clashes;
}

export interface SkippedDependency {
  task_id: string;
  depends_on_task_id: string;
}

/**
 * Step 6 of D7 and D9. Every foreign-key value in the file (read from the
 * target's PRAGMA foreign_key_list) must resolve to a row in the file; the one
 * exception is `task_dependencies.depends_on_task_id`, which may point at a
 * task already in the target. An edge whose target is in neither is returned
 * as skipped; any other dangling value refuses (`dangling_reference`).
 */
export function checkReferences(db: DatabaseInstance, doc: ExportDocument): SkippedDependency[] {
  const rowsOf = (table: string): BackupRow[] =>
    table === "projects" ? doc.projects.map((e) => e.project) : doc.projects.flatMap((e) => e.rows[table] ?? []);
  const keyCache = new Map<string, Set<unknown>>();
  const keysOf = (table: string, column: string): Set<unknown> => {
    const k = `${table}.${column}`;
    let set = keyCache.get(k);
    if (!set) {
      set = new Set(rowsOf(table).map((r) => r[column]));
      keyCache.set(k, set);
    }
    return set;
  };
  const taskInTarget = db.prepare(`SELECT 1 FROM tasks WHERE id = ?`);
  const skipped: SkippedDependency[] = [];

  for (const { table } of BACKUP_TABLES) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      from: string;
      to: string | null;
    }>;
    for (const row of rowsOf(table)) {
      for (const fk of fks) {
        const value = row[fk.from];
        if (value === null || value === undefined) continue;
        if (keysOf(fk.table, fk.to ?? "id").has(value)) continue;
        if (table === "task_dependencies" && fk.from === "depends_on_task_id") {
          if (!taskInTarget.get(value)) {
            skipped.push({ task_id: String(row.task_id), depends_on_task_id: String(value) });
          }
          continue;
        }
        throw new BackupRefusal(
          "dangling_reference",
          `${table}.${fk.from} = ${String(value)} refers to a ${fk.table} row that is not in the file`,
          { table, column: fk.from, value },
        );
      }
    }
  }
  return skipped;
}

/**
 * Insert order within a table. Domain queries order by a timestamp alone
 * (`ORDER BY created_at`, `revised_at, rowid`), so rows sharing a timestamp
 * come back in rowid order, i.e. the order they were inserted on the source.
 * Rowid is not exported; inserting by the timestamp, then the table's own
 * counter, then file order rebuilds that order for rows created together
 * (e.g. a `create_tasks` batch shares one `created_at` and numbers its tasks
 * in creation order). Tables not listed keep file order.
 */
const INSERT_ORDER: Readonly<Record<string, readonly string[]>> = {
  projects: ["created_at"],
  epics: ["created_at"],
  releases: ["created_at", "sequence"],
  tasks: ["created_at", "task_number"],
  release_plans: ["created_at"],
  handoff_notes: ["created_at"],
  task_amendments: ["amended_at"],
  task_slices: ["created_at", "label_number"],
  task_slice_revisions: ["revised_at"],
};

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function inCreationOrder(table: string, rows: BackupRow[]): BackupRow[] {
  const keys = INSERT_ORDER[table];
  if (!keys) return rows;
  // Array.prototype.sort is stable: rows equal on every key keep file order.
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const c = compareValues(a[k], b[k]);
      if (c !== 0) return c;
    }
    return 0;
  });
}

export interface ImportOptions {
  /** Parsed `--root-path-map` entries (see parseRootPathMap). */
  rootPathMap?: readonly RootPathMapEntry[];
  /** The schema version this build writes; a test passes 2 to import a v1 file as older. */
  currentSchemaVersion?: number;
}

export interface ImportResult extends RootPathMapReport {
  projects: Array<{ id: string; name: string; code_prefix: string | null }>;
  /** Rows inserted per BACKUP_TABLES table. */
  counts: Record<string, number>;
  /** Cross-project edges whose depends_on task is in neither the file nor the target (D9). */
  skipped_dependencies: SkippedDependency[];
}

/**
 * D7: validates (steps 1-3), applies the root-path map in memory (step 4),
 * then inside one IMMEDIATE transaction checks clashes (5) and references (6)
 * and inserts table by table in registry order (7). Each insert names only the
 * row's own columns. Any refusal or SQLite error leaves the target unchanged.
 */
export function importProjects(
  db: DatabaseInstance,
  input: ExportDocument,
  { rootPathMap = [], currentSchemaVersion = SCHEMA_VERSION }: ImportOptions = {},
): ImportResult {
  const validated = validateExport(input, currentSchemaVersion);
  checkColumns(db, validated, validated.schema_version === currentSchemaVersion ? "exact" : "subset");
  const { doc, ...report } = applyRootPathMap(validated, rootPathMap);

  const counts: Record<string, number> = {};
  for (const { table } of BACKUP_TABLES) counts[table] = 0;
  const statements = new Map<string, ReturnType<DatabaseInstance["prepare"]>>();
  const insert = (table: string, row: BackupRow): void => {
    const cols = Object.keys(row).sort();
    const key = `${table}(${cols.join(",")})`;
    let stmt = statements.get(key);
    if (!stmt) {
      stmt = db.prepare(
        `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      );
      statements.set(key, stmt);
    }
    stmt.run(cols.map((c) => row[c]));
    counts[table] += 1;
  };

  const write = db.transaction((): SkippedDependency[] => {
    const clashes = findClashes(db, doc);
    if (clashes.length > 0) {
      throw new BackupRefusal("clash", `Import refused, nothing written: ${clashes.join("; ")}`, { clashes });
    }
    const skipped = checkReferences(db, doc);
    const skip = new Set(skipped.map((s) => `${s.task_id}\u0000${s.depends_on_task_id}`));
    for (const { table } of BACKUP_TABLES) {
      const rows =
        table === "projects" ? doc.projects.map((e) => e.project) : doc.projects.flatMap((e) => e.rows[table] ?? []);
      for (const row of inCreationOrder(table, rows)) {
        if (table === "task_dependencies" && skip.has(`${String(row.task_id)}\u0000${String(row.depends_on_task_id)}`)) {
          continue;
        }
        insert(table, row);
      }
    }
    return skipped;
  });
  const skipped_dependencies = write.immediate();

  return {
    projects: doc.projects.map((e) => ({
      id: e.project.id as string,
      name: e.project.name as string,
      code_prefix: (e.project.code_prefix as string | null | undefined) ?? null,
    })),
    counts,
    skipped_dependencies,
    ...report,
  };
}

export interface ImportFileOptions {
  /** Raw `old=new` entries; a malformed one throws RootPathMapError before the file is read. */
  rootPathMap?: readonly string[];
  currentSchemaVersion?: number;
}

/** The one import entry point for the CLI and the MCP tool. */
export function importFromFile(
  db: DatabaseInstance,
  filePath: string,
  { rootPathMap = [], currentSchemaVersion = SCHEMA_VERSION }: ImportFileOptions = {},
): ImportResult & { path: string } {
  const maps = parseRootPathMap(rootPathMap);
  const target = path.resolve(filePath);
  const doc = parseExport(fs.readFileSync(target, "utf8"), currentSchemaVersion);
  return { path: target, ...importProjects(db, doc, { rootPathMap: maps, currentSchemaVersion }) };
}
