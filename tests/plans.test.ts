import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import { addDependency } from "../src/domain/dependencies.js";
import { cancelTask, claimTask, completeTask } from "../src/domain/lifecycle.js";
import {
  approvePlan,
  getPlan,
  isPlanDrifted,
  revertPlanToDraft,
  upsertPlan,
} from "../src/domain/plans.js";
import { createProject } from "../src/domain/projects.js";
import { createRelease, setTaskRelease } from "../src/domain/releases.js";
import { createTask, createTasks, type Task } from "../src/domain/tasks.js";
import type { CompletionVerifier } from "../src/domain/verification.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };
const noopVerifier: CompletionVerifier = { verify: () => ({ passed: true, reason: "noop" }) };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const release = createRelease(db, { project_id: project.id, version: "0.1" });
  return { db, project, release };
}

function addTask(
  db: DatabaseInstance,
  projectId: string,
  title: string,
  releaseId?: string,
): Task {
  return createTask(db, noopEstimator, {
    project_id: projectId,
    release_id: releaseId,
    title,
    complexity_hint: "normal",
  }).task;
}

// Status set directly rather than through releaseIt/cancelRelease, matching
// releases.test.ts's helpers: these put a release into a given state so the
// *plan* rules can be tested, and shouldn't also depend on the lifecycle
// functions' own gates passing.
function markReleased(db: DatabaseInstance, releaseId: string): void {
  db.prepare(`UPDATE releases SET status = 'released' WHERE id = ?`).run(releaseId);
}

function markCancelled(db: DatabaseInstance, releaseId: string): void {
  db.prepare(`UPDATE releases SET status = 'cancelled', cancellation_reason = 'gate said no' WHERE id = ?`).run(
    releaseId,
  );
}

// Moves a task's release_id straight in the table, bypassing setTaskRelease -
// which, as of TTM-68, drops the task's plan item and reverts the plan itself
// the moment membership changes, so it can no longer be used to *create* an
// orphaned-item state to test planDrift's own detection of one. This helper
// is what's left to reach that state: the data drifted out from under a plan
// by some means other than setTaskRelease/createTask (e.g. hand-written SQL,
// or a plan item surviving from before this hook existed) - exactly the case
// planDrift's orphaned-item computation exists to still catch.
function moveTaskReleaseDirectly(db: DatabaseInstance, taskId: string, releaseId: string | null): void {
  db.prepare(`UPDATE tasks SET release_id = ? WHERE id = ?`).run(releaseId, taskId);
}

