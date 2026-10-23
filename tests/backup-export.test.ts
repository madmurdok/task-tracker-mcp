import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import {
  BACKUP_TABLES,
  BackupRefusal,
  EXCLUDED_TABLES,
  FORMAT_VERSION,
  assertOutPathAllowed,
  exportProjects,
  exportToFile,
  resolveSelection,
  serializeExport,
  writeExportFile,
  type ExportDocument,
} from "../src/domain/backup.js";
import { writeLegacyV1Db } from "./fixtures/legacyV1Db.js";

/**
 * TTM-106 export side of docs/design/backup-restore.md (D1-D6, D9, D10,
 * "Behaviours to pin / TTM-106"). Expectations are written from the design:
 * the ownership predicates and row orders below are copied from the D4 table,
 * not read from BACKUP_TABLES, so a wrong registry entry fails here.
 */

const ALL_TABLES = [
  "projects",
  "epics",
  "releases",
  "tasks",
  "release_plans",
  "release_plan_items",
  "task_dependencies",
  "task_files",
  "handoff_notes",
  "task_amendments",
  "task_slices",
  "task_slice_revisions",
];
const CHILD_TABLES = ALL_TABLES.filter((t) => t !== "projects");

const TASKS_OF = `(SELECT id FROM tasks WHERE project_id = :pid)`;
/** D4 owner predicates for one project id (`:pid`), and D5 row orders. */
const SPEC: Record<string, { owner: string; orderBy: string }> = {
  projects: { owner: `id = :pid`, orderBy: "created_at, id" },
  epics: { owner: `project_id = :pid`, orderBy: "id" },
  releases: { owner: `project_id = :pid`, orderBy: "id" },
  tasks: { owner: `project_id = :pid`, orderBy: "id" },
  release_plans: { owner: `release_id IN (SELECT id FROM releases WHERE project_id = :pid)`, orderBy: "id" },
  release_plan_items: {
    owner: `plan_id IN (SELECT rp.id FROM release_plans rp JOIN releases r ON r.id = rp.release_id WHERE r.project_id = :pid)`,
    orderBy: "plan_id, task_id",
  },
  task_dependencies: { owner: `task_id IN ${TASKS_OF}`, orderBy: "task_id, depends_on_task_id" },
  task_files: { owner: `task_id IN ${TASKS_OF}`, orderBy: "task_id, file_path" },
  handoff_notes: { owner: `task_id IN ${TASKS_OF}`, orderBy: "id" },
  task_amendments: { owner: `task_id IN ${TASKS_OF}`, orderBy: "id" },
  task_slices: { owner: `task_id IN ${TASKS_OF}`, orderBy: "id" },
  task_slice_revisions: { owner: `task_id IN ${TASKS_OF}`, orderBy: "id" },
};

const FIXED = () => new Date("2026-10-23T12:00:00.000Z");

function insert(db: DatabaseInstance, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
}

function insertProject(db: DatabaseInstance, id: string, name: string, createdAt: string): void {
  insert(db, "projects", {
    id,
    name,
    root_path: `/repo/${id}`,
    code_prefix: id.toUpperCase(),
    design_doc_path: null,
    design_doc_hash: null,
    created_at: createdAt,
  });
}

/**
 * Rows in every child table for project `pid` whose tasks `${pid}-t1` and
 * `${pid}-t2` already exist. Rows are inserted out of their D5 order so the
 * export's ORDER BY is what puts them in place.
 */
