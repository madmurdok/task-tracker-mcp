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

  it("does not reclaim an in_progress task before its lock expires", () => {
    const { db, project, makeTask } = setup();
    makeTask("A");

    getNextTask(db, project.id); // hand out A, lock ~30min out

    const second = getNextTask(db, project.id);
    expect(second.task).toBeNull();
    if (second.task === null) {
      expect(second.reason).toBe("all_blocked");
    }
  });

  it("reclaims an in_progress task once its lock has expired, clearing the old owner", () => {
    const { db, project, makeTask } = setup();
    const a = makeTask("A");

    getNextTask(db, project.id);
    db.prepare(`UPDATE tasks SET owner_session_id = ?, lock_expires_at = ? WHERE id = ?`).run(
      "stale-session",
      new Date(Date.now() - 1000).toISOString(),
      a.id,
    );

    const reclaimed = getNextTask(db, project.id);
    expect(reclaimed.task?.id).toBe(a.id);
    expect(reclaimed.task?.status).toBe("in_progress");
    expect(reclaimed.task?.owner_session_id).toBeNull();

    const row = db
      .prepare(`SELECT lock_expires_at FROM tasks WHERE id = ?`)
      .get(a.id) as { lock_expires_at: string };
    expect(new Date(row.lock_expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("project ref resolution (id or name)", () => {
  it("getNextTask, listTasks, and getProjectStatus all accept a project name", () => {
    const { db, project, makeTask } = setup();
    makeTask("A");

    expect(getNextTask(db, project.name).task?.title).toBe("A");
    expect(listTasks(db, project.name)).toHaveLength(1);
    expect(getProjectStatus(db, project.name).total).toBe(1);
  });

  it("getNextTask, listTasks, and getProjectStatus all reject an unknown project ref", () => {
    const { db } = setup();

    expect(() => getNextTask(db, "missing")).toThrow(/Unknown project: missing/);
    expect(() => listTasks(db, "missing")).toThrow(/Unknown project: missing/);
    expect(() => getProjectStatus(db, "missing")).toThrow(/Unknown project: missing/);
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