describe("upsertPlan", () => {
  it("writes a plan and reads it back in step then position order", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    const third = addTask(db, project.id, "third", release.id);

    upsertPlan(db, project.id, release.version, {
      // Third and second share a step, and `third` is listed first inside it,
      // so a result ordered by insertion or by task_number would differ from
      // one ordered by (step, position).
      steps: [[third.id, second.id], first.id],
      rationale: "schema before the tools that read it",
    });

    const plan = getPlan(db, project.id, release.version)!;

    expect(plan.status).toBe("draft");
    expect(plan.rationale).toBe("schema before the tools that read it");
    expect(plan.approved_by).toBeNull();
    expect(plan.approval_note).toBeNull();
    expect(plan.approved_at).toBeNull();
    expect(plan.items.map((item) => [item.step, item.position, item.title])).toEqual([
      [1, 1, "third"],
      [1, 2, "second"],
      [2, 1, "first"],
    ]);
    expect(plan.items.map((item) => item.code)).toEqual(["DEM-3", "DEM-2", "DEM-1"]);
    expect(plan.unplanned_task_ids).toEqual([]);
    expect(plan.orphaned_task_ids).toEqual([]);

    const rows = db
      .prepare(`SELECT task_id, step, position FROM release_plan_items WHERE plan_id = ? ORDER BY step, position`)
      .all(plan.id);
    expect(rows).toEqual([
      { task_id: third.id, step: 1, position: 1 },
      { task_id: second.id, step: 1, position: 2 },
      { task_id: first.id, step: 2, position: 1 },
    ]);
  });

  it("gives each ref in a flat list its own step", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);

    const plan = upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });

    expect(plan.items.map((item) => [item.step, item.position])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("carries a per-item note through to the read model", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);

    const plan = upsertPlan(db, project.id, release.version, {
      steps: [{ task: task.id, note: "the tables land first" }],
    });

    expect(plan.items[0].note).toBe("the tables land first");
  });

  it("accepts readable task codes as well as uuids", () => {
    const { db, project, release } = setup();
    const byCode = addTask(db, project.id, "by code", release.id);
    const byUuid = addTask(db, project.id, "by uuid", release.id);

    const plan = upsertPlan(db, project.id, release.version, { steps: ["DEM-1", byUuid.id] });

    expect(plan.items.map((item) => item.task_id)).toEqual([byCode.id, byUuid.id]);
  });

  it("rejects a task that belongs to another release", () => {
    const { db, project, release } = setup();
    const other = createRelease(db, { project_id: project.id, version: "0.2" });
    const mine = addTask(db, project.id, "mine", release.id);
    const theirs = addTask(db, project.id, "theirs", other.id);

    expect(() =>
      upsertPlan(db, project.id, release.version, { steps: [mine.id, theirs.id] }),
    ).toThrow(/is not in release 0\.1/);

    // Rejected, not partially written: the valid ref before it must not have
    // landed either.
    expect(getPlan(db, project.id, release.version)).toBeUndefined();
  });

  it("rejects a backlog task with no release at all", () => {
    const { db, project, release } = setup();
    const backlog = addTask(db, project.id, "backlog");

    expect(() => upsertPlan(db, project.id, release.version, { steps: [backlog.id] })).toThrow(
      /is not in release 0\.1/,
    );
  });

  it("rejects an unknown task ref", () => {
    const { db, project, release } = setup();

    expect(() => upsertPlan(db, project.id, release.version, { steps: ["DEM-404"] })).toThrow(
      /Unknown task_id: DEM-404/,
    );
  });

  it("rejects the same task twice, whether written as a code or a uuid", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);

    expect(() =>
      upsertPlan(db, project.id, release.version, { steps: [task.id, "DEM-1"] }),
    ).toThrow(/appears more than once in the plan/);
  });

  it("rejects a plan with no steps, and a step with no tasks", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);

    expect(() => upsertPlan(db, project.id, release.version, { steps: [] })).toThrow(
      /requires at least one step/,
    );
    expect(() => upsertPlan(db, project.id, release.version, { steps: [[], [task.id]] })).toThrow(
      /Plan step 1 has no tasks/,
    );
  });

  it("refuses a released release", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    markReleased(db, release.id);

    expect(() => upsertPlan(db, project.id, release.version, { steps: [task.id] })).toThrow(
      /already released; cannot write a plan for it/,
    );
  });

  it("refuses a cancelled release", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    markCancelled(db, release.id);

    expect(() => upsertPlan(db, project.id, release.version, { steps: [task.id] })).toThrow(
      /is cancelled; cannot write a plan for it/,
    );
  });

  it("replaces the items of an existing plan rather than appending to them", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);

    const created = upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });
    const replaced = upsertPlan(db, project.id, release.version, { steps: [[second.id, first.id]] });

    expect(replaced.id).toBe(created.id);
    expect(replaced.items.map((item) => [item.task_id, item.step, item.position])).toEqual([
      [second.id, 1, 1],
      [first.id, 1, 2],
    ]);

    const count = db
      .prepare(`SELECT COUNT(*) AS cnt FROM release_plan_items WHERE plan_id = ?`)
      .get(created.id) as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("resets an approved plan to draft and clears the whole approval record", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id, second.id], rationale: "why" });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    const approved = getPlan(db, project.id, release.version)!;
    expect(approved.status).toBe("approved");

    upsertPlan(db, project.id, release.version, { steps: [second.id, first.id] });

    // Read back from the table, not from upsertPlan's return value: the point
    // is that the stored record was cleared, not that the returned object was
    // built without those fields.
    const row = db.prepare(`SELECT * FROM release_plans WHERE release_id = ?`).get(release.id);
    expect(row).toMatchObject({
      status: "draft",
      approved_by: null,
      approval_note: null,
      approved_at: null,
      // A new order is a new plan, so last order's justification goes with it.
      rationale: "",
    });
  });

  it("keeps a surviving item's added_at and stamps only the newly added one", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);

    const created = upsertPlan(db, project.id, release.version, { steps: [first.id] });
    const originalAddedAt = created.items[0].added_at;

    // A second apart so a re-stamped timestamp is distinguishable from a
    // carried one even at whole-second resolution.
    db.prepare(`UPDATE release_plan_items SET added_at = ? WHERE plan_id = ? AND task_id = ?`).run(
      "2020-01-01T00:00:00.000Z",
      created.id,
      first.id,
    );

    const replaced = upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });

    const carried = replaced.items.find((item) => item.task_id === first.id)!;
    const fresh = replaced.items.find((item) => item.task_id === second.id)!;
    expect(carried.added_at).toBe("2020-01-01T00:00:00.000Z");
    expect(fresh.added_at).not.toBe("2020-01-01T00:00:00.000Z");
    expect(Date.parse(fresh.added_at)).toBeGreaterThan(Date.parse(originalAddedAt) - 1);
  });
});

