import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import {
  BACKUP_TABLES,
  BackupRefusal,
  RootPathMapError,
  applyRootPathMap,
  exportProjects,
  importFromFile,
  importProjects,
  parseExport,
  parseRootPathMap,
  rootPathMapFromRecord,
  rewritePath,
  serializeExport,
  type ExportDocument,
  type ImportOptions,
} from "../src/domain/backup.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import { createRelease } from "../src/domain/releases.js";
import { getNextTask, getProjectStatus, listTasks } from "../src/domain/status.js";
import { createTask } from "../src/domain/tasks.js";
import { FIXED, insert, insertProject, resolveTsxCli, seedFullProject } from "./fixtures/backupSeed.js";
import { writeLegacyV1Db } from "./fixtures/legacyV1Db.js";

/**
 * TTM-107 import side of docs/design/backup-restore.md (D2 import rule, D7,
 * D8, D9, D10, "Behaviours to pin / TTM-107"). Expectations come from the
 * design, not from the implementation.
 */

const TABLES = BACKUP_TABLES.map((t) => t.table);
const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "ttmcp-import-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(name: string): DatabaseInstance {
  return openDatabase(path.join(dir, name));
}

/** The whole DB as a fixed-clock --all export: equal text means equal rows in every backed-up table. */
function snapshot(db: DatabaseInstance): string {
  return serializeExport(exportProjects(db, { all: true }, { now: FIXED }));
}

function totalRows(db: DatabaseInstance): number {
  return TABLES.reduce(
    (n, t) => n + (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    0,
  );
}

function clone(doc: ExportDocument): ExportDocument {
  return JSON.parse(JSON.stringify(doc)) as ExportDocument;
}

/** Runs `fn`, expecting a BackupRefusal; returns it. */
function refusal(fn: () => unknown): BackupRefusal {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BackupRefusal);
    return err as BackupRefusal;
  }
  throw new Error("expected a BackupRefusal, nothing was thrown");
}

/**
 * Two full projects (every table) plus, in p1: an in_progress task holding a
 * lease, a done task with a completion summary and a priority, a cancelled
 * release, a design doc path and hash; and a cross-project edge p1-t1 -> p2-t1.
 */
function seedSource(db: DatabaseInstance): void {
  seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
  seedFullProject(db, "p2", "Two", "2026-01-02T00:00:00.000Z");
  db.prepare(`UPDATE projects SET design_doc_path = 'docs/design.md', design_doc_hash = 'abc123' WHERE id = 'p1'`).run();
  insert(db, "task_dependencies", { task_id: "p1-t1", depends_on_task_id: "p2-t1" });
  insert(db, "tasks", {
    id: "p1-t3",
    project_id: "p1",
    title: "Leased",
    task_number: 3,
    status: "in_progress",
    owner_session_id: "sess-1",
    lock_expires_at: "2026-03-01T00:00:00.000Z",
    priority: 2,
    created_at: "2026-01-05T00:00:00.000Z",
    updated_at: "2026-01-05T00:00:00.000Z",
  });
  insert(db, "tasks", {
    id: "p1-t4",
    project_id: "p1",
    title: "Done",
    task_number: 4,
    status: "done",
    priority: 5,
    completion_summary: "did it",
    created_at: "2026-01-06T00:00:00.000Z",
    updated_at: "2026-01-06T00:00:00.000Z",
  });
  insert(db, "releases", {
    id: "p1-r2",
    project_id: "p1",
    version: "0.9.0",
    sequence: 20,
    status: "cancelled",
    cancellation_reason: "dropped",
    created_at: "2026-01-07T00:00:00.000Z",
  });
}

let sources = 0;
/** Export of a freshly seeded source DB (a new file per call, so calls are independent). */
function sourceExport(selection: string | { all: true } = { all: true }): ExportDocument {
  const src = open(`source-${sources++}.db`);
  try {
    seedSource(src);
    return exportProjects(src, selection, { now: FIXED });
  } finally {
    src.close();
  }
}

/** A target holding an unrelated project, so "unchanged" is checked on real rows. */
function seededTarget(): DatabaseInstance {
  const db = open("target.db");
  seedFullProject(db, "p9", "Nine", "2026-01-09T00:00:00.000Z");
  return db;
}

function entryOf(doc: ExportDocument, pid: string) {
  const entry = doc.projects.find((e) => e.project.id === pid);
  if (!entry) throw new Error(`no ${pid} in the file`);
  return entry;
}

