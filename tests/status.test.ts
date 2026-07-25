import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import { getNextTask, getProjectStatus, listTasks } from "../src/domain/status.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const makeTask = (title: string) =>
    createTask(db, noopEstimator, { project_id: project.id, title }).task;
  return { db, project, makeTask };
}

describe("getNextTask", () => {
  it("returns the only unblocked task and flips it to in_progress", () => {
    const { db, project, makeTask } = setup();
    const a = makeTask("A");

    const result = getNextTask(db, project.id);

    expect(result.task?.id).toBe(a.id);
    expect(result.task?.status).toBe("in_progress");
  });

  it("never hands the same task out twice across sequential calls", () => {
    const { db, project, makeTask } = setup();
    makeTask("A");
    makeTask("B");

    const first = getNextTask(db, project.id);
    const second = getNextTask(db, project.id);

    expect(first.task).toBeTruthy();
    expect(second.task).toBeTruthy();
    expect(first.task?.id).not.toBe(second.task?.id);
  });

  it("skips a task whose dependency is unmet and reports all_blocked", () => {
    const { db, project, makeTask } = setup();
    const a = makeTask("A");
    const b = makeTask("B");
    addDependency(db, b.id, a.id); // B depends on A

    // Claim A first so it's no longer pending/eligible.
    getNextTask(db, project.id);

    const result = getNextTask(db, project.id);
    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("all_blocked");
      if (result.reason === "all_blocked") {
        expect(result.blocked_on).toEqual([b.id]);
      }
    }
  });

  it("reports all_done once every task is complete", () => {
    const { db, project } = setup();
    const result = getNextTask(db, project.id);
    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("all_done");
    }
  });
});

describe("listTasks / getProjectStatus", () => {
  it("derives blocked status for a pending task with an unmet dependency", () => {
    const { db, project, makeTask } = setup();
    const a = makeTask("A");
    const b = makeTask("B");
    addDependency(db, b.id, a.id);

    const summaries = listTasks(db, project.id);
    const bSummary = summaries.find((s) => s.id === b.id);
    expect(bSummary?.status).toBe("blocked");

    const status = getProjectStatus(db, project.id);
    expect(status).toEqual({ total: 2, done: 0, in_progress: 0, blocked: 1, pending: 1, percent: 0 });
  });

  it("filters list_tasks by status", () => {
    const { db, project, makeTask } = setup();
    makeTask("A");
    makeTask("B");

    const pendingOnly = listTasks(db, project.id, "pending");
    expect(pendingOnly).toHaveLength(2);

    const doneOnly = listTasks(db, project.id, "done");
    expect(doneOnly).toHaveLength(0);
  });
});
