import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { addDependency } from "../src/domain/dependencies.js";
import { addHandoffNote } from "../src/domain/handoffNotes.js";
import { createProject } from "../src/domain/projects.js";
import { createRelease } from "../src/domain/releases.js";
import {
  createTask,
  deleteTask,
  listTaskFilePaths,
  requireTask,
  setTaskPriority,
  splitTask,
  taskCode,
  resolveTaskId,
  withCode,
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

describe("deleteTask", () => {
  it("removes a backlog task's row plus its task_files, task_dependencies (both directions), and handoff_notes", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const prerequisite = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "prerequisite",
      complexity_hint: "normal",
    }).task;
    const dependent = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "dependent",
      complexity_hint: "normal",
    }).task;
    const target = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "target",
      file_paths: ["src/a.ts"],
      complexity_hint: "normal",
    }).task;

    addDependency(db, target.id, prerequisite.id);
    addDependency(db, dependent.id, target.id);
    addHandoffNote(db, { task_id: target.id, session_id: "session-1", decisions: "did stuff" });

    deleteTask(db, target.id);

    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(target.id)).toBeUndefined();
    expect(db.prepare("SELECT * FROM task_files WHERE task_id = ?").all(target.id)).toEqual([]);
    expect(
      db
        .prepare("SELECT * FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?")
        .all(target.id, target.id),
    ).toEqual([]);
    expect(db.prepare("SELECT * FROM handoff_notes WHERE task_id = ?").all(target.id)).toEqual([]);

    // unrelated rows survive
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(prerequisite.id)).toBeDefined();
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(dependent.id)).toBeDefined();
  });

  it("rejects a task that has a release_id, without deleting anything", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const release = createRelease(db, { project_id: project.id, version: "1.0.0" });
    const task = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "in a release",
      release_id: release.id,
      complexity_hint: "normal",
    }).task;

    expect(() => deleteTask(db, task.id)).toThrow(
      /is in a release; only backlog tasks \(no release\) can be deleted/,
    );
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id)).toBeDefined();
  });

  it("rejects an unknown task_id", () => {
    const db = openDatabase(":memory:");
    expect(() => deleteTask(db, "missing")).toThrow(/Unknown task_id: missing/);
  });
});

describe("addressing a task by its code", () => {
  it("resolves PREFIX-N to the same task as its uuid, and leaves a uuid alone", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "task-tracker-mcp", root_path: "/tmp/ttm" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "Anything",
      complexity_hint: "normal",
    });

    const code = taskCode(project.code_prefix, task.task_number);
    expect(resolveTaskId(db, code)).toBe(task.id);
    expect(resolveTaskId(db, task.id)).toBe(task.id);
    expect(requireTask(db, code).id).toBe(task.id);
  });

  it("matches a prefix case-insensitively, since a code gets retyped by hand", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "Anything",
      complexity_hint: "normal",
    });

    expect(resolveTaskId(db, `gm-${task.task_number}`)).toBe(task.id);
  });

  it("keeps the same number in two projects apart", () => {
    // task_number is unique per project, so the prefix is the whole of what
    // makes a code globally unique - and a resolver that ignored it would
    // silently act on the wrong project's task.
    const db = openDatabase(":memory:");
    const gm = createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });
    const bench = createProject(db, { name: "g-mesh-bench", root_path: "/tmp/gmb" });
    const first = createTask(db, stubEstimator(0), {
      project_id: gm.id,
      title: "In g-mesh",
      complexity_hint: "normal",
    }).task;
    const second = createTask(db, stubEstimator(0), {
      project_id: bench.id,
      title: "In bench",
      complexity_hint: "normal",
    }).task;

    expect(first.task_number).toBe(second.task_number);
    expect(resolveTaskId(db, taskCode(gm.code_prefix, first.task_number))).toBe(first.id);
    expect(resolveTaskId(db, taskCode(bench.code_prefix, second.task_number))).toBe(second.id);
  });

  it("hands anything that is not a code straight back, so callers report their own error", () => {
    const db = openDatabase(":memory:");
    createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });

    // A well-formed code for a task that does not exist, and three shapes that
    // are not codes at all. All fall through to the caller's own "unknown
    // task" message rather than inventing a second failure mode.
    for (const ref of ["GM-9999", "GM-", "-7", "GM-x", "not-a-code"]) {
      expect(resolveTaskId(db, ref)).toBe(ref);
    }
  });

  it("puts the code on the row, so a caller never assembles one by hand", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "Anything",
      complexity_hint: "normal",
    });

    expect(withCode(db, task).code).toBe(taskCode(project.code_prefix, task.task_number));
  });
});