// ---------------------------------------------------------------------------

describe("round trip (D7, behaviour 1)", () => {
  it("export -> import into an empty DB -> export is byte-identical, every table non-empty", () => {
    const doc = sourceExport();
    const text = serializeExport(doc);
    const target = open("target.db");
    const result = importProjects(target, parseExport(text));

    for (const t of TABLES) expect(result.counts[t], t).toBeGreaterThan(0);
    for (const t of TABLES) {
      const inFile = t === "projects" ? doc.projects.length : doc.projects.reduce((n, e) => n + e.rows[t].length, 0);
      expect(result.counts[t], t).toBe(inFile);
    }
    expect(result.projects).toEqual([
      { id: "p1", name: "One", code_prefix: "P1" },
      { id: "p2", name: "Two", code_prefix: "P2" },
    ]);
    expect(result.skipped_dependencies).toEqual([]);
    expect(snapshot(target)).toBe(text);
    target.close();
  });

  it("a single-project file imports beside an existing project and re-exports identically", () => {
    const doc = sourceExport("p2");
    const target = seededTarget();
    importProjects(target, doc);
    expect(serializeExport(exportProjects(target, "p2", { now: FIXED }))).toBe(serializeExport(doc));
    expect(serializeExport(exportProjects(target, "p9", { now: FIXED }))).toContain('"Nine"');
    target.close();
  });
});

describe("format and version refused before any write (D7 steps 1-3, behaviour 3)", () => {
  const base = (): Record<string, unknown> => clone(sourceExport("p1")) as unknown as Record<string, unknown>;
  const cases: Array<[string, (d: Record<string, unknown>) => unknown, string, RegExp]> = [
    ["a JSON array", () => [], "unsupported_format", /not a JSON object/],
    ["null", () => null, "unsupported_format", /not a JSON object/],
    ["format missing", (d) => (delete d.format, d), "unsupported_format", /format is missing/],
    ["another format", (d) => ({ ...d, format: "other" }), "unsupported_format", /"other"/],
    ["format_version 2", (d) => ({ ...d, format_version: 2 }), "unsupported_format", /format_version 2/],
    ["format_version \"1\"", (d) => ({ ...d, format_version: "1" }), "unsupported_format", /format_version "1"/],
    ["schema_version 0", (d) => ({ ...d, schema_version: 0 }), "unsupported_format", /schema_version 0/],
    ["schema_version 1.5", (d) => ({ ...d, schema_version: 1.5 }), "unsupported_format", /schema_version 1\.5/],
    ["schema_version \"1\"", (d) => ({ ...d, schema_version: "1" }), "unsupported_format", /schema_version "1"/],
    ["schema_version missing", (d) => (delete d.schema_version, d), "unsupported_format", /schema_version/],
    [
      "a newer schema_version",
      (d) => ({ ...d, schema_version: SCHEMA_VERSION + 1 }),
      "schema_mismatch",
      /newer than this build/,
    ],
    ["projects not an array", (d) => ({ ...d, projects: {} }), "unsupported_format", /projects is not an array/],
    [
      "an entry without rows",
      (d) => ({ ...d, projects: [{ project: (d.projects as ExportDocument["projects"])[0].project }] }),
      "unsupported_format",
      /projects\[0\]/,
    ],
    [
      "a rows value that is not an array of objects",
      (d) => {
        (d.projects as ExportDocument["projects"])[0].rows.tasks = [1 as never];
        return d;
      },
      "unsupported_format",
      /projects\[0\]\.rows\.tasks/,
    ],
  ];

  it.each(cases)("%s -> refused with the named cause, target unchanged", (_name, mutate, code, message) => {
    const doc = mutate(base());
    const target = seededTarget();
    const before = snapshot(target);
    const err = refusal(() => importProjects(target, doc as ExportDocument));
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
    expect(snapshot(target)).toBe(before);
    target.close();
  });

  it("invalid JSON text -> unsupported_format", () => {
    expect(refusal(() => parseExport("{ not json")).code).toBe("unsupported_format");
    expect(refusal(() => parseExport("{ not json")).message).toMatch(/invalid JSON/);
  });
});

