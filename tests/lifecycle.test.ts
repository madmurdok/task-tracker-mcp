import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createRelease } from "../src/domain/releases.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import { getNextTask } from "../src/domain/status.js";
import {
  cancelRelease,
  cancelTask,
  claimTask,
  completeTask,
  CompletionVerificationError,
  releaseIt,
  ReleaseNotAllDoneError,
  releaseTask,
  TaskBlockedError,
  TaskConflictError,
  TaskNotClaimableError,
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
      complexity_hint: "normal",
    });
    const { task: taskB } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build domain layer",
      complexity_hint: "normal",
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
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });
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

describe("claim_task as direct take-into-work (no prior get_next_task)", () => {
  it("moves a fresh, unblocked pending task straight to in_progress", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });

    claimTask(db, task.id, "session-1");

    const row = db.prepare(`SELECT status, owner_session_id FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "in_progress", owner_session_id: "session-1" });
  });

  it("rejects claiming a pending task with unmet dependencies", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task: taskA } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });
    const { task: taskB } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build domain layer",
      complexity_hint: "normal",
    });
    addDependency(db, taskB.id, taskA.id); // B depends on A

    expect(() => claimTask(db, taskB.id, "session-1")).toThrow(TaskBlockedError);
    const row = db.prepare(`SELECT status, owner_session_id FROM tasks WHERE id = ?`).get(taskB.id);
    expect(row).toMatchObject({ status: "pending", owner_session_id: null });
  });

  it("rejects claiming an already-done task", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });
    completeTask(db, noopVerifier, { task_id: task.id });

    expect(() => claimTask(db, task.id, "session-1")).toThrow(TaskNotClaimableError);
  });

  it("rejects claiming a cancelled task", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });
    cancelTask(db, { task_id: task.id });

    expect(() => claimTask(db, task.id, "session-1")).toThrow(TaskNotClaimableError);
  });
});

describe("ownership conflicts (A3)", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });
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
      complexity_hint: "normal",
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

  it("passes the task's root_path, file_paths, created_at, and test_command to the verifier", () => {
    const { db, project, task } = setup();
    const { created_at: createdAt } = db
      .prepare(`SELECT created_at FROM tasks WHERE id = ?`)
      .get(task.id) as { created_at: string };
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
      // The bound on which commits count as this task's work - created_at,
      // the one task timestamp that never moves forward.
      changesSinceIso: createdAt,
    });
  });

  it("succeeds when the verifier passes", () => {
    const { db, task } = setup();
    expect(() => completeTask(db, noopVerifier, { task_id: task.id })).not.toThrow();
  });

  it("persists the summary argument as completion_summary", () => {
    const { db, task } = setup();
    completeTask(db, noopVerifier, { task_id: task.id, summary: "wired up the schema" });

    const row = db.prepare(`SELECT completion_summary FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ completion_summary: "wired up the schema" });
  });

  it("leaves completion_summary null when no summary is given", () => {
    const { db, task } = setup();
    completeTask(db, noopVerifier, { task_id: task.id });

    const row = db.prepare(`SELECT completion_summary FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ completion_summary: null });
  });
});

describe("cancelTask", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task: prereq } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Prereq",
      complexity_hint: "normal",
    });
    const { task: dependent } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Dependent",
      complexity_hint: "normal",
    });
    addDependency(db, dependent.id, prereq.id);
    return { db, project, prereq, dependent };
  }

  it("cancels a pending task, storing the reason, clearing ownership, and unblocking dependents", () => {
    const { db, prereq, dependent } = setup();

    const result = cancelTask(db, { task_id: prereq.id, reason: "duplicate of another task" });

    const row = db
      .prepare(`SELECT status, cancellation_reason, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(prereq.id);
    expect(row).toMatchObject({
      status: "cancelled",
      cancellation_reason: "duplicate of another task",
      owner_session_id: null,
      lock_expires_at: null,
    });
    expect(result.unblocked_task_ids).toEqual([dependent.id]);
  });

  it("rejects an already-done task", () => {
    const { db, prereq } = setup();
    completeTask(db, noopVerifier, { task_id: prereq.id });

    expect(() => cancelTask(db, { task_id: prereq.id })).toThrow(/already done/);
  });

  it("rejects an already-cancelled task", () => {
    const { db, prereq } = setup();
    cancelTask(db, { task_id: prereq.id });

    expect(() => cancelTask(db, { task_id: prereq.id })).toThrow(/already cancelled/);
  });

  it("rejects an unknown task_id", () => {
    const { db } = setup();
    expect(() => cancelTask(db, { task_id: "missing" })).toThrow(/Unknown task_id/);
  });

  it("rejects while another session's lock is active, unless force", () => {
    const { db, project, prereq } = setup();
    getNextTask(db, project.id);
    claimTask(db, prereq.id, "session-1");

    expect(() => cancelTask(db, { task_id: prereq.id })).toThrow(TaskConflictError);
    expect(() => cancelTask(db, { task_id: prereq.id, force: true })).not.toThrow();
  });
});