describe("getPlan", () => {
  it("returns undefined for a release with no plan", () => {
    const { db, project, release } = setup();

    expect(getPlan(db, project.id, release.version)).toBeUndefined();
  });

  it("still reads the plan of a released release, unlike writing one", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });
    markReleased(db, release.id);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.items.map((item) => item.task_id)).toEqual([task.id]);
  });

  it("reads each item's status live from the task, without the plan being touched", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    const plan = upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });

    expect(plan.items.map((item) => item.status)).toEqual(["pending", "pending"]);

    const before = db.prepare(`SELECT * FROM release_plans WHERE id = ?`).get(plan.id);
    completeTask(db, noopVerifier, { task_id: first.id, summary: "done" });
    const after = db.prepare(`SELECT * FROM release_plans WHERE id = ?`).get(plan.id);

    expect(getPlan(db, project.id, release.version)!.items.map((item) => item.status)).toEqual([
      "done",
      "pending",
    ]);
    // Nothing about the plan itself moved - the new status came from the task.
    expect(after).toEqual(before);
  });

  it("reports an item as blocked when its dependency is unmet, same as displayStatus", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    addDependency(db, second.id, first.id);

    const plan = upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });

    expect(plan.items.map((item) => item.status)).toEqual(["pending", "blocked"]);
  });
});

describe("plan drift", () => {
  it("reports a batch task missing from the plan as unplanned", () => {
    const { db, project, release } = setup();
    const planned = addTask(db, project.id, "planned", release.id);
    // Both created before the plan exists - TTM-68's inbound hook only fires
    // when a release already has a plan, so creating `late` here (rather
    // than after upsertPlan) leaves it genuinely unplanned instead of
    // auto-appended, which is the scenario this test is about.
    const late = addTask(db, project.id, "late", release.id);
    upsertPlan(db, project.id, release.version, { steps: [planned.id] });

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.unplanned_task_ids).toEqual([late.id]);
    expect(plan.orphaned_task_ids).toEqual([]);
    expect(isPlanDrifted(db, plan)).toBe(true);
  });

  it("reports a plan item moved to another release as orphaned", () => {
    const { db, project, release } = setup();
    const other = createRelease(db, { project_id: project.id, version: "0.2" });
    const stays = addTask(db, project.id, "stays", release.id);
    const leaves = addTask(db, project.id, "leaves", release.id);
    upsertPlan(db, project.id, release.version, { steps: [stays.id, leaves.id] });

    // Not setTaskRelease - as of TTM-68 that call drops the item itself and
    // reverts the plan (see the "plan revert hooks" describe block below);
    // this test is about planDrift's own detection of an item whose task
    // left the batch by some other means, so the move is made directly.
    moveTaskReleaseDirectly(db, leaves.id, other.id);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.orphaned_task_ids).toEqual([leaves.id]);
    expect(plan.unplanned_task_ids).toEqual([]);
    // Still listed as an item - hiding it would hide the drift it causes.
    expect(plan.items.map((item) => item.task_id)).toEqual([stays.id, leaves.id]);
    expect(isPlanDrifted(db, plan)).toBe(true);
  });

  it("reports a plan item moved to the backlog as orphaned, release_id being NULL", () => {
    const { db, project, release } = setup();
    const stays = addTask(db, project.id, "stays", release.id);
    const leaves = addTask(db, project.id, "leaves", release.id);
    upsertPlan(db, project.id, release.version, { steps: [stays.id, leaves.id] });

    // See the note in the previous test - setTaskRelease itself now cleans
    // this state up (TTM-68), so it's created directly here instead.
    moveTaskReleaseDirectly(db, leaves.id, null);

    expect(getPlan(db, project.id, release.version)!.orphaned_task_ids).toEqual([leaves.id]);
  });

  it("does not count a done or cancelled batch task as unplanned", () => {
    const { db, project, release } = setup();
    const planned = addTask(db, project.id, "planned", release.id);
    const finished = addTask(db, project.id, "finished", release.id);
    const abandoned = addTask(db, project.id, "abandoned", release.id);
    upsertPlan(db, project.id, release.version, { steps: [planned.id] });

    expect(getPlan(db, project.id, release.version)!.unplanned_task_ids).toEqual([
      finished.id,
      abandoned.id,
    ]);

    completeTask(db, noopVerifier, { task_id: finished.id });
    cancelTask(db, { task_id: abandoned.id, reason: "not needed" });

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.unplanned_task_ids).toEqual([]);
    expect(isPlanDrifted(db, plan)).toBe(false);
  });

  it("is not drifted when the plan covers exactly the batch", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);

    const plan = upsertPlan(db, project.id, release.version, { steps: [[first.id, second.id]] });

    expect(isPlanDrifted(db, plan)).toBe(false);
  });
});

