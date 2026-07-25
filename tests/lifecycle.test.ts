import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import { getNextTask } from "../src/domain/status.js";
import { claimTask, completeTask } from "../src/domain/lifecycle.js";
import { addHandoffNote } from "../src/domain/handoffNotes.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

describe("full task lifecycle (matches the doc's sequence diagram)", () => {
  it("create -> depend -> get_next -> claim -> handoff note -> complete -> dependent unblocked", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const { task: taskA } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
    });
    const { task: taskB } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build domain layer",
    });
    addDependency(db, taskB.id, taskA.id); // B depends on A

    const next = getNextTask(db, project.id);
    expect(next.task?.id).toBe(taskA.id);

    claimTask(db, taskA.id, "session-1");
    const claimed = db.prepare("SELECT owner_session_id FROM tasks WHERE id = ?").get(taskA.id);
    expect(claimed).toMatchObject({ owner_session_id: "session-1" });

    addHandoffNote(db, {
      task_id: taskA.id,
      session_id: "session-1",
      decisions: "used better-sqlite3",
      remaining_work: "none",
      discoveries: "schema was simpler than expected",
    });
    const notes = db.prepare("SELECT * FROM handoff_notes WHERE task_id = ?").all(taskA.id);
    expect(notes).toHaveLength(1);

    const { unblocked_task_ids } = completeTask(db, taskA.id);
    expect(unblocked_task_ids).toEqual([taskB.id]);

    const secondSessionNext = getNextTask(db, project.id);
    expect(secondSessionNext.task?.id).toBe(taskB.id);
  });

  it("claim_task rejects an unknown task", () => {
    const db = openDatabase(":memory:");
    expect(() => claimTask(db, "missing", "session-1")).toThrow(/Unknown task_id/);
  });

  it("claim_task renews the lock lease", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, { project_id: project.id, title: "Build schema" });
    getNextTask(db, project.id); // hand out, sets an initial lease

    db.prepare(`UPDATE tasks SET lock_expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() + 1000).toISOString(),
      task.id,
    );

    claimTask(db, task.id, "session-1");

    const row = db.prepare(`SELECT lock_expires_at FROM tasks WHERE id = ?`).get(task.id) as {
      lock_expires_at: string;
    };
    expect(new Date(row.lock_expires_at).getTime()).toBeGreaterThan(Date.now() + 5000);
  });

  it("complete_task rejects an unknown task", () => {
    const db = openDatabase(":memory:");
    expect(() => completeTask(db, "missing")).toThrow(/Unknown task_id/);
  });
});
