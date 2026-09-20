import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { addDependency } from "../src/domain/dependencies.js";
import { addHandoffNote } from "../src/domain/handoffNotes.js";
import { claimTask, completeTask } from "../src/domain/lifecycle.js";
import { createProject } from "../src/domain/projects.js";
import { createRelease } from "../src/domain/releases.js";
import {
  amendTask,
  createTask,
  deleteTask,
  listTaskFilePaths,
  requireTask,
  setTaskPriority,
  splitTask,
  taskCode,
  resolveTaskId,
  withCode,
  runOne,
} from "../src/domain/tasks.js";
import { listTaskAmendments } from "../src/domain/taskAmendments.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import type { CompletionVerifier } from "../src/domain/verification.js";

function stubEstimator(tokens: number): BudgetEstimator {
  return { estimateTokens: () => tokens };
}

const noopVerifier: CompletionVerifier = { verify: () => ({ passed: true, reason: "noop" }) };

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

describe("a task-mutating call given a code changes the row it names", () => {
  // The class this guards: a reference resolved for the *read* and left raw in
  // the write. SQLite matches nothing, raises nothing, and the tool reports
  // success - which is how set_task_release accepted eleven codes and moved
  // none. Each of these asserts the row afterwards, never the absence of a
  // throw, because the absence of a throw was exactly the bug.
  function projectWithTask() {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "g-mesh", root_path: "/tmp/gm" });
    const { task } = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "Anything",
      complexity_hint: "normal",
    });
    return { db, project, task, code: taskCode(project.code_prefix, task.task_number) };
  }

  it("set_task_priority", () => {
    const { db, task, code } = projectWithTask();
    setTaskPriority(db, code, 7);
    expect(requireTask(db, task.id).priority).toBe(7);
  });

  it("add_handoff_note", () => {
    const { db, task, code } = projectWithTask();
    const note = addHandoffNote(db, { task_id: code, session_id: "s1", decisions: "d" });
    // Stored against the uuid, or the foreign key would have rejected it and
    // the note would be addressed by something no other query can find.
    expect(note.task_id).toBe(task.id);
  });

  it("delete_task", () => {
    const { db, task, code } = projectWithTask();
    deleteTask(db, code);
    expect(() => requireTask(db, task.id)).toThrow(/Unknown task_id/);
  });

  it("runOne refuses a write that matched nothing", () => {
    const { db } = projectWithTask();
    expect(() =>
      runOne(db.prepare(`UPDATE tasks SET priority = ? WHERE id = ?`), "probe", 1, "no-such-row"),
    ).toThrow(/matched 0 rows/);
  });
});