describe("approvePlan", () => {
  it("moves a draft plan to approved and stamps who, when, and their words", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });

    const approved = approvePlan(db, project.id, release.version, {
      approved_by: "valentin",
      note: "ship it",
    });

    expect(approved.status).toBe("approved");
    expect(approved.approved_at).toBeTruthy();

    const row = db.prepare(`SELECT * FROM release_plans WHERE release_id = ?`).get(release.id) as {
      status: string;
      approved_by: string;
      approval_note: string;
      approved_at: string;
    };
    expect(row.status).toBe("approved");
    expect(row.approved_by).toBe("valentin");
    expect(row.approval_note).toBe("ship it");
    expect(row.approved_at).toBe(approved.approved_at);
  });

  it("stores the approval note verbatim, whitespace and newlines included", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });
    const note = "  ок, но TTM-70 держим последним\n\n- и не мержим в main\n";

    approvePlan(db, project.id, release.version, { approved_by: "valentin", note });

    const row = db
      .prepare(`SELECT approval_note FROM release_plans WHERE release_id = ?`)
      .get(release.id) as { approval_note: string };
    expect(row.approval_note).toBe(note);
  });

  it("refuses a plan that leaves a batch task unplanned, naming it by code", () => {
    const { db, project, release } = setup();
    const planned = addTask(db, project.id, "planned", release.id);
    // Created before the plan exists - see the same note in the "plan drift"
    // describe block; TTM-68's inbound hook would otherwise auto-append this
    // task the moment it's created into an already-planned release.
    addTask(db, project.id, "late", release.id);
    upsertPlan(db, project.id, release.version, { steps: [planned.id] });

    expect(() =>
      approvePlan(db, project.id, release.version, { approved_by: "valentin" }),
    ).toThrow(/does not match the batch.*not in the plan: DEM-2/s);

    const row = db
      .prepare(`SELECT status, approved_at FROM release_plans WHERE release_id = ?`)
      .get(release.id);
    expect(row).toMatchObject({ status: "draft", approved_at: null });
  });

  it("refuses a plan holding an item that left the batch, naming it by code", () => {
    const { db, project, release } = setup();
    const stays = addTask(db, project.id, "stays", release.id);
    const leaves = addTask(db, project.id, "leaves", release.id);
    upsertPlan(db, project.id, release.version, { steps: [stays.id, leaves.id] });
    // See the note above `moveTaskReleaseDirectly`'s other uses - setTaskRelease
    // would itself clean up the orphaned item this test needs to still exist.
    moveTaskReleaseDirectly(db, leaves.id, null);

    expect(() =>
      approvePlan(db, project.id, release.version, { approved_by: "valentin" }),
    ).toThrow(/in the plan but no longer in the batch: DEM-2/);
  });

  it("refuses an already-approved plan instead of re-stamping it", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });
    const first = approvePlan(db, project.id, release.version, {
      approved_by: "valentin",
      note: "first",
    });

    expect(() =>
      approvePlan(db, project.id, release.version, { approved_by: "someone else", note: "second" }),
    ).toThrow(/already approved by valentin/);

    const row = db.prepare(`SELECT * FROM release_plans WHERE release_id = ?`).get(release.id);
    expect(row).toMatchObject({
      approved_by: "valentin",
      approval_note: "first",
      approved_at: first.approved_at,
    });
  });

  it("refuses an approval attributed to nobody", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });

    expect(() => approvePlan(db, project.id, release.version, { approved_by: "   " })).toThrow(
      /requires approved_by/,
    );
  });

  it("refuses when there is no plan to approve", () => {
    const { db, project, release } = setup();

    expect(() =>
      approvePlan(db, project.id, release.version, { approved_by: "valentin" }),
    ).toThrow(/No plan for release 0\.1/);
  });

  it("refuses a released and a cancelled release", () => {
    const { db, project, release } = setup();
    const other = createRelease(db, { project_id: project.id, version: "0.2" });
    const mine = addTask(db, project.id, "mine", release.id);
    const theirs = addTask(db, project.id, "theirs", other.id);
    upsertPlan(db, project.id, release.version, { steps: [mine.id] });
    upsertPlan(db, project.id, other.version, { steps: [theirs.id] });

    markReleased(db, release.id);
    markCancelled(db, other.id);

    expect(() =>
      approvePlan(db, project.id, release.version, { approved_by: "valentin" }),
    ).toThrow(/already released; cannot approve its plan/);
    expect(() => approvePlan(db, project.id, other.version, { approved_by: "valentin" })).toThrow(
      /is cancelled; cannot approve its plan/,
    );
  });

  it("stores a missing note as null rather than an empty string", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });

    approvePlan(db, project.id, release.version, { approved_by: "valentin" });

    const row = db
      .prepare(`SELECT approval_note FROM release_plans WHERE release_id = ?`)
      .get(release.id);
    expect(row).toEqual({ approval_note: null });
  });
});