function seedChildren(db: DatabaseInstance, pid: string): void {
  const t1 = `${pid}-t1`;
  const t2 = `${pid}-t2`;
  const ts = "2026-02-01T00:00:00.000Z";
  insert(db, "epics", { id: `${pid}-e2`, project_id: pid, name: "Second", description: "", created_at: ts });
  insert(db, "epics", { id: `${pid}-e1`, project_id: pid, name: "First", description: "d", created_at: ts });
  insert(db, "releases", { id: `${pid}-r1`, project_id: pid, version: "1.0.0", sequence: 1, created_at: ts });
  db.prepare(`UPDATE tasks SET epic_id = ?, release_id = ? WHERE id = ?`).run(`${pid}-e1`, `${pid}-r1`, t1);
  insert(db, "release_plans", {
    id: `${pid}-rp1`,
    release_id: `${pid}-r1`,
    status: "approved",
    approved_by: "owner",
    approval_note: "ok",
    approved_at: ts,
    created_at: ts,
    updated_at: ts,
  });
  insert(db, "release_plan_items", { plan_id: `${pid}-rp1`, task_id: t2, step: 2, position: 0, added_at: ts });
  insert(db, "release_plan_items", { plan_id: `${pid}-rp1`, task_id: t1, step: 1, position: 0, added_at: ts });
  insert(db, "task_dependencies", { task_id: t2, depends_on_task_id: t1 });
  insert(db, "task_files", { task_id: t2, file_path: "src/z.ts" });
  insert(db, "task_files", { task_id: t1, file_path: "src/b.ts" });
  insert(db, "task_files", { task_id: t1, file_path: "src/a.ts" });
  insert(db, "handoff_notes", { id: `${pid}-h2`, task_id: t2, session_id: "s", decisions: "x", created_at: ts });
  insert(db, "handoff_notes", { id: `${pid}-h1`, task_id: t1, session_id: "s", created_at: ts });
  insert(db, "task_amendments", {
    id: `${pid}-a1`,
    task_id: t1,
    field: "file_paths",
    previous_value: '["src/old.ts"]',
    reason: "renamed",
    amended_at: ts,
  });
  insert(db, "task_slices", {
    id: `${pid}-s1`,
    task_id: t1,
    phase: "implement",
    step: 1,
    position: 0,
    title: "Code",
    status: "done",
    model: null,
    artifacts: '["src/a.ts"]',
    metrics: '{"tool_uses":3}',
    label_number: 1,
    created_at: ts,
    updated_at: ts,
  });
  insert(db, "task_slice_revisions", {
    id: `${pid}-v1`,
    task_id: t1,
    reason: "re-cut",
    replaced_slices: '[{"label":"S2"}]',
    revised_at: ts,
  });
}