describe("amendTask", () => {
  // One task per test, put into the status the test needs to exercise -
  // acceptance for TTM-81 asks for a case at each of pending/in_progress/done.
  function pendingTask(db: ReturnType<typeof openDatabase>) {
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const task = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "The memory-limit suspension test is flaky on Windows",
      description: "Windows-only, retried three times",
      acceptance_criteria: "Passes on a Windows runner ten times in a row",
      complexity_hint: "normal",
    }).task;
    return { db, project, task };
  }

  it("corrects a pending task's title, recording the previous value under the given reason", () => {
    const { db, task } = pendingTask(openDatabase(":memory:"));

    const { amendments } = amendTask(db, stubEstimator(0), task.id, {
      title: "The memory-limit suspension test is flaky",
      reason: "it just failed on macOS too, so the Windows-specific title is now misleading (GM-340)",
    });

    expect(requireTask(db, task.id).title).toBe("The memory-limit suspension test is flaky");
    expect(amendments).toEqual([
      expect.objectContaining({
        task_id: task.id,
        field: "title",
        previous_value: "The memory-limit suspension test is flaky on Windows",
        reason: "it just failed on macOS too, so the Windows-specific title is now misleading (GM-340)",
      }),
    ]);
  });

  it("corrects an in_progress task's description", () => {
    const { db, task } = pendingTask(openDatabase(":memory:"));
    claimTask(db, task.id, "session-1");
    expect(requireTask(db, task.id).status).toBe("in_progress");

    amendTask(db, stubEstimator(0), task.id, {
      description: "Fails on macOS too - not Windows-specific after all",
      reason: "learned mid-task that this isn't platform-specific",
    });

    const updated = requireTask(db, task.id);
    expect(updated.status).toBe("in_progress"); // amending text doesn't touch status
    expect(updated.description).toBe("Fails on macOS too - not Windows-specific after all");
  });

  it("corrects a done task's title", () => {
    const { db, task } = pendingTask(openDatabase(":memory:"));
    claimTask(db, task.id, "session-1");
    completeTask(db, noopVerifier, { task_id: task.id, summary: "fixed" });
    expect(requireTask(db, task.id).status).toBe("done");

    amendTask(db, stubEstimator(0), task.id, {
      title: "The memory-limit suspension test was flaky on both Windows and macOS",
      reason: "correcting the record for whoever reads this card next",
    });

    const updated = requireTask(db, task.id);
    expect(updated.status).toBe("done"); // still done - a correction, not a reopen
    expect(updated.title).toBe("The memory-limit suspension test was flaky on both Windows and macOS");
  });

  it("replaces file_paths as a whole set and recomputes estimated_tokens", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const task = createTask(db, stubEstimator(500), {
      project_id: project.id,
      title: "GM-341",
      file_paths: ["src/db/releases.ts", "src/tools/releases.ts"],
      complexity_hint: "normal",
    }).task;

    const estimator: BudgetEstimator = { estimateTokens: () => 777 };
    const { task: amended, amendments } = amendTask(db, estimator, task.id, {
      file_paths: ["src/domain/releases.ts", "src/mcp/tools/releases.ts"],
      reason: "neither original path exists; these are the real files (GM-341)",
    });

    expect(listTaskFilePaths(db, task.id)).toEqual(["src/domain/releases.ts", "src/mcp/tools/releases.ts"]);
    expect(amended.estimated_tokens).toBe(777);
    expect(amendments).toEqual([
      expect.objectContaining({
        field: "file_paths",
        previous_value: JSON.stringify(["src/db/releases.ts", "src/tools/releases.ts"]),
      }),
    ]);
  });

  it("treats reordering the same file_paths as no change", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const task = createTask(db, stubEstimator(0), {
      project_id: project.id,
      title: "x",
      file_paths: ["src/a.ts", "src/b.ts"],
      complexity_hint: "normal",
    }).task;

    expect(() =>
      amendTask(db, stubEstimator(0), task.id, {
        file_paths: ["src/b.ts", "src/a.ts"],
        reason: "shouldn't matter, it's the same set",
      }),
    ).toThrow(/changed nothing/);
  });

  it("rejects a call where every given field already matches its current value", () => {
    const { db, task } = pendingTask(openDatabase(":memory:"));

    expect(() =>
      amendTask(db, stubEstimator(0), task.id, {
        title: task.title,
        reason: "no-op",
      }),
    ).toThrow(/amend_task .* changed nothing/);

    // No amendment row should have been written for the rejected call.
    expect(listTaskAmendments(db, task.id)).toEqual([]);
  });

  it("requires a non-blank reason", () => {
    const { db, task } = pendingTask(openDatabase(":memory:"));

    expect(() =>
      amendTask(db, stubEstimator(0), task.id, { title: "New title", reason: "   " }),
    ).toThrow(/amend_task requires a reason/);

    expect(requireTask(db, task.id).title).toBe(task.title);
  });

  it("rejects an unknown task_id", () => {
    const db = openDatabase(":memory:");
    expect(() => amendTask(db, stubEstimator(0), "missing", { title: "x", reason: "why" })).toThrow(
      /Unknown task_id: missing/,
    );
  });

  it("keeps the originally agreed text recoverable after the correction", () => {
    const { db, task } = pendingTask(openDatabase(":memory:"));
    const originalTitle = task.title;

    amendTask(db, stubEstimator(0), task.id, {
      title: "A different title entirely",
      reason: "first correction",
    });
    amendTask(db, stubEstimator(0), task.id, {
      title: "Yet another title",
      reason: "second correction",
    });

    const history = listTaskAmendments(db, task.id);
    expect(history.map((a) => a.previous_value)).toEqual([originalTitle, "A different title entirely"]);
    expect(requireTask(db, task.id).title).toBe("Yet another title");
  });

  it("changes a task's text without touching its release_id", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const release = createRelease(db, { project_id: project.id, version: "1.0.0" });
    const task = createTask(db, stubEstimator(0), {
      project_id: project.id,
      release_id: release.id,
      title: "In a release",
      complexity_hint: "normal",
    }).task;

    amendTask(db, stubEstimator(0), task.id, { title: "Renamed", reason: "typo" });

    expect(requireTask(db, task.id).release_id).toBe(release.id);
  });

  it("resolves a task by its code the same way other mutating calls do", () => {
    const { db, project, task } = pendingTask(openDatabase(":memory:"));
    const code = taskCode(project.code_prefix, task.task_number);

    amendTask(db, stubEstimator(0), code, { title: "Renamed via code", reason: "why not" });

    expect(requireTask(db, task.id).title).toBe("Renamed via code");
  });
});
