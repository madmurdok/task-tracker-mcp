import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { getBoardData } from "../src/domain/board.js";
import { approvePlan, upsertPlan } from "../src/domain/plans.js";
import { createProject } from "../src/domain/projects.js";
import { createRelease } from "../src/domain/releases.js";
import { completeSlice, setTaskSlices, startSlice } from "../src/domain/slices.js";
import { LOCK_LEASE_MS } from "../src/domain/taskStatus.js";
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

/**
 * TTM-78: the lease against the clock. Time is moved with vi.setSystemTime
 * and the lease is only ever written by the real writers (claim_task and the
 * slice heartbeats), so the lease arithmetic under test is the one that runs -
 * no test here writes lock_expires_at.
 */
describe("a lease against the clock (TTM-78)", () => {
  const T0 = Date.parse("2026-10-04T09:00:00.000Z");
  const MINUTE = 60 * 1000;
  const at = (offsetMs: number) => vi.setSystemTime(T0 + offsetMs);
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  beforeEach(() => {
    // Date only: better-sqlite3 is synchronous, nothing here waits on a timer.
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function holder(db: ReturnType<typeof openDatabase>, taskId: string) {
    return db.prepare(`SELECT status, owner_session_id FROM tasks WHERE id = ?`).get(taskId) as {
      status: string;
      owner_session_id: string | null;
    };
  }

  function boardCard(db: ReturnType<typeof openDatabase>, projectId: string, taskId: string) {
    const card = getBoardData(db, projectId)
      .lanes.flatMap((lane) => lane.tasks)
      .find((t) => t.id === taskId);
    if (!card) throw new Error(`task ${taskId} not on the board`);
    return card;
  }

  /**
   * The acceptance demo: a task held well past the old 30-minute lease, and
   * past what claim_task's own lease would cover, kept alive only by its slice
   * writes. `next` is the hand-out under test (unscoped, or one release batch
   * under an approved plan); the task is its pool's only one, so a pending
   * task can never mask a reclaim.
   */
  function outliveTheLease(
    db: ReturnType<typeof openDatabase>,
    projectId: string,
    taskId: string,
    next: () => ReturnType<typeof getNextTask>,
  ) {
    claimTask(db, taskId, "session-1");
    startSlice(db, `${taskId}/S1`);

    // Past the old 30-minute lease: a slice is still running.
    at(31 * MINUTE);
    expect(boardCard(db, projectId, taskId).is_stale).toBe(false);
    expect(next().task).toBeNull();
    completeSlice(db, `${taskId}/S1`, { status: "done", result: "slice 1" });
    startSlice(db, `${taskId}/S2`);

    // Just under a whole lease after the last slice write - and 30 minutes
    // past the lease claim_task granted at T0, so only the renewal holds it.
    at(31 * MINUTE + LOCK_LEASE_MS - MINUTE);
    expect(T0 + 31 * MINUTE + LOCK_LEASE_MS - MINUTE).toBeGreaterThan(T0 + LOCK_LEASE_MS);
    const card = boardCard(db, projectId, taskId);
    expect(card.is_stale).toBe(false);
    expect(card.stale_since).toBeNull();
    expect(next().task).toBeNull();
    expect(holder(db, taskId)).toEqual({ status: "in_progress", owner_session_id: "session-1" });

    // The same task, silent for a whole lease, is stale and reclaimed - so the
    // two checks above are not passing because staleness never fires.
    at(31 * MINUTE + LOCK_LEASE_MS + MINUTE);
    expect(boardCard(db, projectId, taskId).is_stale).toBe(true);
    const reclaimed = next();
    expect(reclaimed.task?.id).toBe(taskId);
    expect(reclaimed).toMatchObject({ reclaimed_from: { owner_session_id: "session-1" } });
  }

  it("keeps a task whose slices outlast the old lease held, unscoped", () => {
    const { db, project, task } = setup();
    setTaskSlices(db, task.id, [
      { phase: "implement", title: "slice 1" },
      { phase: "verify", title: "slice 2" },
    ]);

    outliveTheLease(db, project.id, task.id, () => getNextTask(db, project.id));
  });

  it("keeps a task whose slices outlast the old lease held, walking an approved plan", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const release = createRelease(db, { project_id: project.id, version: "0.1" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title: "Long task",
      complexity_hint: "normal",
    });
    upsertPlan(db, project.id, release.version, { steps: [task.id] });
    setTaskSlices(db, task.id, [
      { phase: "implement", title: "slice 1" },
      { phase: "verify", title: "slice 2" },
    ]);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    outliveTheLease(db, project.id, task.id, () => {
      const result = getNextTask(db, project.id, release.version);
      // Still the plan walker answering, not a refusal that also returns null.
      expect(result.plan_status).toBe("approved");
      return result;
    });
  });

  it("hands a genuinely dead session's task to a new session once the lease lapses, and not before", () => {
    const { db, project, task } = setup();
    getNextTask(db, project.id);
    claimTask(db, task.id, "session-1");
    // session-1 dies here: no slice write, no release, nothing after the claim.

    // A worker that never heartbeats is held for the whole lease, no less
    // than the 30 minutes it used to get.
    at(LOCK_LEASE_MS - MINUTE);
    expect(() => claimTask(db, task.id, "session-2")).toThrow(TaskConflictError);
    expect(boardCard(db, project.id, task.id).is_stale).toBe(false);
    expect(holder(db, task.id).owner_session_id).toBe("session-1");

    at(LOCK_LEASE_MS + MINUTE);
    expect(boardCard(db, project.id, task.id)).toMatchObject({ is_stale: true, stale_since: iso(0) });
    expect(() => claimTask(db, task.id, "session-2")).not.toThrow();
    expect(
      db.prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`).get(task.id),
    ).toEqual({
      status: "in_progress",
      owner_session_id: "session-2",
      lock_expires_at: iso(2 * LOCK_LEASE_MS + MINUTE),
    });
  });
});
