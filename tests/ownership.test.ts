import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { getNextTask } from "../src/domain/status.js";
import { cancelTask, claimTask, completeTask, releaseTask, TaskConflictError } from "../src/domain/lifecycle.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import type { CompletionVerifier } from "../src/domain/verification.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };
// A task with no declared file_paths and no test_command verifies trivially
// anyway; this only keeps the call honest about the argument it takes.
const noopVerifier: CompletionVerifier = { verify: () => ({ passed: true, reason: "noop" }) };

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
  /**
   * The shared invariant across every way out of in_progress, asserted
   * together rather than three times apart - because they had already drifted
   * apart once: cancelTask and releaseTask both cleared the lease and
   * completeTask, the path every SUCCESSFUL task takes, did not.
   *
   * The invariant is about the LEASE only, deliberately, and that is why these
   * cannot share one helper: complete keeps owner_session_id (which session
   * finished this is real provenance, and the board shows it), while cancel and
   * release clear it (there is no completion to attribute). What all three owe
   * is that nothing is left claiming it may be reclaimed.
   */
  function leaseOf(db: ReturnType<typeof openDatabase>, taskId: string) {
    return db
      .prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(taskId) as { status: string; owner_session_id: string | null; lock_expires_at: string | null };
  }

  it("leaves no live lease behind, whichever way a task leaves in_progress", () => {
    for (const [name, finish] of [
      ["complete", (db: ReturnType<typeof openDatabase>, id: string) =>
          completeTask(db, noopVerifier, { task_id: id })],
      [
        "cancel",
        // force, because cancelTask refuses a task whose lease is still live -
        // which is exactly the state this fixture is in, on purpose.
        (db: ReturnType<typeof openDatabase>, id: string) =>
          cancelTask(db, { task_id: id, force: true }),
      ],
      [
        "release",
        (db: ReturnType<typeof openDatabase>, id: string) => releaseTask(db, { task_id: id, session_id: "s1" }),
      ],
    ] as const) {
      const { db, task } = setup();
      claimTask(db, task.id, "s1");

      // Claimed for real, so there is an actual lease to leave behind - a
      // fixture that never claimed would pass this trivially with a NULL it
      // started with.
      expect(leaseOf(db, task.id).lock_expires_at, `${name}: precondition`).not.toBeNull();

      finish(db, task.id);

      expect(leaseOf(db, task.id).lock_expires_at, `${name} left a lease behind`).toBeNull();
      db.close();
    }
  });

  it("keeps who finished a task, and forgets who merely held a cancelled one", () => {
    const done = setup();
    claimTask(done.db, done.task.id, "session-that-finished-it");
    completeTask(done.db, noopVerifier, { task_id: done.task.id, summary: "shipped" });
    const finished = leaseOf(done.db, done.task.id);
    expect(finished).toMatchObject({
      status: "done",
      // Provenance, not a lock: the dashboard renders this on the card, and
      // "who finished it" stays true forever.
      owner_session_id: "session-that-finished-it",
      lock_expires_at: null,
    });
    done.db.close();

    const abandoned = setup();
    claimTask(abandoned.db, abandoned.task.id, "session-that-gave-up");
    cancelTask(abandoned.db, { task_id: abandoned.task.id, reason: "not needed", force: true });
    expect(leaseOf(abandoned.db, abandoned.task.id)).toMatchObject({
      status: "cancelled",
      owner_session_id: null,
      lock_expires_at: null,
    });
    abandoned.db.close();
  });
});