/** A project with rows in all twelve tables. */
function seedFullProject(db: DatabaseInstance, pid: string, name: string, createdAt: string): void {
  insertProject(db, pid, name, createdAt);
  for (const [n, t] of [
    [2, `${pid}-t2`],
    [1, `${pid}-t1`],
  ] as const) {
    insert(db, "tasks", {
      id: t,
      project_id: pid,
      title: `Task ${n}`,
      task_number: n,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }
  seedChildren(db, pid);
}

function rowsOf(db: DatabaseInstance, table: string, pid: string): Record<string, unknown>[] {
  const { owner, orderBy } = SPEC[table];
  return db.prepare(`SELECT * FROM ${table} WHERE ${owner} ORDER BY ${orderBy}`).all({ pid }) as Record<
    string,
    unknown
  >[];
}

function countAll(db: DatabaseInstance, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Every key path whose object keys are not in sorted order; empty when canonical. */
function unsortedKeyPaths(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => unsortedKeyPaths(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    const sorted = [...keys].sort();
    const here = keys.join() === sorted.join() ? [] : [at];
    return [...here, ...keys.flatMap((k) => unsortedKeyPaths((value as Record<string, unknown>)[k], `${at}.${k}`))];
  }
  return [];
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "ttmcp-export-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("export content (D1, D4)", () => {
  let db: DatabaseInstance;
  beforeEach(() => {
    db = openDatabase(":memory:");
    // Created later but with the smaller id, so (created_at, id) order is visible.
    seedFullProject(db, "pb", "Beta", "2026-01-01T00:00:00.000Z");
    seedFullProject(db, "pa", "Alpha", "2026-03-01T00:00:00.000Z");
    // Cross-project edge: pb's task depends on pa's task (D9).
    insert(db, "task_dependencies", { task_id: "pb-t1", depends_on_task_id: "pa-t1" });
  });
  afterEach(() => db.close());

  it("single-project export holds exactly the rows of the D4 predicate, in D5 order, for every table", () => {
    for (const pid of ["pa", "pb"]) {
      const doc = exportProjects(db, pid, { now: FIXED });
      expect(doc.projects).toHaveLength(1);
      const [entry] = doc.projects;
      expect(entry.project).toEqual(rowsOf(db, "projects", pid)[0]);
      expect(Object.keys(entry.rows).sort()).toEqual([...CHILD_TABLES].sort());
      for (const table of CHILD_TABLES) {
        const expected = rowsOf(db, table, pid);
        expect(expected.length, `${pid}.${table} seeded`).toBeGreaterThan(0);
        expect(entry.rows[table], `${pid}.${table}`).toEqual(expected);
      }
    }
  });

  it("per-table counts equal SELECT COUNT(*) under the D4 predicate (single) and unfiltered (--all)", () => {
    for (const pid of ["pa", "pb"]) {
      const result = exportToFile(db, pid, path.join(dir, `${pid}.json`), { now: FIXED });
      for (const table of ALL_TABLES) {
        expect(result.counts[table], `${pid}.${table}`).toBe(rowsOf(db, table, pid).length);
      }
    }
    const all = exportToFile(db, { all: true }, path.join(dir, "all.json"), { now: FIXED });
    for (const table of ALL_TABLES) {
      expect(all.counts[table], table).toBe(countAll(db, table));
    }
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "all.json"), "utf8")) as ExportDocument;
    expect(doc.projects).toHaveLength(countAll(db, "projects"));
    for (const table of CHILD_TABLES) {
      const inFile = doc.projects.reduce((n, e) => n + e.rows[table].length, 0);
      expect(inFile, table).toBe(countAll(db, table));
    }
  });

  it("--all orders projects by (created_at, id)", () => {
    const doc = exportProjects(db, { all: true }, { now: FIXED });
    expect(doc.projects.map((e) => e.project.id)).toEqual(["pb", "pa"]);
  });

  it("resolves a project by name as well as id", () => {
    expect(exportProjects(db, "Alpha", { now: FIXED })).toEqual(exportProjects(db, "pa", { now: FIXED }));
  });

  it("writes every column of every row (NULL as null), keys sorted at every level, JSON-in-TEXT kept as strings", () => {
    const out = path.join(dir, "out.json");
    exportToFile(db, { all: true }, out, { now: FIXED });
    const parsed = JSON.parse(fs.readFileSync(out, "utf8")) as ExportDocument;
    expect(unsortedKeyPaths(parsed)).toEqual([]);
    for (const entry of parsed.projects) {
      const pid = entry.project.id as string;
      const cols = (table: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
      expect(Object.keys(entry.project)).toEqual(cols("projects"));
      for (const table of CHILD_TABLES) {
        for (const row of entry.rows[table]) expect(Object.keys(row), `${pid}.${table}`).toEqual(cols(table));
      }
      expect(entry.project.design_doc_hash).toBeNull();
      const [slice] = entry.rows.task_slices;
      expect(slice.model).toBeNull();
      expect(slice.metrics).toBe('{"tool_uses":3}');
      expect(slice.artifacts).toBe('["src/a.ts"]');
      expect(entry.rows.task_amendments[0].previous_value).toBe('["src/old.ts"]');
      expect(entry.rows.task_slice_revisions[0].replaced_slices).toBe('[{"label":"S2"}]');
    }
  });

  it("task_files rows carry no rowid and come in (task_id, file_path) order", () => {
    const doc = exportProjects(db, "pa", { now: FIXED });
    expect(doc.projects[0].rows.task_files).toEqual([
      { file_path: "src/a.ts", task_id: "pa-t1" },
      { file_path: "src/b.ts", task_id: "pa-t1" },
      { file_path: "src/z.ts", task_id: "pa-t2" },
    ]);
  });

  it("a cross-project edge goes with its dependent task and is counted in external_dependencies (D9)", () => {
    const pb = exportToFile(db, "pb", path.join(dir, "pb.json"), { now: FIXED });
    const pbDoc = JSON.parse(fs.readFileSync(pb.path, "utf8")) as ExportDocument;
    expect(pbDoc.projects[0].rows.task_dependencies).toContainEqual({ depends_on_task_id: "pa-t1", task_id: "pb-t1" });
    expect(pb.external_dependencies).toBe(1);

    const pa = exportToFile(db, "pa", path.join(dir, "pa.json"), { now: FIXED });
    const paDoc = JSON.parse(fs.readFileSync(pa.path, "utf8")) as ExportDocument;
    expect(paDoc.projects[0].rows.task_dependencies).not.toContainEqual(
      expect.objectContaining({ task_id: "pb-t1" }),
    );
    expect(pa.external_dependencies).toBe(0);

    const all = exportToFile(db, { all: true }, path.join(dir, "all.json"), { now: FIXED });
    expect(all.external_dependencies).toBe(0);
  });

  it("returns { path (absolute), projects: [{id, name}], counts for all twelve tables, external_dependencies }", () => {
    fs.mkdirSync(path.join(dir, "sub"));
    const out = path.join(dir, "sub", "..", "result.json");
    const result = exportToFile(db, { all: true }, out, { now: FIXED });
    expect(result.path).toBe(path.resolve(out));
    expect(path.isAbsolute(result.path)).toBe(true);
    expect(result.projects).toEqual([
      { id: "pb", name: "Beta" },
      { id: "pa", name: "Alpha" },
    ]);
    expect(Object.keys(result.counts).sort()).toEqual([...ALL_TABLES].sort());
    expect(Object.keys(result).sort()).toEqual(["counts", "external_dependencies", "path", "projects"]);
  });
});