describe("revertPlanToDraft", () => {
  it("withdraws the approval and keeps every item", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    upsertPlan(db, project.id, release.version, {
      steps: [[first.id, second.id]],
      rationale: "one step, both in parallel",
    });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    expect(revertPlanToDraft(db, release.id)).toBe(true);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    expect(plan.approved_by).toBeNull();
    expect(plan.approval_note).toBeNull();
    expect(plan.approved_at).toBeNull();
    // Items and rationale survive: the proposed order is still the best guess,
    // it just no longer carries a sign-off.
    expect(plan.rationale).toBe("one step, both in parallel");
    expect(plan.items.map((item) => [item.task_id, item.step, item.position])).toEqual([
      [first.id, 1, 1],
      [second.id, 1, 2],
    ]);
  });

  it("reports false for a plan that was already a draft, and for no plan at all", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);

    expect(revertPlanToDraft(db, release.id)).toBe(false);

    upsertPlan(db, project.id, release.version, { steps: [task.id] });
    expect(revertPlanToDraft(db, release.id)).toBe(false);
  });

  it("lets the plan be approved again afterwards", () => {
    const { db, project, release } = setup();
    const task = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [task.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });
    revertPlanToDraft(db, release.id);

    const reapproved = approvePlan(db, project.id, release.version, {
      approved_by: "valentin",
      note: "still fine",
    });
    expect(reapproved.status).toBe("approved");
    expect(reapproved.approval_note).toBe("still fine");
  });
});

