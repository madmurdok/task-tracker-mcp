import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseInstance } from "../../src/db/connection.js";

/**
 * Seed helpers shared by the export (TTM-106) and import (TTM-107) tests of
 * docs/design/backup-restore.md.
 */

export const FIXED = () => new Date("2026-10-23T12:00:00.000Z");

export function insert(db: DatabaseInstance, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
}

export function insertProject(db: DatabaseInstance, id: string, name: string, createdAt: string): void {
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
export function seedChildren(db: DatabaseInstance, pid: string): void {
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
export function seedFullProject(db: DatabaseInstance, pid: string, name: string, createdAt: string): void {
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

/** tsx's CLI entry, resolved like tests/cli.test.ts does (works from a worktree too). */
export function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("tsx/package.json");
  const bin = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { bin: string }).bin;
  return path.resolve(path.dirname(manifestPath), bin);
}
