import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createEpic } from "../src/domain/epics.js";
import { createProject } from "../src/domain/projects.js";
import { createTask, splitTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const makeTask = (title: string) =>
    createTask(db, noopEstimator, { project_id: project.id, title }).task;
  return { db, project, makeTask };
}

describe("splitTask", () => {
  it("removes the original task and rewires dependents/prerequisites onto the subtasks", () => {
    const { db, project, makeTask } = setup();
    const prereq = makeTask("Prereq");
    const original = makeTask("Too big");
    const dependent = makeTask("Depends on original");

    addDependency(db, original.id, prereq.id); // original depends on prereq
    addDependency(db, dependent.id, original.id); // dependent depends on original

    const { new_task_ids } = splitTask(db, noopEstimator, original.id, [
      { title: "Part 1" },
      { title: "Part 2" },
    ]);

    expect(new_task_ids).toHaveLength(2);

    const originalRow = db.prepare("SELECT * FROM tasks WHERE id = ?").get(original.id);
    expect(originalRow).toBeUndefined();

    for (const subtaskId of new_task_ids) {
      const dependsOnPrereq = db
        .prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
        .get(subtaskId, prereq.id);
      expect(dependsOnPrereq).toBeTruthy();

      const dependentDependsOnIt = db
        .prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
        .get(dependent.id, subtaskId);
      expect(dependentDependsOnIt).toBeTruthy();
    }

    const remainingEdgesForOriginal = db
      .prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?")
      .all(original.id, original.id);
    expect(remainingEdgesForOriginal).toHaveLength(0);

    void project;
  });

  it("keeps subtasks under the original task's epic", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });
    const original = createTask(db, noopEstimator, {
      project_id: project.id,
      epic_id: epic.id,
      title: "Too big",
    }).task;

    const { new_task_ids } = splitTask(db, noopEstimator, original.id, [
      { title: "Part 1" },
      { title: "Part 2" },
    ]);

    for (const subtaskId of new_task_ids) {
      const row = db.prepare("SELECT epic_id FROM tasks WHERE id = ?").get(subtaskId);
      expect(row).toMatchObject({ epic_id: epic.id });
    }
  });

  it("rejects an unknown task_id", () => {
    const { db } = setup();
    expect(() => splitTask(db, noopEstimator, "missing", [{ title: "x" }])).toThrow(
      /Unknown task_id/,
    );
  });

  it("rejects an empty subtask list", () => {
    const { db, makeTask } = setup();
    const original = makeTask("Too big");
    expect(() => splitTask(db, noopEstimator, original.id, [])).toThrow(/at least one subtask/);
  });
});
