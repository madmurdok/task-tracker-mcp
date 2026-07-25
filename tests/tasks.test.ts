import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

function stubEstimator(tokens: number): BudgetEstimator {
  return { estimateTokens: () => tokens };
}

describe("createTask", () => {
  it("inserts a task and its file list, scoped to the project", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const { task, over_budget } = createTask(db, stubEstimator(500), {
      project_id: project.id,
      title: "Build the thing",
      file_paths: ["src/a.ts", "src/b.ts"],
    });

    expect(task.status).toBe("pending");
    expect(task.estimated_tokens).toBe(500);
    expect(over_budget).toBe(false);

    const files = db
      .prepare("SELECT file_path FROM task_files WHERE task_id = ? ORDER BY file_path")
      .all(task.id);
    expect(files).toEqual([{ file_path: "src/a.ts" }, { file_path: "src/b.ts" }]);
  });

  it("flags a task as over budget once the estimate crosses the threshold", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const { over_budget } = createTask(db, stubEstimator(20_000), {
      project_id: project.id,
      title: "A huge task",
    });

    expect(over_budget).toBe(true);
  });

  it("rejects an unknown project_id", () => {
    const db = openDatabase(":memory:");

    expect(() =>
      createTask(db, stubEstimator(0), { project_id: "missing", title: "x" }),
    ).toThrow(/Unknown project_id/);
  });
});