describe("envelope (D1)", () => {
  it("has format, format_version, schema_version, exported_at and all eleven row tables even when empty", () => {
    const db = openDatabase(":memory:");
    try {
      insertProject(db, "p1", "Empty", "2026-01-01T00:00:00.000Z");
      const doc = exportProjects(db, "p1", { now: FIXED });
      expect(doc.format).toBe("task-tracker-export");
      expect(doc.format_version).toBe(1);
      expect(FORMAT_VERSION).toBe(1);
      expect(doc.schema_version).toBe(SCHEMA_VERSION);
      expect(doc.exported_at).toBe("2026-10-23T12:00:00.000Z");
      expect(Object.keys(doc).sort()).toEqual(["exported_at", "format", "format_version", "projects", "schema_version"]);
      expect(doc.projects).toHaveLength(1);
      expect(Object.keys(doc.projects[0]).sort()).toEqual(["project", "rows"]);
      expect(doc.projects[0].rows).toEqual(Object.fromEntries(CHILD_TABLES.map((t) => [t, []])));
    } finally {
      db.close();
    }
  });
});

describe("determinism (D5)", () => {
  let db: DatabaseInstance;
  beforeEach(() => {
    db = openDatabase(path.join(dir, "tracker.db"));
    seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
  });
  afterEach(() => db.close());

  it("fixed clock: two exports of an unchanged DB are byte-identical and end with a newline", () => {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    exportToFile(db, "p1", a, { now: FIXED });
    exportToFile(db, "p1", b, { now: FIXED });
    const bytesA = fs.readFileSync(a);
    expect(bytesA.equals(fs.readFileSync(b))).toBe(true);
    expect(bytesA.toString("utf8").endsWith("}\n")).toBe(true);
  });

  it("real clock: two exports differ only on the exported_at line", () => {
    const a = serializeExport(exportProjects(db, "p1")).split("\n");
    const b = serializeExport(
      exportProjects(db, "p1", { now: () => new Date(Date.now() + 86_400_000) }),
    ).split("\n");
    expect(a).toHaveLength(b.length);
    const differing = a.flatMap((line, i) => (line === b[i] ? [] : [i]));
    expect(differing).toEqual([1]);
    expect(a[1]).toMatch(/^ {2}"exported_at": "/);
    // And with no injected clock at all, any difference is still confined to that line.
    const c = serializeExport(exportProjects(db, "p1")).split("\n");
    expect(a.flatMap((line, i) => (line === c[i] ? [] : [i])).filter((i) => i !== 1)).toEqual([]);
  });

  it("--all of a one-project DB equals that project's single export", () => {
    expect(serializeExport(exportProjects(db, { all: true }, { now: FIXED }))).toBe(
      serializeExport(exportProjects(db, "p1", { now: FIXED })),
    );
  });

  it("a migrated legacy DB and a fresh DB with the same rows export byte-identically", () => {
    const legacyPath = path.join(dir, "legacy.db");
    writeLegacyV1Db(legacyPath, "lp");
    const migrated = openDatabase(legacyPath);
    const fresh = openDatabase(":memory:");
    try {
      seedChildren(migrated, "lp");
      // Copy every row by column name into a fresh DB, parent tables first.
      for (const table of ALL_TABLES) {
        for (const row of migrated.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
          insert(fresh, table, row);
        }
      }
      const order = (d: DatabaseInstance, t: string) =>
        (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name).join();
      // The fixture only proves something if the physical column order differs.
      expect(order(migrated, "projects")).not.toBe(order(fresh, "projects"));
      const a = serializeExport(exportProjects(migrated, "lp", { now: FIXED }));
      const b = serializeExport(exportProjects(fresh, "lp", { now: FIXED }));
      expect(a).toBe(b);
    } finally {
      migrated.close();
      fresh.close();
    }
  });
});

describe("table guard (D3)", () => {
  function unregisteredTables(db: DatabaseInstance | Database.Database): string[] {
    const registered = new Set([...BACKUP_TABLES.map((t) => t.table), ...EXCLUDED_TABLES]);
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    return names.map((r) => r.name).filter((n) => !registered.has(n));
  }

  it("a fresh DB's tables equal BACKUP_TABLES ∪ EXCLUDED_TABLES exactly", () => {
    const db = openDatabase(":memory:");
    try {
      const names = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{
          name: string;
        }>
      )
        .map((r) => r.name)
        .sort();
      expect([...BACKUP_TABLES.map((t) => t.table), ...EXCLUDED_TABLES].sort()).toEqual(names);
      expect(unregisteredTables(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("the guard catches a table that is in neither registry", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`CREATE TABLE extra (id TEXT PRIMARY KEY)`);
      expect(unregisteredTables(db)).toEqual(["extra"]);
    } finally {
      db.close();
    }
  });

  it("BACKUP_TABLES is the twelve tables of D4, parent-first, projects at the head", () => {
    expect(BACKUP_TABLES.map((t) => t.table)).toEqual(ALL_TABLES);
  });
});

describe("selection (D6, review F2)", () => {
  it("an unknown project is a BackupRefusal unknown_project naming the ref", () => {
    const db = openDatabase(":memory:");
    try {
      let caught: unknown;
      try {
        exportProjects(db, "nope", { now: FIXED });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BackupRefusal);
      expect((caught as BackupRefusal).code).toBe("unknown_project");
      expect((caught as BackupRefusal).message).toBe("Unknown project: nope");
    } finally {
      db.close();
    }
  });

  it("a DB error while resolving propagates as itself, not as unknown_project", () => {
    // A connection without the tracker schema: the projects lookup fails with
    // an SQLite error, which must not be reported as a missing project.
    const raw = new Database(":memory:");
    try {
      let caught: unknown;
      try {
        resolveSelection(raw, "anything");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(BackupRefusal);
      expect((caught as Error).message).toMatch(/no such table: projects/);
    } finally {
      raw.close();
    }
  });

  it("unknown project via exportToFile: no file written, an existing --out unchanged, no temp left", () => {
    const db = openDatabase(path.join(dir, "tracker.db"));
    try {
      const missing = path.join(dir, "missing.json");
      expect(() => exportToFile(db, "nope", missing)).toThrow(BackupRefusal);
      expect(fs.existsSync(missing)).toBe(false);
      const existing = path.join(dir, "existing.json");
      fs.writeFileSync(existing, "keep me");
      expect(() => exportToFile(db, "nope", existing)).toThrow(BackupRefusal);
      expect(fs.readFileSync(existing, "utf8")).toBe("keep me");
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("one snapshot under a concurrent writer (D5)", () => {
  it("rows committed by another connection after the export's first read are absent", () => {
    const dbPath = path.join(dir, "tracker.db");
    const db = openDatabase(dbPath);
    const writer = openDatabase(dbPath);
    try {
      seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
      const before = exportProjects(db, "p1", { now: FIXED });

      // Interpose on the statements exportProjects prepares: right after the
      // first export SELECT (projects) returns, a second connection commits a
      // new task and a note on it. Every later SELECT must not see them.
      const realPrepare = db.prepare.bind(db);
      let wrote = false;
      (db as { prepare: unknown }).prepare = (sql: string) => {
        const stmt = realPrepare(sql);
        if (!/^SELECT \* FROM projects /.test(sql)) return stmt;
        const realAll = stmt.all.bind(stmt);
        (stmt as { all: unknown }).all = (...args: unknown[]) => {
          const result = realAll(...(args as []));
          if (!wrote) {
            wrote = true;
            insert(writer, "tasks", {
              id: "p1-late",
              project_id: "p1",
              title: "Late",
              task_number: 9,
              created_at: "2026-05-01T00:00:00.000Z",
              updated_at: "2026-05-01T00:00:00.000Z",
            });
            insert(writer, "handoff_notes", {
              id: "p1-late-note",
              task_id: "p1-late",
              session_id: "w",
              created_at: "2026-05-01T00:00:00.000Z",
            });
          }
          return result;
        };
        return stmt;
      };

      const during = exportProjects(db, "p1", { now: FIXED });
      (db as { prepare: unknown }).prepare = realPrepare;
      expect(wrote).toBe(true);
      expect(serializeExport(during)).toBe(serializeExport(before));
      // The rows are really there once the export is over.
      const after = exportProjects(db, "p1", { now: FIXED });
      expect(after.projects[0].rows.tasks.map((t) => t.id)).toContain("p1-late");
      expect(after.projects[0].rows.handoff_notes.map((h) => h.id)).toContain("p1-late-note");
    } finally {
      writer.close();
      db.close();
    }
  });
});

describe("writing the file (D6)", () => {
  let db: DatabaseInstance;
  let dbPath: string;
  beforeEach(() => {
    dbPath = path.join(dir, "tracker.db");
    db = openDatabase(dbPath);
    seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
  });
  afterEach(() => db.close());

  const tmpFiles = (d: string) => fs.readdirSync(d).filter((f) => f.includes(".tmp-"));

  it("replaces an existing --out with the export and leaves no temp file", () => {
    const out = path.join(dir, "out.json");
    fs.writeFileSync(out, "old backup");
    exportToFile(db, "p1", out, { now: FIXED });
    expect(fs.readFileSync(out, "utf8")).toBe(serializeExport(exportProjects(db, "p1", { now: FIXED })));
    expect(tmpFiles(dir)).toEqual([]);
  });

  it("a failed rename removes the temp file and leaves the target untouched", () => {
    // The target is a non-empty directory: writing the temp file succeeds,
    // renaming it over the directory fails.
    const target = path.join(dir, "taken");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "inside"), "x");
    expect(() => writeExportFile(target, "{}\n")).toThrow();
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readdirSync(target)).toEqual(["inside"]);
    expect(tmpFiles(dir)).toEqual([]);
  });

  it("a missing parent directory fails the write and creates nothing", () => {
    const out = path.join(dir, "no-such-dir", "out.json");
    expect(() => exportToFile(db, "p1", out, { now: FIXED })).toThrow();
    expect(fs.existsSync(path.dirname(out))).toBe(false);
  });
});

describe("forbidden --out targets (D6, Resolved 5, review F1)", () => {
  let db: DatabaseInstance;
  let dbPath: string;
  beforeEach(() => {
    dbPath = path.join(dir, "tracker.db");
    db = openDatabase(dbPath);
    seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
  });
  afterEach(() => db.close());

  function snapshot(files: string[]): Record<string, string | null> {
    return Object.fromEntries(
      files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f).toString("base64") : null]),
    );
  }

  function expectForbidden(d: DatabaseInstance, out: string, protectedFiles: string[]): void {
    const before = snapshot(protectedFiles);
    let caught: unknown;
    try {
      exportToFile(d, "p1", out, { now: FIXED });
    } catch (err) {
      caught = err;
    }
    expect(caught, out).toBeInstanceOf(BackupRefusal);
    expect((caught as BackupRefusal).code).toBe("forbidden_out_path");
    expect(snapshot(protectedFiles)).toEqual(before);
  }

  it("refuses the DB file, its -wal and its -shm, leaving them unchanged", () => {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    for (const out of files) expectForbidden(db, out, files);
  });

  it("refuses them through a symlinked directory and through a relative path", () => {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const linkDir = path.join(fs.mkdtempSync(path.join(tmpdir(), "ttmcp-export-link-")), "via");
    try {
      fs.symlinkSync(dir, linkDir);
      for (const suffix of ["", "-wal", "-shm"]) {
        expectForbidden(db, path.join(linkDir, `tracker.db${suffix}`), files);
        expectForbidden(db, path.relative(process.cwd(), `${dbPath}${suffix}`), files);
      }
    } finally {
      fs.rmSync(path.dirname(linkDir), { recursive: true, force: true });
    }
  });

  it("refuses a hard link to the DB file (same inode)", () => {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const alias = path.join(dir, "alias.db");
    fs.linkSync(dbPath, alias);
    expectForbidden(db, alias, files);
  });

  it("allows an unrelated file in the same directory", () => {
    const out = path.join(dir, "tracker.db.json");
    expect(() => exportToFile(db, "p1", out, { now: FIXED })).not.toThrow();
    expect(fs.existsSync(out)).toBe(true);
  });

  it("DB opened through a symlink to the file: the real file's -wal and -shm are refused too", () => {
    const realDir = path.join(dir, "real");
    const linkDir = path.join(dir, "links");
    fs.mkdirSync(realDir);
    fs.mkdirSync(linkDir);
    const realDb = path.join(realDir, "tracker.db");
    const linkDb = path.join(linkDir, "tracker-link.db");
    openDatabase(realDb).close();
    fs.symlinkSync(realDb, linkDb);
    const viaLink = openDatabase(linkDb);
    try {
      insertProject(viaLink, "p1", "One", "2026-01-01T00:00:00.000Z");
      // SQLite keeps the WAL beside the real file, not beside the symlink.
      expect(fs.existsSync(`${realDb}-wal`)).toBe(true);
      const files = [realDb, `${realDb}-wal`, `${realDb}-shm`];
      for (const out of [realDb, `${realDb}-wal`, `${realDb}-shm`, linkDb, `${linkDb}-wal`, `${linkDb}-shm`]) {
        expectForbidden(viaLink, out, files);
      }
      const sibling = path.join(realDir, "backup.json");
      expect(() => exportToFile(viaLink, "p1", sibling, { now: FIXED })).not.toThrow();
      expect(fs.existsSync(sibling)).toBe(true);
    } finally {
      viaLink.close();
    }
  });

  it("is skipped for an in-memory DB", () => {
    const mem = openDatabase(":memory:");
    try {
      expect(() => assertOutPathAllowed(mem, path.join(dir, ":memory:"))).not.toThrow();
      expect(() => assertOutPathAllowed(mem, dbPath)).not.toThrow();
    } finally {
      mem.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI (D10), spawned the way tests/cli.test.ts spawns the status bin.

function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("tsx/package.json");
  const bin = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { bin: string }).bin;
  return path.resolve(path.dirname(manifestPath), bin);
}

const tsxCli = resolveTsxCli();
const exportCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "export.ts");

function runExport(dbPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [tsxCli, exportCli, ...args], {
    env: { ...process.env, TASK_TRACKER_DB_PATH: dbPath },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("task-tracker-export CLI (D10)", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = path.join(dir, "tracker.db");
    const db = openDatabase(dbPath);
    seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
    seedFullProject(db, "p2", "Two", "2026-01-02T00:00:00.000Z");
    insert(db, "task_dependencies", { task_id: "p1-t1", depends_on_task_id: "p2-t1" });
    db.close();
  });

  it("exports a project from TASK_TRACKER_DB_PATH: exit 0, path then per-table counts then external_dependencies", () => {
    const out = path.join(dir, "p1.json");
    const r = runExport(dbPath, ["One", "--out", out]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const db = openDatabase(dbPath);
    let expected: string[];
    try {
      expected = [
        out,
        ...ALL_TABLES.map((t) => `  ${t}: ${rowsOf(db, t, "p1").length}`),
        "  external_dependencies: 1",
        "",
      ];
    } finally {
      db.close();
    }
    expect(r.stdout.split("\n")).toEqual(expected);
    const doc = JSON.parse(fs.readFileSync(out, "utf8")) as ExportDocument;
    expect(doc.projects.map((e) => e.project.id)).toEqual(["p1"]);
  });

  it("--all exports every project with exit 0", () => {
    const out = path.join(dir, "all.json");
    const r = runExport(dbPath, ["--all", "--out", out]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(fs.readFileSync(out, "utf8")) as ExportDocument;
    expect(doc.projects.map((e) => e.project.id)).toEqual(["p1", "p2"]);
    expect(r.stdout).toContain("  external_dependencies: 0\n");
  });

  it("unknown project: exit 1, stderr names it, a missing --out stays missing, an existing one is unchanged", () => {
    const missing = path.join(dir, "missing.json");
    const r1 = runExport(dbPath, ["Nope", "--out", missing]);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("Unknown project: Nope");
    expect(fs.existsSync(missing)).toBe(false);

    const existing = path.join(dir, "existing.json");
    fs.writeFileSync(existing, "previous backup");
    const r2 = runExport(dbPath, ["Nope", "--out", existing]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("Unknown project: Nope");
    expect(fs.readFileSync(existing, "utf8")).toBe("previous backup");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it.each([["-wal"], [""]])("--out at the DB file%s: exit 1, refusal on stderr, DB intact", (suffix) => {
    const r = runExport(dbPath, ["One", "--out", `${dbPath}${suffix}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/database file/);
    // The bin's own connection may checkpoint the WAL on close, so the bytes
    // can legitimately change; what must hold is that the DB still opens with
    // its rows and the export did not land on it.
    expect(fs.readFileSync(dbPath).subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    const db = openDatabase(dbPath);
    try {
      expect(countAll(db, "tasks")).toBe(4);
    } finally {
      db.close();
    }
  });

  it.each([
    ["neither a project nor --all", ["--out", "x.json"]],
    ["both a project and --all", ["One", "--all", "--out", "x.json"]],
    ["more than one project", ["One", "Two", "--out", "x.json"]],
    ["no --out", ["One"]],
    ["an unknown option", ["One", "--out", "x.json", "--bogus"]],
  ])("usage error (%s): exit 2, usage on stderr, nothing written", (_name, args) => {
    const r = runExport(dbPath, args.map((a) => (a === "x.json" ? path.join(dir, "x.json") : a)));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage: task-tracker-export");
    expect(fs.existsSync(path.join(dir, "x.json"))).toBe(false);
  });
});
