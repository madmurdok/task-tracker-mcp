import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import { approvePlan, upsertPlan } from "../src/domain/plans.js";
import { createRelease } from "../src/domain/releases.js";
import { setTaskSlices } from "../src/domain/slices.js";
import { getNextTask, getProjectStatus, getTaskDetail, listTasks } from "../src/domain/status.js";
import { addHandoffNote } from "../src/domain/handoffNotes.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import type { Task } from "../src/domain/tasks.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const makeTask = (title: string) =>
    createTask(db, noopEstimator, { project_id: project.id, title, complexity_hint: "normal" }).task;
  return { db, project, makeTask };
}

/** A project with one release batch, and a task-maker that files tasks into it. */
function setupBatch() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const release = createRelease(db, { project_id: project.id, version: "0.1" });
  const makeTask = (title: string, priority?: number) =>
    createTask(db, noopEstimator, {
      project_id: project.id,
      release_id: release.id,
      title,
      complexity_hint: "normal",
      priority,
    }).task;
  // Backlog task: in the project, outside the batch. Present so a scoped pick
  // can be shown to ignore work it should not see.
  const makeBacklogTask = (title: string, priority?: number) =>
    createTask(db, noopEstimator, { project_id: project.id, title, complexity_hint: "normal", priority })
      .task;
  return { db, project, release, makeTask, makeBacklogTask };
}

/**
 * The *stored* status, so a test can show a task was left alone rather than
 * trusting that the call which refused to hand it out also refrained from
 * writing to it.
 */
function storedTask(db: DatabaseInstance, taskId: string): { status: string; owner_session_id: string | null } {
  return db.prepare(`SELECT status, owner_session_id FROM tasks WHERE id = ?`).get(taskId) as {
    status: string;
    owner_session_id: string | null;
  };
}

/**
 * Task state written directly, matching plans.test.ts's markReleased helper and
 * for the same reason: these put a task into a given state so the *pick* rules
 * can be tested, and shouldn't also depend on completeTask's verifier or on
 * which writes do or do not revert a plan's approval.
 */
function markStatus(db: DatabaseInstance, taskId: string, status: string): void {
  db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, taskId);
}

function moveToRelease(db: DatabaseInstance, taskId: string, releaseId: string | null): void {
  db.prepare(`UPDATE tasks SET release_id = ? WHERE id = ?`).run(releaseId, taskId);
}

// approvePlan (TTM-87) now refuses while any open batch task has no slices.
// None of this file's fixtures were built with slicing in mind - they exist
// to exercise getNextTask's own picking rules - so this gives each task the
// smallest valid slicing purely to clear that gate, the same helper plans.test.ts
// uses for the same reason.
function sliceAll(db: DatabaseInstance, ...tasks: Task[]): void {
  for (const task of tasks) {
    setTaskSlices(db, task.id, [{ phase: "implement", title: "do it" }]);
  }
}

