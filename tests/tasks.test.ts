import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import {
  createTask,
  listTaskFilePaths,
  requireTask,
  setTaskPriority,
  splitTask,
  taskCode,
} from "../src/domain/tasks.js";
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

  it("assigns the next task_number in the project, starting at 1", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const numbers = ["a", "b", "c"].map(
      (title) =>
        createTask(db, stubEstimator(0), {
          project_id: project.id,
          title,
          complexity_hint: "normal",
        }).task.task_number,
    );

    expect(numbers).toEqual([1, 2, 3]);
  });

  it("persists task_number to the row, not just the returned object", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    createTask(db, stubEstimator(0), { project_id: project.id, title: "a", complexity_hint: "normal" });

    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "b",
      complexity_hint: "normal",
    });

    expect(requireTask(db, task.id).task_number).toBe(2);
  });

  it("counts task numbers independently per project", () => {
    const db = openDatabase(":memory:");
    const first = createProject(db, { name: "First", root_path: "/tmp/first" });
    const second = createProject(db, { name: "Second", root_path: "/tmp/second" });

    const create = (projectId: string, title: string) =>
      createTask(db, stubEstimator(0), { project_id: projectId, title, complexity_hint: "normal" }).task
        .task_number;

    expect(create(first.id, "a")).toBe(1);
    expect(create(second.id, "a")).toBe(1);
    expect(create(first.id, "b")).toBe(2);
    expect(create(second.id, "b")).toBe(2);
    expect(create(second.id, "c")).toBe(3);
  });

  it("leaves a split task's number as a gap rather than handing it to a subtask", () => {
    // splitTask deletes the task it replaces. Its subtasks are created first,
    // so they take fresh numbers above it and the retired number is never
    // pointed at different work than the one it was originally quoted for.
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const create = (title: string) =>
      createTask(db, stubEstimator(0), { project_id: project.id, title, complexity_hint: "normal" }).task;
    create("first");
    const doomed = create("second");

    const { new_task_ids } = splitTask(db, stubEstimator(0), doomed.id, [
      { title: "part a" },
      { title: "part b" },
    ]);

    expect(new_task_ids.map((id) => requireTask(db, id).task_number)).toEqual([3, 4]);
    expect(create("later").task_number).toBe(5);
  });
});

describe("taskCode", () => {
  it("renders a project prefix and task number as PREFIX-N", () => {
    expect(taskCode("TTM", 42)).toBe("TTM-42");
  });

  it("builds the code a freshly created task should display", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "task-tracker-mcp", root_path: "/tmp/ttm" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "first",
      complexity_hint: "normal",
    });

    expect(taskCode(project.code_prefix, task.task_number)).toBe("TTM-1");
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
