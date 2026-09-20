import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";

describe("openDatabase", () => {
  it("creates all ten schema tables", () => {
    const db = openDatabase(":memory:");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    // Kept as an exact list rather than a toContain: this assertion's whole
    // job is to fail when the schema grows, so that a new table is a
    // deliberate edit here and not a silent addition. It is also what says a
    // rebuild migration left no *_old table behind.
    expect(tables).toEqual([
      "epics",
      "handoff_notes",
      "projects",
      "release_plan_items",
      "release_plans",
      "releases",
      "task_amendments",
      "task_dependencies",
      "task_files",
      "tasks",
    ]);

    db.close();
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");

    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("t1", "missing-project", "Title", "now", "now"),
    ).toThrow();

    db.close();
  });
});