describe("releaseIt", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    return { db, project, release };
  }

  it("rejects if any task in the release isn't done or cancelled, even with force", () => {
    const { db, project, release } = setup();
    createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Still pending",
      complexity_hint: "normal",
    });

    expect(() =>
      releaseIt(db, noopVerifier, { project_id: project.id, release_id: release.id, force: true }),
    ).toThrow(ReleaseNotAllDoneError);
  });

  it("requires test_command unless force is given", () => {
    const { db, project, release } = setup();

    expect(() => releaseIt(db, noopVerifier, { project_id: project.id, release_id: release.id })).toThrow(
      CompletionVerificationError,
    );
    expect(() =>
      releaseIt(db, noopVerifier, { project_id: project.id, release_id: release.id, force: true }),
    ).not.toThrow();
  });

  it("surfaces a failing test_command as CompletionVerificationError", () => {
    const { db, project, release } = setup();
    const failingVerifier: CompletionVerifier = {
      verify: () => ({ passed: false, reason: "tests failed" }),
    };

    expect(() =>
      releaseIt(db, failingVerifier, {
        project_id: project.id,
        release_id: release.id,
        test_command: "npm test",
      }),
    ).toThrow(CompletionVerificationError);
  });

  it("passes an empty filePaths (skips the git-diff check) and the given test_command to the verifier", () => {
    const { db, project, release } = setup();
    let received: unknown;
    const spyVerifier: CompletionVerifier = {
      verify: (input) => {
        received = input;
        return { passed: true, reason: "ok" };
      },
    };

    releaseIt(db, spyVerifier, {
      project_id: project.id,
      release_id: release.id,
      test_command: "npm test",
    });

    expect(received).toEqual({ rootPath: project.root_path, filePaths: [], testCommand: "npm test" });
  });

  it("rejects an already-released release", () => {
    const { db, project, release } = setup();
    releaseIt(db, noopVerifier, { project_id: project.id, release_id: release.id, force: true });

    expect(() =>
      releaseIt(db, noopVerifier, { project_id: project.id, release_id: release.id, force: true }),
    ).toThrow(/already released/);
  });

  it("rejects a cancelled release - the other terminal status is just as one-shot", () => {
    const { db, project, release } = setup();
    cancelRelease(db, {
      project_id: project.id,
      release_id: release.id,
      reason: "bench gate said don't ship it",
    });

    expect(() =>
      releaseIt(db, noopVerifier, { project_id: project.id, release_id: release.id, force: true }),
    ).toThrow(/already cancelled/);
  });

  it("generates release notes from done tasks plus a Cancelled section, and marks the release released", () => {
    const { db, project, release } = setup();
    const { task: shipped } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Add login form",
      complexity_hint: "normal",
    });
    const { task: dropped } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Add SSO (descoped)",
      complexity_hint: "normal",
    });
    completeTask(db, noopVerifier, { task_id: shipped.id, summary: "wired up the login form" });
    cancelTask(db, { task_id: dropped.id, reason: "descoped for this release" });

    const result = releaseIt(db, noopVerifier, {
      project_id: project.id,
      release_id: release.id,
      force: true,
    });

    expect(result.release_notes).toBe(
      "- Add login form: wired up the login form\n\nCancelled:\n- Add SSO (descoped): descoped for this release",
    );
    expect(result.released_at).toBeTruthy();

    const row = db.prepare(`SELECT status, release_notes, released_at FROM releases WHERE id = ?`).get(
      release.id,
    );
    expect(row).toMatchObject({
      status: "released",
      release_notes: result.release_notes,
      released_at: result.released_at,
    });
  });

  it("omits the summary/reason suffix when a task has none", () => {
    const { db, project, release } = setup();
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "No summary given",
      complexity_hint: "normal",
    });
    completeTask(db, noopVerifier, { task_id: task.id });

    const result = releaseIt(db, noopVerifier, {
      project_id: project.id,
      release_id: release.id,
      force: true,
    });

    expect(result.release_notes).toBe("- No summary given");
  });
});
