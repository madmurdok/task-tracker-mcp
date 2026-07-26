import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createEpic } from "../src/domain/epics.js";
import { createProject } from "../src/domain/projects.js";
import { createRelease } from "../src/domain/releases.js";
import { createTasks } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  return { db, project };
}

describe("createTasks", () => {
  it("creates every task and wires temp_id-to-temp_id dependencies", () => {
    const { db, project } = setup();

    const { tasks } = createTasks(db, noopEstimator, project.id, [
      { temp_id: "schema", title: "Build schema", complexity_hint: "normal" },
      {
        temp_id: "domain",
        title: "Build domain layer",
        complexity_hint: "normal",
        depends_on: ["schema"],
      },
    ]);

    expect(tasks).toHaveLength(2);
    const schemaTask = tasks.find((t) => t.temp_id === "schema");
    const domainTask = tasks.find((t) => t.temp_id === "domain");
    expect(schemaTask?.task_id).toBeTruthy();
    expect(domainTask?.task_id).toBeTruthy();

    const edge = db
      .prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
      .get(domainTask?.task_id, schemaTask?.task_id);
    expect(edge).toBeTruthy();
  });

  it("wires a depends_on entry that isn't a batch temp_id onto an existing task_id", () => {
    const { db, project } = setup();
    const { tasks: existing } = createTasks(db, noopEstimator, project.id, [
      { title: "Pre-existing prereq", complexity_hint: "normal" },
    ]);
    const existingTaskId = existing[0].task_id;

    const { tasks } = createTasks(db, noopEstimator, project.id, [
      { temp_id: "new", title: "New task", complexity_hint: "normal", depends_on: [existingTaskId] },
    ]);

    const edge = db
      .prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
      .get(tasks[0].task_id, existingTaskId);
    expect(edge).toBeTruthy();
  });

  it("rejects a duplicate temp_id within the same batch", () => {
    const { db, project } = setup();

    expect(() =>
      createTasks(db, noopEstimator, project.id, [
        { temp_id: "dup", title: "A", complexity_hint: "normal" },
        { temp_id: "dup", title: "B", complexity_hint: "normal" },
      ]),
    ).toThrow(/Duplicate temp_id in batch: dup/);
  });

  it("rolls back the entire batch when one spec references an unknown epic", () => {
    const { db, project } = setup();

    expect(() =>
      createTasks(db, noopEstimator, project.id, [
        { title: "Fine", complexity_hint: "normal" },
        { title: "Bad", complexity_hint: "normal", epic_id: "missing" },
      ]),
    ).toThrow(/Unknown epic: missing/);

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("rolls back the entire batch when a depends_on edge would create a cycle", () => {
    const { db, project } = setup();

    expect(() =>
      createTasks(db, noopEstimator, project.id, [
        { temp_id: "a", title: "A", complexity_hint: "normal", depends_on: ["b"] },
        { temp_id: "b", title: "B", complexity_hint: "normal", depends_on: ["a"] },
      ]),
    ).toThrow(/would create a cycle/);

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("carries epic_id/release_id/priority through to each created task", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth rework" });
    const release = createRelease(db, { project_id: project.id, version: "0.1" });

    const { tasks } = createTasks(db, noopEstimator, project.id, [
      {
        title: "x",
        complexity_hint: "high",
        epic_id: epic.id,
        release_id: release.id,
        priority: 7,
      },
    ]);

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(tasks[0].task_id);
    expect(row).toMatchObject({
      epic_id: epic.id,
      release_id: release.id,
      priority: 7,
      complexity_hint: "high",
    });
  });
});