describe("exact column check at equal schema_version (D2, behaviour 5 and 7)", () => {
  const cases: Array<[string, (d: ExportDocument) => void, RegExp]> = [
    ["an extra column", (d) => void (entryOf(d, "p1").rows.tasks[0].bogus = 1), /tasks\.bogus/],
    ["a missing nullable column", (d) => void delete entryOf(d, "p1").rows.tasks[0].completion_summary, /tasks\.completion_summary/],
    ["a missing defaulted column", (d) => void delete entryOf(d, "p1").rows.tasks[0].priority, /tasks\.priority/],
    ["a missing project column", (d) => void delete entryOf(d, "p1").project.design_doc_hash, /projects\.design_doc_hash/],
    ["a missing registry table", (d) => void delete entryOf(d, "p1").rows.task_files, /task_files/],
    ["an unknown table", (d) => void (entryOf(d, "p1").rows.bogus_table = []), /bogus_table/],
    ["an object value", (d) => void (entryOf(d, "p1").rows.tasks[0].title = { x: 1 } as never), /tasks\.title/],
    ["an array value", (d) => void (entryOf(d, "p1").rows.epics[0].name = ["x"] as never), /epics\.name/],
  ];

  it.each(cases)("%s -> schema_mismatch naming it, target unchanged", (_name, mutate, message) => {
    const doc = clone(sourceExport("p1"));
    mutate(doc);
    const target = seededTarget();
    const before = snapshot(target);
    const err = refusal(() => importProjects(target, doc));
    expect(err.code).toBe("schema_mismatch");
    expect(err.message).toMatch(message);
    expect(snapshot(target)).toBe(before);
    target.close();
  });
});

