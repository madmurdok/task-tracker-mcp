import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { getNextTask } from "../src/domain/status.js";
import { claimTask, releaseTask, TaskConflictError } from "../src/domain/lifecycle.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const { task } = createTask(db, noopEstimator, {
    project_id: project.id,
    title: "Solo task",
    complexity_hint: "normal",
  });
  return { db, project, task };
}

/**
 * End-to-end scenarios across get_next_task (status.ts) and claim/release
 * (lifecycle.ts) together - the granular per-function cases already live in
 * status.test.ts (A2) and lifecycle.test.ts (A3); this file exercises the
 * full multi-session stories those pieces are meant to support (A4).
 */
describe("ownership across sessions (A2 + A3 end to end)", () => {
  it("a crashed session's task is automatically reclaimed and can be re-claimed by a new session", () => {
    const { db, project, task } = setup();

    getNextTask(db, project.id);
    claimTask(db, task.id, "session-1");

    // session-1's process dies without completing or releasing - simulate by
    // expiring its lease directly, the same way a real timeout would.
    db.prepare(`UPDATE tasks SET lock_expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      task.id,
    );

    const reclaimed = getNextTask(db, project.id);
    expect(reclaimed.task?.id).toBe(task.id);
    expect(reclaimed.task?.owner_session_id).toBeNull();

    expect(() => claimTask(db, task.id, "session-2")).not.toThrow();
    const row = db.prepare(`SELECT owner_session_id FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ owner_session_id: "session-2" });
  });

  it("a live session blocks a concurrent claim until force-released, then a new session picks it up immediately", () => {
    const { db, project, task } = setup();

    getNextTask(db, project.id);
    claimTask(db, task.id, "session-1");

    expect(() => claimTask(db, task.id, "session-2")).toThrow(TaskConflictError);
    expect(() => releaseTask(db, { task_id: task.id, session_id: "session-2" })).toThrow(
      TaskConflictError,
    );

    releaseTask(db, { task_id: task.id, session_id: "session-2", force: true });

    const next = getNextTask(db, project.id);
    expect(next.task?.id).toBe(task.id);
    expect(next.task?.owner_session_id).toBeNull();

    expect(() => claimTask(db, task.id, "session-2")).not.toThrow();
  });
});