function expireLease(db: DatabaseInstance, taskId: string): void {
  db.prepare(`UPDATE tasks SET lock_expires_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    taskId,
  );
}

/**
 * A batch whose plan order and priority order disagree *by construction*: the
 * plan's first step holds the lowest-priority task in the batch and its last
 * step holds the highest. Without that, a plan-ordered pick and a
 * priority-ordered pick would return the same task and a passing test would
 * prove nothing about which order was followed.
 *
 * A function rather than shared state because each arm of that comparison hands
 * a task out, which writes to the database.
 */
function planContradictingPriority() {
  const { db, project, release, makeTask } = setupBatch();
  const low = makeTask("first in the plan, lowest priority", 1);
  const high = makeTask("last in the plan, highest priority", 99);
  upsertPlan(db, project.id, release.version, {
    steps: [low.id, high.id],
    rationale: "the low-priority task unblocks the high-priority one",
  });
  sliceAll(db, low, high);
  approvePlan(db, project.id, release.version, { approved_by: "owner" });
  return { db, project, release, low, high };
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

  it("prefers a higher-priority task over an older, lower-priority one", () => {
    const { db, project } = setup();
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Low priority, created first",
      complexity_hint: "normal",
    });
    const { task: highPriority } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "High priority, created second",
      complexity_hint: "normal",
      priority: 10,
    });

    const result = getNextTask(db, project.id);

    expect(result.task?.id).toBe(highPriority.id);
  });

  it("falls back to creation order when priorities are equal (the default)", () => {
    const { db, project, makeTask } = setup();
    const a = makeTask("A");
    makeTask("B");

    const result = getNextTask(db, project.id);

    expect(result.task?.id).toBe(a.id);
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

describe("getNextTask scoped to a release batch with an approved plan", () => {
  it("follows the plan's order even where priority disagrees, which an unscoped call does not", () => {
    const planned = planContradictingPriority();

    const scoped = getNextTask(planned.db, planned.project.id, planned.release.version);

    expect(scoped.task?.id).toBe(planned.low.id);
    expect(scoped.plan_status).toBe("approved");

    // The control arm, on an identical fixture: unscoped, the same two tasks
    // come out in the *other* order. Without this the assertion above could
    // pass on a build that ignores plans entirely.
    const control = planContradictingPriority();
    const unscoped = getNextTask(control.db, control.project.id);

    expect(unscoped.task?.id).toBe(control.high.id);
    // An unscoped answer describes no single batch, so it reports no plan state.
    expect("plan_status" in unscoped).toBe(false);
  });

  it("walks the plan step by step across consecutive calls", () => {
    const { db, project, release, low, high } = planContradictingPriority();

    expect(getNextTask(db, project.id, release.version).task?.id).toBe(low.id);
    expect(getNextTask(db, project.id, release.version).task?.id).toBe(high.id);
  });

  it("accepts the batch by version or by id", () => {
    const byVersion = planContradictingPriority();
    expect(getNextTask(byVersion.db, byVersion.project.id, byVersion.release.version).task?.id).toBe(
      byVersion.low.id,
    );

    const byId = planContradictingPriority();
    expect(getNextTask(byId.db, byId.project.id, byId.release.id).task?.id).toBe(byId.low.id);
  });

  it("rejects an unknown release ref", () => {
    const { db, project } = setupBatch();
    expect(() => getNextTask(db, project.id, "9.9")).toThrow(/Unknown release: 9\.9/);
  });

  it("skips a done and a cancelled plan item and hands out the next one", () => {
    const { db, project, release, makeTask } = setupBatch();
    const first = makeTask("first");
    const second = makeTask("second");
    const third = makeTask("third");
    upsertPlan(db, project.id, release.version, { steps: [first.id, second.id, third.id] });
    sliceAll(db, first, second, third);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    // The two rows are built to the exact shape each lifecycle path leaves
    // behind, because that is what makes this test able to fail at all.
    // complete_task's UPDATE (lifecycle.ts) names neither owner_session_id nor
    // lock_expires_at, so a finished task still carries the lease it was handed
    // out under - and once that lease lapses, the done/cancelled skip is the
    // only thing between the plan and handing a completed task straight back
    // out. cancel_task does clear the lease, so that arm is the NULL-lease
    // shape; between them the two cover both.
    expect(getNextTask(db, project.id, release.version).task?.id).toBe(first.id);
    markStatus(db, first.id, "done");
    expireLease(db, first.id);
    markStatus(db, second.id, "cancelled");

    const result = getNextTask(db, project.id, release.version);

    expect(result.task?.id).toBe(third.id);
    // Neither of the two was touched on the way past.
    expect(storedTask(db, first.id).status).toBe("done");
    expect(storedTask(db, second.id).status).toBe("cancelled");
  });

  it("skips a plan item with an unmet dependency rather than handing it out", () => {
    const { db, project, release, makeTask } = setupBatch();
    const blocked = makeTask("needs the other one first");
    const prerequisite = makeTask("the prerequisite");
    addDependency(db, blocked.id, prerequisite.id);
    // The plan puts the blocked task first on purpose: the dependency gate has
    // to override the plan's own order, not just priority's.
    upsertPlan(db, project.id, release.version, { steps: [blocked.id, prerequisite.id] });
    sliceAll(db, blocked, prerequisite);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    const result = getNextTask(db, project.id, release.version);

    expect(result.task?.id).toBe(prerequisite.id);
    expect(storedTask(db, blocked.id).status).toBe("pending");
  });

  it("skips a plan item held under a live lease and reclaims one whose lease has lapsed", () => {
    const { db, project, release, makeTask } = setupBatch();
    const first = makeTask("first");
    const second = makeTask("second");
    upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });
    sliceAll(db, first, second);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    expect(getNextTask(db, project.id, release.version).task?.id).toBe(first.id);
    // first is in_progress under a live lease, so the plan moves past it.
    expect(getNextTask(db, project.id, release.version).task?.id).toBe(second.id);

    db.prepare(`UPDATE tasks SET owner_session_id = ? WHERE id = ?`).run("dead-session", first.id);
    expireLease(db, first.id);

    // Back to step 1: a dead session's abandoned task is still step 1's work,
    // and reclaiming clears the owner exactly as the unscoped reclaim does.
    const reclaimed = getNextTask(db, project.id, release.version);
    expect(reclaimed.task?.id).toBe(first.id);
    expect(reclaimed.task?.owner_session_id).toBeNull();
  });

  describe("a parallel step (TTM-98)", () => {
    /** An approved plan whose steps are `titles`, each group one (parallel) step. */
    function planWithSteps(titles: string[][]) {
      const { db, project, release, makeTask } = setupBatch();
      const tasks = titles.map((group) => group.map((title) => makeTask(title)));
      upsertPlan(db, project.id, release.version, { steps: tasks.map((group) => group.map((t) => t.id)) });
      sliceAll(db, ...tasks.flat());
      approvePlan(db, project.id, release.version, { approved_by: "owner" });
      const next = () => getNextTask(db, project.id, release.version);
      return { db, tasks, next };
    }

    it("hands out each task of the step once: A, then B, never A again", () => {
      const { db, tasks, next } = planWithSteps([["A", "B"]]);
      const [a, b] = tasks[0]!;

      expect(next().task?.id).toBe(a!.id);
      expect(next().task?.id).toBe(b!.id);
      expect(storedTask(db, a!.id).status).toBe("in_progress");
      expect(storedTask(db, b!.id).status).toBe("in_progress");
    });

    it("hands out B before reclaiming A when A's lease lapsed between the calls", () => {
      // The g-mesh 3.20.0 failure: an orchestrator outran A's lease, and the
      // second call handed A out again while B was never claimed.
      const { db, tasks, next } = planWithSteps([["A", "B"]]);
      const [a, b] = tasks[0]!;

      expect(next().task?.id).toBe(a!.id);
      db.prepare(`UPDATE tasks SET owner_session_id = ? WHERE id = ?`).run("orchestrator", a!.id);
      expireLease(db, a!.id);

      const second = next();
      expect(second.task?.id).toBe(b!.id);
      // A was left as it was on the way past: still the orchestrator's.
      expect(storedTask(db, a!.id)).toEqual({ status: "in_progress", owner_session_id: "orchestrator" });

      // Only once the step has no unclaimed task left is the lapsed one reclaimed,
      // owner cleared exactly as any reclaim does.
      const third = next();
      expect(third.task?.id).toBe(a!.id);
      expect(third.task?.owner_session_id).toBeNull();
      expect(storedTask(db, a!.id).owner_session_id).toBeNull();
    });

    it("reclaims a step's lapsed tasks in plan position order, not oldest lease first", () => {
      const { db, tasks, next } = planWithSteps([["A", "B", "C"]]);
      const [a, b, c] = tasks[0]!;
      expect([next().task?.id, next().task?.id, next().task?.id]).toEqual([a!.id, b!.id, c!.id]);

      // C's lease lapsed long before B's, so an oldest-lease-first reclaim
      // (pickByPriority's order) would take C; position order takes B.
      const setLease = db.prepare(`UPDATE tasks SET lock_expires_at = ? WHERE id = ?`);
      setLease.run(new Date(Date.now() - 1000).toISOString(), b!.id);
      setLease.run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), c!.id);

      expect(next().task?.id).toBe(b!.id);
      expect(next().task?.id).toBe(c!.id);
    });

    it("never re-hands out a task under a live lease, even when its whole step is held", () => {
      const { db, tasks, next } = planWithSteps([["A", "B"], ["C"]]);
      const [a, b] = tasks[0]!;
      const [c] = tasks[1]!;

      expect(next().task?.id).toBe(a!.id);
      expect(next().task?.id).toBe(b!.id);
      // Step 1 is wholly held: it yields nothing and the walk moves to step 2.
      expect(next().task?.id).toBe(c!.id);

      // Nothing left anywhere: the exhausted answer, naming no held task as blocked.
      const exhausted = next();
      expect(exhausted.task).toBeNull();
      if (exhausted.task === null) {
        expect(exhausted.reason).toBe("all_blocked");
        if (exhausted.reason === "all_blocked") {
          expect(exhausted.blocked_on).toEqual([]);
        }
      }
      for (const t of [a!, b!, c!]) {
        expect(storedTask(db, t.id).status).toBe("in_progress");
      }
    });

    it("with a held step and a blocked later task, all_blocked lists only the blocked task", () => {
      const { db, tasks, next } = planWithSteps([["A", "B"], ["C"]]);
      const [a, b] = tasks[0]!;
      const [c] = tasks[1]!;
      // C waits on A, which is held - so C stays pending and blocked.
      addDependency(db, c!.id, a!.id);

      expect(next().task?.id).toBe(a!.id);
      expect(next().task?.id).toBe(b!.id);

      const exhausted = next();
      expect(exhausted.task).toBeNull();
      if (exhausted.task === null) {
        expect(exhausted.reason).toBe("all_blocked");
        if (exhausted.reason === "all_blocked") {
          expect(exhausted.blocked_on).toEqual([c!.id]);
        }
      }
      expect(storedTask(db, c!.id).status).toBe("pending");
    });

    it("reports all_done once every task of the step is finished", () => {
      const { db, tasks, next } = planWithSteps([["A", "B"]]);
      next();
      next();
      for (const t of tasks[0]!) markStatus(db, t.id, "done");

      const result = next();
      expect(result.task).toBeNull();
      if (result.task === null) {
        expect(result.reason).toBe("all_done");
      }
    });
  });

  it("reports all_blocked over the batch alone, ignoring unblocked work outside it", () => {
    const { db, project, release, makeTask, makeBacklogTask } = setupBatch();
    const prerequisite = makeBacklogTask("prerequisite, outside the batch");
    const blocked = makeTask("the batch's only task");
    addDependency(db, blocked.id, prerequisite.id);
    upsertPlan(db, project.id, release.version, { steps: [blocked.id] });
    sliceAll(db, blocked);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    const result = getNextTask(db, project.id, release.version);

    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("all_blocked");
      if (result.reason === "all_blocked") {
        expect(result.blocked_on).toEqual([blocked.id]);
      }
    }
    // The prerequisite is pending and unblocked, and an unscoped call would
    // have handed it out - being outside the batch is the only reason it wasn't.
    expect(storedTask(db, prerequisite.id).status).toBe("pending");
  });

  it("reports all_done once the batch is finished, whatever is left elsewhere", () => {
    const { db, project, release, makeTask, makeBacklogTask } = setupBatch();
    makeBacklogTask("still pending, outside the batch");
    const only = makeTask("the batch's only task");
    upsertPlan(db, project.id, release.version, { steps: [only.id] });
    sliceAll(db, only);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });
    markStatus(db, only.id, "done");

    const result = getNextTask(db, project.id, release.version);

    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("all_done");
    }
  });
});

describe("getNextTask refusing a batch whose plan is not approved", () => {
  it("refuses a draft plan without touching the tasks it orders", () => {
    const { db, project, release, makeTask } = setupBatch();
    const first = makeTask("first");
    upsertPlan(db, project.id, release.version, { steps: [first.id] });

    const result = getNextTask(db, project.id, release.version);

    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("plan_not_approved");
    }
    expect(result.plan_status).toBe("draft");
    expect(storedTask(db, first.id)).toEqual({ status: "pending", owner_session_id: null });
  });

  it("refuses an approved plan that no longer covers the batch, naming the drift", () => {
    const { db, project, release, makeTask, makeBacklogTask } = setupBatch();
    const planned = makeTask("in the plan");
    upsertPlan(db, project.id, release.version, { steps: [planned.id] });
    sliceAll(db, planned);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    // Moved in with a direct write, not setTaskRelease: what this test needs is
    // the state "approved plan, batch has since grown", stated outright rather
    // than produced as a side effect of whichever writes revert an approval.
    const latecomer = makeBacklogTask("added to the batch after approval");
    moveToRelease(db, latecomer.id, release.id);

    const result = getNextTask(db, project.id, release.version);

    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("plan_not_approved");
      if (result.reason === "plan_not_approved") {
        expect(result.drift?.unplanned_task_ids).toEqual([latecomer.id]);
        expect(result.drift?.orphaned_task_ids).toEqual([]);
      }
    }
    expect(result.plan_status).toBe("drifted");
    expect(storedTask(db, planned.id).status).toBe("pending");
  });

  it("refuses an approved plan holding an item that left the batch", () => {
    const { db, project, release, makeTask } = setupBatch();
    const staying = makeTask("staying");
    const leaving = makeTask("leaving");
    upsertPlan(db, project.id, release.version, { steps: [staying.id, leaving.id] });
    sliceAll(db, staying, leaving);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });

    moveToRelease(db, leaving.id, null);

    const result = getNextTask(db, project.id, release.version);

    expect(result.task).toBeNull();
    if (result.task === null) {
      expect(result.reason).toBe("plan_not_approved");
      if (result.reason === "plan_not_approved") {
        expect(result.drift?.orphaned_task_ids).toEqual([leaving.id]);
      }
    }
    expect(result.plan_status).toBe("drifted");
  });
});

describe("getNextTask scoped to a batch with no plan", () => {
  it("falls back to priority order within the batch and says no plan exists", () => {
    const { db, project, release, makeTask, makeBacklogTask } = setupBatch();
    makeBacklogTask("highest priority of all, but outside the batch", 999);
    makeTask("low priority, in the batch", 1);
    const high = makeTask("high priority, in the batch", 99);

    const result = getNextTask(db, project.id, release.version);

    expect(result.task?.id).toBe(high.id);
    expect(result.plan_status).toBe("none");
  });

  it("reclaims a stale lock within the batch, as the unscoped path does", () => {
    const { db, project, release, makeTask } = setupBatch();
    const only = makeTask("the batch's only task");

    getNextTask(db, project.id, release.version);
    db.prepare(`UPDATE tasks SET owner_session_id = ? WHERE id = ?`).run("stale-session", only.id);
    expireLease(db, only.id);

    const reclaimed = getNextTask(db, project.id, release.version);

    expect(reclaimed.task?.id).toBe(only.id);
    expect(reclaimed.task?.owner_session_id).toBeNull();
    expect(reclaimed.plan_status).toBe("none");
  });
});

describe("getNextTask's plan_pending on an unscoped call", () => {
  it("names a batch whose plan is still a draft, while still handing work out", () => {
    const { db, project, release, makeTask } = setupBatch();
    const first = makeTask("first");
    upsertPlan(db, project.id, release.version, { steps: [first.id] });

    const result = getNextTask(db, project.id);

    // Still handed out: an unscoped call is allowed to bypass a plan, it just
    // may not do so silently.
    expect(result.task?.id).toBe(first.id);
    expect(result.plan_pending).toEqual([
      { release_id: release.id, version: "0.1", plan_status: "draft" },
    ]);
  });

  it("names a batch whose approved plan has drifted", () => {
    const { db, project, release, makeTask, makeBacklogTask } = setupBatch();
    const planned = makeTask("in the plan");
    upsertPlan(db, project.id, release.version, { steps: [planned.id] });
    sliceAll(db, planned);
    approvePlan(db, project.id, release.version, { approved_by: "owner" });
    const latecomer = makeBacklogTask("added after approval");
    moveToRelease(db, latecomer.id, release.id);

    const result = getNextTask(db, project.id);

    expect(result.plan_pending).toEqual([
      { release_id: release.id, version: "0.1", plan_status: "drifted" },
    ]);
  });

  it("is absent, not empty, when there is nothing to report", () => {
    // No plan anywhere: the answer must be exactly what it always was.
    const plain = setup();
    plain.makeTask("A");
    expect("plan_pending" in getNextTask(plain.db, plain.project.id)).toBe(false);

    // An approved, undrifted plan is not pending - there is no bypass to warn
    // about, so the key stays absent rather than arriving as [].
    const approved = planContradictingPriority();
    expect("plan_pending" in getNextTask(approved.db, approved.project.id)).toBe(false);
  });

  it("stays quiet about a batch there is no longer any work to bypass", () => {
    const { db, project, release, makeTask } = setupBatch();
    const only = makeTask("the batch's only task");
    upsertPlan(db, project.id, release.version, { steps: [only.id] });
    markStatus(db, only.id, "done");

    // A draft plan over a finished batch is a warning nobody can act on, and it
    // would otherwise be repeated on every get_next_task call for ever.
    expect("plan_pending" in getNextTask(db, project.id)).toBe(false);
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
    expect(status).toEqual({
      total: 2,
      done: 0,
      in_progress: 0,
      blocked: 1,
      pending: 1,
      cancelled: 0,
      percent: 0,
      doc_drift: false,
    });
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

describe("getTaskDetail", () => {
  it("returns the task's file_paths and handoff_notes alongside its own fields", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build the thing",
      file_paths: ["src/a.ts"],
      complexity_hint: "normal",
    });
    addHandoffNote(db, {
      task_id: task.id,
      session_id: "session-1",
      decisions: "used better-sqlite3",
    });

    const detail = getTaskDetail(db, task.id);

    expect(detail).toMatchObject({
      id: task.id,
      title: "Build the thing",
      file_paths: ["src/a.ts"],
    });
    expect(detail.handoff_notes).toMatchObject([
      { task_id: task.id, session_id: "session-1", decisions: "used better-sqlite3" },
    ]);
  });

  it("returns empty arrays for a task with no files or handoff notes", () => {
    const { db, makeTask } = setup();
    const task = makeTask("Solo");

    const detail = getTaskDetail(db, task.id);

    expect(detail.file_paths).toEqual([]);
    expect(detail.handoff_notes).toEqual([]);
  });

  it("throws for an unknown task_id", () => {
    const db = openDatabase(":memory:");
    expect(() => getTaskDetail(db, "missing")).toThrow(/Unknown task_id: missing/);
  });
});
