import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const makeTask = (title: string) =>
    createTask(db, noopEstimator, { project_id: project.id, title, complexity_hint: "normal" }).task;
  return { db, makeTask };
}

describe("addDependency", () => {
  it("records a valid dependency edge", () => {
    const { db, makeTask } = setup();
    const a = makeTask("A");
    const b = makeTask("B");

    addDependency(db, a.id, b.id);

    const row = db
      .prepare("SELECT * FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
      .get(a.id, b.id);
    expect(row).toBeTruthy();
  });

  it("rejects a task depending on itself", () => {
    const { db, makeTask } = setup();
    const a = makeTask("A");

    expect(() => addDependency(db, a.id, a.id)).toThrow(/cannot depend on itself/);
  });

  it("rejects a dependency that would create a cycle", () => {
    const { db, makeTask } = setup();
    const a = makeTask("A");
    const b = makeTask("B");
    const c = makeTask("C");

    addDependency(db, a.id, b.id); // A depends on B
    addDependency(db, b.id, c.id); // B depends on C

    expect(() => addDependency(db, c.id, a.id)).toThrow(/would create a cycle/);
  });
});
