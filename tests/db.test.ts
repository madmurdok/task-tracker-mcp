import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";

describe("openDatabase", () => {
  it("creates all five schema tables", () => {
    const db = openDatabase(":memory:");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      "handoff_notes",
      "projects",
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