describe("older schema_version: subset rule (D2, behaviour 6 and 21)", () => {
  const older: ImportOptions = { currentSchemaVersion: SCHEMA_VERSION + 1 };

  it("rows missing a nullable and a defaulted column import as NULL and DEFAULT", () => {
    const doc = clone(sourceExport("p1"));
    for (const row of entryOf(doc, "p1").rows.tasks) {
      delete row.completion_summary;
      delete row.priority;
    }
    const target = open("target.db");
    importProjects(target, doc, older);
    const t4 = target.prepare(`SELECT priority, completion_summary, title FROM tasks WHERE id = 'p1-t4'`).get();
    expect(t4).toEqual({ priority: 0, completion_summary: null, title: "Done" });
    expect((target.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(4);
    target.close();
  });

  it("the same file at the current schema_version is refused (exact mode)", () => {
    const doc = clone(sourceExport("p1"));
    for (const row of entryOf(doc, "p1").rows.tasks) delete row.priority;
    const target = open("target.db");
    expect(refusal(() => importProjects(target, doc)).message).toMatch(/tasks\.priority/);
    expect(totalRows(target)).toBe(0);
    target.close();
  });

  it("a registry table missing from the file is imported as empty", () => {
    const doc = clone(sourceExport("p1"));
    delete entryOf(doc, "p1").rows.task_slices;
    delete entryOf(doc, "p1").rows.handoff_notes;
    const target = open("target.db");
    const result = importProjects(target, doc, older);
    expect(result.counts.task_slices).toBe(0);
    expect(result.counts.handoff_notes).toBe(0);
    expect(result.counts.tasks).toBe(4);
    expect(result.counts.task_amendments).toBe(1);
    target.close();
  });

  const refused: Array<[string, (d: ExportDocument) => void, RegExp]> = [
    ["a NOT NULL column without DEFAULT (tasks.title)", (d) => void delete entryOf(d, "p1").rows.tasks[1].title, /tasks\.title/],
    [
      "the projects.id primary key (review F1)",
      (d) => void delete entryOf(d, "p1").project.id,
      /projects\.id is required by this build/,
    ],
    ["the tasks.id primary key (review F1)", (d) => void delete entryOf(d, "p1").rows.tasks[0].id, /tasks\.id is required by this build/],
    ["an unknown column", (d) => void (entryOf(d, "p1").rows.tasks[0].bogus = "x"), /tasks\.bogus/],
    ["an unknown table", (d) => void (entryOf(d, "p1").rows.bogus_table = []), /bogus_table/],
  ];

  it.each(refused)("missing or unknown: %s -> schema_mismatch, nothing written", (_name, mutate, message) => {
    const doc = clone(sourceExport("p1"));
    mutate(doc);
    const target = open("target.db");
    const err = refusal(() => importProjects(target, doc, older));
    expect(err.code).toBe("schema_mismatch");
    expect(err.message).toMatch(message);
    expect(totalRows(target)).toBe(0);
    target.close();
  });
});

describe("clashes (D7 step 5, behaviours 8-9)", () => {
  /** p1's file entry with the given project fields; children dropped so only the clash can refuse. */
  function fileWith(project: Record<string, unknown>): ExportDocument {
    const doc = clone(sourceExport("p1"));
    const entry = entryOf(doc, "p1");
    entry.project = { ...entry.project, ...project };
    for (const t of Object.keys(entry.rows)) entry.rows[t] = [];
    return doc;
  }

  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["id", { name: "Fresh", code_prefix: "FR" }, ["project id already exists: p1"]],
    ["name", { id: "fresh", code_prefix: "FR" }, ["project name already exists: One"]],
    ["code_prefix", { id: "fresh", name: "Fresh" }, ["project code_prefix already exists: P1"]],
    [
      "id, name and code_prefix together",
      {},
      ["project id already exists: p1", "project name already exists: One", "project code_prefix already exists: P1"],
    ],
  ];

  it.each(cases)("on %s -> clash naming each, target unchanged", (_name, project, expected) => {
    const target = open("target.db");
    seedFullProject(target, "p1", "One", "2026-01-01T00:00:00.000Z");
    const before = snapshot(target);
    const err = refusal(() => importProjects(target, fileWith(project)));
    expect(err.code).toBe("clash");
    for (const m of expected) expect(err.message).toContain(m);
    expect(snapshot(target)).toBe(before);
    target.close();
  });

  it("a null code_prefix never clashes with another null one", () => {
    const target = open("target.db");
    insert(target, "projects", { id: "q", name: "Q", root_path: "/q", code_prefix: null, created_at: "2026-01-01" });
    const result = importProjects(target, fileWith({ id: "fresh", name: "Fresh", code_prefix: null }));
    expect(result.projects).toEqual([{ id: "fresh", name: "Fresh", code_prefix: null }]);
    target.close();
  });

  it("the same id, name or code_prefix twice inside the file -> clash, nothing written", () => {
    const one = fileWith({ id: "a", name: "Same", code_prefix: "SA" });
    const two = fileWith({ id: "a", name: "Same", code_prefix: "SA" });
    const doc = { ...one, projects: [...one.projects, ...two.projects] };
    const target = open("target.db");
    const err = refusal(() => importProjects(target, doc));
    expect(err.code).toBe("clash");
    for (const k of ["id", "name", "code_prefix"]) expect(err.message).toContain(`project ${k} appears twice in the file`);
    expect(totalRows(target)).toBe(0);
    target.close();
  });
});

describe("reference closure (D7 step 6, D9, behaviours 10-11)", () => {
  const cases: Array<[string, string, (d: ExportDocument) => void]> = [
    ["tasks", "project_id", (d) => void (entryOf(d, "p1").rows.tasks[0].project_id = "nope")],
    ["tasks", "epic_id", (d) => void (entryOf(d, "p1").rows.tasks[0].epic_id = "nope")],
    ["tasks", "release_id", (d) => void (entryOf(d, "p1").rows.tasks[0].release_id = "nope")],
    ["release_plans", "release_id", (d) => void (entryOf(d, "p1").rows.release_plans[0].release_id = "nope")],
    ["release_plan_items", "plan_id", (d) => void (entryOf(d, "p1").rows.release_plan_items[0].plan_id = "nope")],
    ["release_plan_items", "task_id", (d) => void (entryOf(d, "p1").rows.release_plan_items[0].task_id = "nope")],
    ["task_dependencies", "task_id", (d) => void (entryOf(d, "p1").rows.task_dependencies[0].task_id = "nope")],
    ["handoff_notes", "task_id", (d) => void (entryOf(d, "p1").rows.handoff_notes[0].task_id = "nope")],
    ["task_slices", "task_id", (d) => void (entryOf(d, "p1").rows.task_slices[0].task_id = "nope")],
  ];

  it.each(cases)("dangling %s.%s -> dangling_reference naming it, target unchanged", (table, column, mutate) => {
    const doc = clone(sourceExport({ all: true }));
    mutate(doc);
    const target = seededTarget();
    const before = snapshot(target);
    const err = refusal(() => importProjects(target, doc));
    expect(err.code).toBe("dangling_reference");
    expect(err.message).toContain(`${table}.${column} = nope`);
    expect(snapshot(target)).toBe(before);
    target.close();
  });

  it("a cross-project edge whose target is in neither file nor DB is skipped and reported; the rest imports", () => {
    const doc = sourceExport("p1");
    const target = open("target.db");
    const result = importProjects(target, doc);
    expect(result.skipped_dependencies).toEqual([{ task_id: "p1-t1", depends_on_task_id: "p2-t1" }]);
    expect(result.counts.task_dependencies).toBe(1);
    expect(target.prepare(`SELECT task_id, depends_on_task_id FROM task_dependencies`).all()).toEqual([
      { task_id: "p1-t2", depends_on_task_id: "p1-t1" },
    ]);
    expect(result.counts.tasks).toBe(4);
    target.close();
  });

  it("a cross-project edge whose target task is already in the DB is inserted", () => {
    const p2 = sourceExport("p2");
    const p1 = sourceExport("p1");
    const target = open("target.db");
    importProjects(target, p2);
    const result = importProjects(target, p1);
    expect(result.skipped_dependencies).toEqual([]);
    expect(result.counts.task_dependencies).toBe(2);
    expect(
      target.prepare(`SELECT 1 FROM task_dependencies WHERE task_id = 'p1-t1' AND depends_on_task_id = 'p2-t1'`).get(),
    ).toBeTruthy();
    target.close();
  });
});

describe("one write transaction (D7 step 7, behaviour 12)", () => {
  it("a SQLite error mid-insert (forged handoff_notes PK clash) rolls everything back", () => {
    const doc = clone(sourceExport("p2"));
    entryOf(doc, "p2").rows.handoff_notes[0].id = "p9-h1"; // exists in the target
    const target = seededTarget();
    const before = snapshot(target);
    expect(() => importProjects(target, doc)).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    expect(snapshot(target)).toBe(before);
    expect(target.prepare(`SELECT 1 FROM projects WHERE id = 'p2'`).get()).toBeUndefined();
    target.close();
  });
});

describe("counters continue after import (behaviour 13)", () => {
  it("create_task gets MAX(task_number)+1 and create_release the next sequence", () => {
    const target = open("target.db");
    importProjects(target, sourceExport("p1"));
    const { task } = createTask(target, noopEstimator, { project_id: "p1", title: "New", complexity_hint: "normal" });
    expect(task.task_number).toBe(5);
    const release = createRelease(target, { project_id: "p1", version: "2.0.0" });
    expect(release.sequence).toBe(30);
    target.close();
  });
});

describe("imported DB answers like the source (behaviour 14)", () => {
  /**
   * Three pending tasks share one created_at and were inserted in task_number
   * order, as the domain creates them; their ids sort the other way, so the
   * file (ordered by id) lists them in reverse. Queries ORDER BY created_at
   * fall back to rowid on the tie.
   */
  function seedTie(db: DatabaseInstance): void {
    insertProject(db, "eq", "Equal", "2026-01-01T00:00:00.000Z");
    const ts = "2026-02-01T00:00:00.000Z";
    for (const [id, n] of [
      ["eq-z", 1],
      ["eq-y", 2],
      ["eq-x", 3],
    ] as const) {
      insert(db, "tasks", { id, project_id: "eq", title: id, task_number: n, created_at: ts, updated_at: ts });
    }
    insert(db, "tasks", {
      id: "eq-w",
      project_id: "eq",
      title: "later",
      task_number: 4,
      status: "done",
      created_at: "2026-02-02T00:00:00.000Z",
      updated_at: "2026-02-02T00:00:00.000Z",
    });
  }

  it("getProjectStatus, listTasks and getNextTask agree, created_at ties in source order", () => {
    const src = open("source.db");
    seedTie(src);
    const target = open("target.db");
    importProjects(target, exportProjects(src, "eq", { now: FIXED }));

    const order = listTasks(src, "eq").map((t) => t.id);
    expect(order).toEqual(["eq-z", "eq-y", "eq-x", "eq-w"]);
    expect(listTasks(target, "eq")).toEqual(listTasks(src, "eq"));
    expect(getProjectStatus(target, "eq")).toEqual(getProjectStatus(src, "eq"));

    // getNextTask hands the task out (writes a lease stamped with the real
    // clock), so compare what it picks, not its timestamps.
    const a = getNextTask(src, "eq");
    const b = getNextTask(target, "eq");
    expect(a.task?.id).toBe("eq-z");
    expect(b.task?.id).toBe(a.task?.id);
    expect(b.doc_drift).toBe(a.doc_drift);
    src.close();
    target.close();
  });
});

describe("--root-path-map (D8, behaviours 15-19)", () => {
  it("rewritePath: whole-segment prefix, longest old wins, rest kept byte for byte, relative untouched", () => {
    const maps = parseRootPathMap(["/a=/p", "/a/b=/q"]);
    expect(rewritePath("/a/b", maps)).toBe("/q");
    expect(rewritePath("/a/b/x", maps)).toBe("/q/x");
    expect(rewritePath("/a/bc", maps)).toBe("/p/bc");
    expect(rewritePath("/a/b//c/../D", maps)).toBe("/q//c/../D");
    expect(rewritePath("/ab", maps)).toBe("/ab");
    expect(rewritePath("a/b/x", maps)).toBe("a/b/x");
    expect(rewritePath("/a/b/x", [...maps].reverse())).toBe("/q/x");
    const only = parseRootPathMap(["/a/b=/q"]);
    expect(rewritePath("/a/bc", only)).toBe("/a/bc");
  });

  it("rewritePath: a root map on either side", () => {
    expect(rewritePath("/x/y", parseRootPathMap(["/=/r"]))).toBe("/r/x/y");
    expect(rewritePath("/x/y", parseRootPathMap(["/x=/"]))).toBe("/y");
    expect(rewritePath("/x", parseRootPathMap(["/x=/"]))).toBe("/");
  });

  it("parseRootPathMap: splits on the first '=', strips a trailing '/', refuses a non-absolute side", () => {
    expect(parseRootPathMap(["/a/b/=/c/"])).toEqual([{ old: "/a/b", new: "/c" }]);
    expect(parseRootPathMap(["/a=/b=c"])).toEqual([{ old: "/a", new: "/b=c" }]);
    for (const bad of ["rel=/x", "/x=rel", "/x", "=/x", "/x="]) {
      expect(() => parseRootPathMap([bad]), bad).toThrow(RootPathMapError);
    }
  });

  it("parseRootPathMap: an old prefix containing '=' splits at the '=' before the absolute new path", () => {
    expect(parseRootPathMap(["/a=b=/c"])).toEqual([{ old: "/a=b", new: "/c" }]);
  });

  it("parseRootPathMap: more than one '=/' is refused as ambiguous, naming the entry", () => {
    let error: unknown;
    try {
      parseRootPathMap(["/a=/b=/c"]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RootPathMapError);
    expect((error as Error).message).toContain("/a=/b=/c");
    expect((error as Error).message).toContain("ambiguous");
  });

  it("parseRootPathMap: error messages keep the --root-path-map prefix and say what is wrong", () => {
    const message = (entry: string) => {
      try {
        parseRootPathMap([entry]);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(message("/x")).toBe("--root-path-map /x: expected old=new");
    expect(message("rel=/x")).toBe("--root-path-map rel=/x: both sides must be absolute paths");
  });

  it("rootPathMapFromRecord: keys and values are kept whole, '=' included", () => {
    expect(rootPathMapFromRecord({ "/a=b": "/c" })).toEqual([{ old: "/a=b", new: "/c" }]);
    expect(rootPathMapFromRecord({ "/a": "/b=/c" })).toEqual([{ old: "/a", new: "/b=/c" }]);
  });

  it("rootPathMapFromRecord: a relative key or value names root_path_map, not the CLI flag", () => {
    for (const record of [{ rel: "/x" }, { "/x": "rel" }] as Record<string, string>[]) {
      let error: unknown;
      try {
        rootPathMapFromRecord(record);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RootPathMapError);
      expect((error as Error).message.startsWith("root_path_map")).toBe(true);
      expect((error as Error).message).not.toContain("--root-path-map");
    }
  });

  function seedPaths(db: DatabaseInstance): void {
    insert(db, "projects", {
      id: "rp",
      name: "Paths",
      root_path: "/src/root",
      code_prefix: "RP",
      design_doc_path: "/src/root/docs/d.md",
      design_doc_hash: "hash-1",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const ts = "2026-01-02T00:00:00.000Z";
    insert(db, "tasks", { id: "rp-t1", project_id: "rp", title: "T", task_number: 1, created_at: ts, updated_at: ts });
    for (const f of ["/src/root/a.ts", "/src/rootling/b.ts", "rel/c.ts", "/src/root"]) {
      insert(db, "task_files", { task_id: "rp-t1", file_path: f });
    }
    const artifacts = [
      '["/src/root/x.ts",3,"rel.ts",null]',
      '[ "rel.ts" ]',
      "not json",
      '{"p":"/src/root/x"}',
      '["/src/root/deep/y.ts"]',
    ];
    artifacts.forEach((a, i) =>
      insert(db, "task_slices", {
        id: `rp-s${i + 1}`,
        task_id: "rp-t1",
        phase: "implement",
        step: i + 1,
        position: 0,
        title: "S",
        artifacts: a,
        label_number: i + 1,
        created_at: ts,
        updated_at: ts,
      }),
    );
    insert(db, "task_amendments", {
      id: "rp-a1",
      task_id: "rp-t1",
      field: "file_paths",
      previous_value: '["/src/root/old.ts"]',
      reason: "moved",
      amended_at: ts,
    });
  }

  it("rewrites the four D8 columns only, reports counts, unused maps and unparseable artifacts", () => {
    const src = open("source.db");
    seedPaths(src);
    const doc = exportProjects(src, "rp", { now: FIXED });
    const original = JSON.stringify(doc);
    const target = open("target.db");
    const result = importProjects(target, doc, {
      rootPathMap: parseRootPathMap(["/src/root=/dst", "/src/root/deep=/deeper", "/nowhere=/x"]),
    });

    expect(JSON.stringify(doc)).toBe(original);
    expect(result.root_path_rewrites).toEqual({
      "projects.root_path": 1,
      "projects.design_doc_path": 1,
      "task_files.file_path": 2,
      "task_slices.artifacts": 2,
    });
    expect(result.unused_root_path_maps).toEqual(["/nowhere=/x"]);
    expect(result.artifacts_not_rewritten).toEqual(["rp-s3", "rp-s4"]);

    expect(target.prepare(`SELECT root_path, design_doc_path, design_doc_hash FROM projects`).get()).toEqual({
      root_path: "/dst",
      design_doc_path: "/dst/docs/d.md",
      design_doc_hash: "hash-1",
    });
    const files = (target.prepare(`SELECT file_path FROM task_files ORDER BY file_path`).all() as Array<{
      file_path: string;
    }>).map((r) => r.file_path);
    expect(files).toEqual(["/dst", "/dst/a.ts", "/src/rootling/b.ts", "rel/c.ts"]);
    const slices = (target.prepare(`SELECT artifacts FROM task_slices ORDER BY id`).all() as Array<{
      artifacts: string;
    }>).map((r) => r.artifacts);
    expect(slices).toEqual([
      '["/dst/x.ts",3,"rel.ts",null]',
      '[ "rel.ts" ]',
      "not json",
      '{"p":"/src/root/x"}',
      '["/deeper/y.ts"]',
    ]);
    expect(target.prepare(`SELECT previous_value FROM task_amendments`).get()).toEqual({
      previous_value: '["/src/root/old.ts"]',
    });
    src.close();
    target.close();
  });

  it("a relative design_doc_path is not rewritten", () => {
    const doc = clone(sourceExport("p1"));
    const out = applyRootPathMap(doc, parseRootPathMap(["/repo/p1=/new"]));
    expect(out.doc.projects[0].project.root_path).toBe("/new");
    expect(out.doc.projects[0].project.design_doc_path).toBe("docs/design.md");
    expect(out.root_path_rewrites["projects.design_doc_path"]).toBe(0);
  });

  it("importFromFile: a malformed map is refused before the file is read; the result carries the resolved path", () => {
    const target = open("target.db");
    expect(() => importFromFile(target, path.join(dir, "missing.json"), { rootPathMap: parseRootPathMap(["rel=/x"]) })).toThrow(
      RootPathMapError,
    );
    const file = path.join(dir, "p1.json");
    fs.writeFileSync(file, serializeExport(sourceExport("p1")));
    const result = importFromFile(target, path.relative(process.cwd(), file), { rootPathMap: parseRootPathMap(["/repo/p1=/new"]) });
    expect(result.path).toBe(file);
    expect(result.root_path_rewrites["projects.root_path"]).toBe(1);
    target.close();
  });
});

// ---------------------------------------------------------------------------
// CLI (D10), spawned the way tests/cli.test.ts spawns the status bin.

const tsxCli = resolveTsxCli();
const importCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "import.ts");

function runImport(dbPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [tsxCli, importCli, ...args], {
    env: { ...process.env, TASK_TRACKER_DB_PATH: dbPath },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("task-tracker-import CLI (D10, behaviours 16, 20, 22)", { timeout: 30_000 }, () => {
  let file: string;
  let text: string;
  beforeEach(() => {
    text = serializeExport(sourceExport("p1"));
    file = path.join(dir, "p1.json");
    fs.writeFileSync(file, text);
  });

  it("imports into a missing DB path: exit 0, path then per-table counts and skipped edges; re-export identical", () => {
    const dbPath = path.join(dir, "new", "tracker.db");
    const r = runImport(dbPath, [file, "--root-path-map", "/nowhere=/x"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe(file);
    expect(r.stdout).toContain("  project: P1 One (p1)");
    for (const t of TABLES) expect(r.stdout).toMatch(new RegExp(`^  ${t}: \\d+$`, "m"));
    expect(r.stdout).toContain("  tasks: 4");
    expect(r.stdout).toContain("  skipped_dependencies: 1");
    expect(r.stdout).toContain("p1-t1 -> p2-t1");
    expect(r.stdout).toContain("unused root-path map: /nowhere=/x");
    const db = openDatabase(dbPath);
    const reexport = exportProjects(db, "p1", { now: FIXED });
    db.close();
    // The skipped edge is the only difference from the file.
    const expected = JSON.parse(text) as ExportDocument;
    expected.projects[0].rows.task_dependencies = expected.projects[0].rows.task_dependencies.filter(
      (e) => e.depends_on_task_id !== "p2-t1",
    );
    expect(serializeExport(reexport)).toBe(serializeExport(expected));
  });

  it("a clash: exit 1 naming it on stderr, target unchanged", () => {
    const dbPath = path.join(dir, "tracker.db");
    const db = openDatabase(dbPath);
    seedFullProject(db, "p1", "One", "2026-01-01T00:00:00.000Z");
    const before = snapshot(db);
    db.close();
    const r = runImport(dbPath, [file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("project id already exists: p1");
    const after = openDatabase(dbPath);
    expect(snapshot(after)).toBe(before);
    after.close();
  });

  it("--root-path-map rewrites root_path and reports it", () => {
    const dbPath = path.join(dir, "tracker.db");
    const r = runImport(dbPath, [file, "--root-path-map", "/repo/p1/=/moved"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  rewritten projects.root_path: 1");
    const db = openDatabase(dbPath);
    expect(db.prepare(`SELECT root_path FROM projects WHERE id = 'p1'`).get()).toEqual({ root_path: "/moved" });
    db.close();
  });

  const invalid: Array<[string, () => string, RegExp]> = [
    ["a newer schema_version", () => write({ ...JSON.parse(text), schema_version: SCHEMA_VERSION + 1 }), /newer than this build/],
    ["an unknown format_version", () => write({ ...JSON.parse(text), format_version: 9 }), /format_version 9/],
    ["a missing format", () => write({ ...JSON.parse(text), format: undefined }), /format is missing/],
    ["invalid JSON", () => writeRaw("{ nope"), /invalid JSON/],
    ["a missing file", () => path.join(dir, "absent.json"), /absent\.json/],
  ];
  function write(value: unknown): string {
    return writeRaw(JSON.stringify(value));
  }
  function writeRaw(content: string): string {
    const f = path.join(dir, "bad.json");
    fs.writeFileSync(f, content);
    return f;
  }

  it.each(invalid)("%s: exit 1 naming the cause, neither the DB file nor its directory created (F2)", (_n, make, message) => {
    const dbDir = path.join(dir, "nodb");
    const r = runImport(path.join(dbDir, "tracker.db"), [make()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(fs.existsSync(dbDir)).toBe(false);
  });

  it("an invalid file leaves an existing older DB unmigrated (F2)", () => {
    const dbPath = path.join(dir, "legacy.db");
    writeLegacyV1Db(dbPath);
    const r = runImport(dbPath, [write({ ...JSON.parse(text), format_version: 9 })]);
    expect(r.status).toBe(1);
    const raw = new Database(dbPath, { readonly: true });
    const epics = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epics'`).get();
    raw.close();
    expect(epics).toBeUndefined();
  });

  const usage: Array<[string, () => string[]]> = [
    ["no file", () => []],
    ["two files", () => [file, file]],
    ["an unknown flag", () => [file, "--bogus"]],
    ["a non-absolute map side", () => [file, "--root-path-map", "rel=/x"]],
    ["a map without '='", () => [file, "--root-path-map", "/x"]],
  ];

  it.each(usage)("usage error (%s): exit 2 with usage, no DB created", (_n, args) => {
    const dbDir = path.join(dir, "nodb");
    const r = runImport(path.join(dbDir, "tracker.db"), args());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage: task-tracker-import");
    expect(fs.existsSync(dbDir)).toBe(false);
  });
});