describe("plan revert hooks (TTM-68)", () => {
  it("createTask into a release with an approved plan appends it as a final step and reverts to draft", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    const late = addTask(db, project.id, "late", release.id);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    expect(plan.approved_by).toBeNull();
    expect(plan.approval_note).toBeNull();
    expect(plan.approved_at).toBeNull();
    expect(plan.items.map((item) => [item.task_id, item.step, item.position])).toEqual([
      [first.id, 1, 1],
      [late.id, 2, 0],
    ]);
    expect(plan.unplanned_task_ids).toEqual([]);
  });

  it("setTaskRelease moving a task into a release with an approved plan appends it and reverts to draft", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    const backlog = addTask(db, project.id, "backlog");
    setTaskRelease(db, backlog.id, release.version);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    expect(plan.items.map((item) => [item.task_id, item.step, item.position])).toEqual([
      [first.id, 1, 1],
      [backlog.id, 2, 0],
    ]);
  });

  it("setTaskRelease moving a task out of a release with an approved plan drops its item and reverts to draft", () => {
    const { db, project, release } = setup();
    const stays = addTask(db, project.id, "stays", release.id);
    const leaves = addTask(db, project.id, "leaves", release.id);
    const other = createRelease(db, { project_id: project.id, version: "0.2" });
    upsertPlan(db, project.id, release.version, { steps: [stays.id, leaves.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    setTaskRelease(db, leaves.id, other.version);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    expect(plan.items.map((item) => item.task_id)).toEqual([stays.id]);
    // Dropped outright, not left behind to be reported as orphaned - it left
    // the batch by the one call that's supposed to keep the plan honest.
    expect(plan.orphaned_task_ids).toEqual([]);
  });

  it("setTaskRelease clearing a task's release to null drops its item and reverts the source plan", () => {
    const { db, project, release } = setup();
    const stays = addTask(db, project.id, "stays", release.id);
    const leaves = addTask(db, project.id, "leaves", release.id);
    upsertPlan(db, project.id, release.version, { steps: [stays.id, leaves.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    setTaskRelease(db, leaves.id, null);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    expect(plan.items.map((item) => item.task_id)).toEqual([stays.id]);
  });

  it("createTasks lands a whole batch into a planned release and reverts the plan once", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    const result = createTasks(db, noopEstimator, project.id, [
      { title: "second", release_id: release.id, complexity_hint: "normal" },
      { title: "third", release_id: release.id, complexity_hint: "normal" },
      { title: "fourth", release_id: release.id, complexity_hint: "normal" },
    ]);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    expect(plan.approved_by).toBeNull();
    expect(plan.items.map((item) => item.task_id)).toEqual([
      first.id,
      ...result.tasks.map((t) => t.task_id),
    ]);
    // Each of the three lands its own step, in creation order - not all
    // fighting over the same "next" step number.
    expect(plan.items.map((item) => item.step)).toEqual([1, 2, 3, 4]);
  });

  it("createTasks rolls back every appended plan item along with the batch when one spec fails", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    expect(() =>
      createTasks(db, noopEstimator, project.id, [
        { title: "second", release_id: release.id, complexity_hint: "normal" },
        { title: "bad", release_id: "nonexistent-release", complexity_hint: "normal" },
      ]),
    ).toThrow(/Unknown release/);

    const plan = getPlan(db, project.id, release.version)!;
    // Rolled back entirely, including the plan-append that "second" would
    // otherwise have made - not just the tasks table.
    expect(plan.status).toBe("approved");
    expect(plan.items.map((item) => item.task_id)).toEqual([first.id]);
    const taskCount = db
      .prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE project_id = ?`)
      .get(project.id) as { cnt: number };
    expect(taskCount.cnt).toBe(1);
  });

  it("does not revert the plan when a planned task is completed", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    completeTask(db, noopVerifier, { task_id: first.id, summary: "done" });

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("approved");
    expect(plan.approved_by).toBe("valentin");
  });

  it("does not revert the plan when a planned task is cancelled", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    cancelTask(db, { task_id: second.id, reason: "not needed" });

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("approved");
    expect(plan.approved_by).toBe("valentin");
  });

  it("does not touch an in-flight task's status, owner or lock when a revert fires", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);
    const second = addTask(db, project.id, "second", release.id);
    upsertPlan(db, project.id, release.version, { steps: [first.id, second.id] });
    approvePlan(db, project.id, release.version, { approved_by: "valentin", note: "go" });

    claimTask(db, first.id, "session-abc");
    const before = db
      .prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(first.id);

    // Triggers a revert on the same release's plan without touching `first`.
    addTask(db, project.id, "late", release.id);

    const plan = getPlan(db, project.id, release.version)!;
    expect(plan.status).toBe("draft");
    const after = db
      .prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(first.id);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: "in_progress", owner_session_id: "session-abc" });
  });

  it("does nothing to a release with no plan at all", () => {
    const { db, project, release } = setup();
    const first = addTask(db, project.id, "first", release.id);

    expect(getPlan(db, project.id, release.version)).toBeUndefined();

    setTaskRelease(db, first.id, null);
    expect(getPlan(db, project.id, release.version)).toBeUndefined();

    const backlog = addTask(db, project.id, "backlog");
    setTaskRelease(db, backlog.id, release.version);
    expect(getPlan(db, project.id, release.version)).toBeUndefined();
  });
});
