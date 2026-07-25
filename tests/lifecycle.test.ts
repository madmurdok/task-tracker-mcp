import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import { getNextTask } from "../src/domain/status.js";
import {
  claimTask,
  completeTask,
  CompletionVerificationError,
  releaseTask,
  TaskConflictError,
} from "../src/domain/lifecycle.js";
import { addHandoffNote } from "../src/domain/handoffNotes.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import type { CompletionVerifier } from "../src/domain/verification.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };
const noopVerifier: CompletionVerifier = { verify: () => ({ passed: true, reason: "noop" }) };

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

    const { unblocked_task_ids } = completeTask(db, noopVerifier, { task_id: taskA.id });
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
    expect(() => completeTask(db, noopVerifier, { task_id: "missing" })).toThrow(/Unknown task_id/);
  });
});

describe("ownership conflicts (A3)", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, { project_id: project.id, title: "Build schema" });
    getNextTask(db, project.id); // hand out, owner still null
    claimTask(db, task.id, "session-1"); // session-1 now holds an active lock
    return { db, project, task };
  }

  it("claim_task rejects a different session while the lock is active", () => {
    const { db, task } = setup();

    expect(() => claimTask(db, task.id, "session-2")).toThrow(TaskConflictError);
    const row = db.prepare(`SELECT owner_session_id FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ owner_session_id: "session-1" });
  });

  it("claim_task allows the current owner to renew their own lock", () => {
    const { db, task } = setup();
    expect(() => claimTask(db, task.id, "session-1")).not.toThrow();
  });

  it("release_task rejects a different session without force", () => {
    const { db, task } = setup();

    expect(() => releaseTask(db, { task_id: task.id, session_id: "session-2" })).toThrow(
      TaskConflictError,
    );
    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "in_progress" });
  });

  it("release_task with force overrides another session's active lock", () => {
    const { db, task } = setup();

    releaseTask(db, { task_id: task.id, session_id: "session-2", force: true });
    const row = db.prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`).get(
      task.id,
    );
    expect(row).toMatchObject({ status: "pending", owner_session_id: null, lock_expires_at: null });
  });

  it("release_task by the owner puts the task straight back to pending, reclaimable immediately", () => {
    const { db, project, task } = setup();

    releaseTask(db, { task_id: task.id, session_id: "session-1" });

    const row = db.prepare(`SELECT status, owner_session_id FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "pending", owner_session_id: null });

    const next = getNextTask(db, project.id);
    expect(next.task?.id).toBe(task.id);
  });

  it("release_task rejects an unknown task", () => {
    const db = openDatabase(":memory:");
    expect(() => releaseTask(db, { task_id: "missing", session_id: "session-1" })).toThrow(
      /Unknown task_id/,
    );
  });

  it("release_task rejects a task that is already done", () => {
    const { db, task } = setup();
    completeTask(db, noopVerifier, { task_id: task.id });

    expect(() => releaseTask(db, { task_id: task.id, session_id: "session-1" })).toThrow(
      /already done/,
    );
  });
});

describe("completion verification (B2)", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      file_paths: ["src/db/schema.ts"],
    });
    return { db, project, task };
  }

  it("rejects completion when the verifier fails", () => {
    const { db, task } = setup();
    const failingVerifier: CompletionVerifier = {
      verify: () => ({ passed: false, reason: "no changes detected" }),
    };

    expect(() => completeTask(db, failingVerifier, { task_id: task.id })).toThrow(
      CompletionVerificationError,
    );
    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "pending" });
  });

  it("force skips verification entirely", () => {
    const { db, task } = setup();
    const failingVerifier: CompletionVerifier = {
      verify: () => ({ passed: false, reason: "no changes detected" }),
    };

    expect(() => completeTask(db, failingVerifier, { task_id: task.id, force: true })).not.toThrow();
    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "done" });
  });

  it("passes the task's root_path, file_paths, and test_command through to the verifier", () => {
    const { db, project, task } = setup();
    let received: unknown;
    const spyVerifier: CompletionVerifier = {
      verify: (input) => {
        received = input;
        return { passed: true, reason: "ok" };
      },
    };

    completeTask(db, spyVerifier, { task_id: task.id, test_command: "npm test" });

    expect(received).toEqual({
      rootPath: project.root_path,
      filePaths: ["src/db/schema.ts"],
      testCommand: "npm test",
    });
  });

  it("succeeds when the verifier passes", () => {
    const { db, task } = setup();
    expect(() => completeTask(db, noopVerifier, { task_id: task.id })).not.toThrow();
  });
});
