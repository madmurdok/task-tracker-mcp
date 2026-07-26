import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask, listTaskFilePaths, requireTask, setTaskPriority } from "../src/domain/tasks.js";
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
      complexity_hint: "normal",
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
      complexity_hint: "normal",
    });

    expect(over_budget).toBe(true);
  });

  it("rejects an unknown project", () => {
    const db = openDatabase(":memory:");

    expect(() =>
      createTask(db, stubEstimator(0), { project_id: "missing", title: "x", complexity_hint: "normal" }),
    ).toThrow(/Unknown project: missing/);
  });

  it("accepts a project name in place of project_id and stores the literal id as the FK", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const { task } = createTask(db, stubEstimator(0), {
      project_id: "Demo",
      title: "x",
      complexity_hint: "normal",
    });

    expect(task.project_id).toBe(project.id);
    const row = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(task.id);
    expect(row).toMatchObject({ project_id: project.id });
  });
});

describe("requireTask", () => {
  it("resolves a task by id", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "x",
      complexity_hint: "normal",
    });

    expect(requireTask(db, task.id)).toEqual(task);
  });

  it("throws for an unknown task_id", () => {
    const db = openDatabase(":memory:");
    expect(() => requireTask(db, "missing")).toThrow(/Unknown task_id: missing/);
  });
});

describe("listTaskFilePaths", () => {
  it("returns a task's declared files in sorted order", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "x",
      file_paths: ["src/b.ts", "src/a.ts"],
      complexity_hint: "normal",
    });

    expect(listTaskFilePaths(db, task.id)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns an empty array for a task with no declared files", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "x",
      complexity_hint: "normal",
    });

    expect(listTaskFilePaths(db, task.id)).toEqual([]);
  });
});

describe("setTaskPriority", () => {
  it("updates a task's priority", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "x",
      complexity_hint: "normal",
    });

    setTaskPriority(db, task.id, 5);

    const row = db.prepare("SELECT priority FROM tasks WHERE id = ?").get(task.id);
    expect(row).toMatchObject({ priority: 5 });
  });

  it("rejects an unknown task_id", () => {
    const db = openDatabase(":memory:");
    expect(() => setTaskPriority(db, "missing", 5)).toThrow(/Unknown task_id: missing/);
  });
});
