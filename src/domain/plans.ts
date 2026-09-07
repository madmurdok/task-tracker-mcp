import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { withdrawPlanApproval } from "./planWrites.js";
import { requireProject } from "./projects.js";
import { requireAssignableRelease, requireRelease } from "./releases.js";
import { displayStatus, type DisplayStatus } from "./status.js";
import { requireTask, runOne, taskCode, type TaskStatus } from "./tasks.js";

/**
 * A release batch's execution order: the sequence Claude proposes, which the
 * owner approves *once* so the batch can then be worked end to end instead of
 * stopping every two or three tasks to re-earn approval.
 *
 * IMPORT DIRECTION - read before adding an import *to* this module.
 * plans.ts depends on projects.ts, releases.ts, status.ts and tasks.ts; none of
 * them depends on plans.ts, which is what keeps the graph acyclic. The two
 * follow-up tasks both want to call into here from a module this one already
 * imports (the createTask/setTaskRelease revert hooks, and get_next_task's
 * plan-order scoping), so both would close a cycle. releases.ts already faced
 * exactly this and hand-rolled `requireTaskProjectAndRelease` rather than
 * import `requireTask` back from tasks.ts; the same escape applies here -
 * `revertPlanToDraft` is deliberately a single self-contained UPDATE with no
 * cross-module calls, so a hook can inline it if importing turns out to be
 * more trouble than it's worth.
 */
export type PlanStatus = "draft" | "approved";

/**
 * The plan row itself, without its items - the approval record. `status` is
 * only ever `draft` or `approved`: there is deliberately no third
 * "drifted"/"stale" status, because drift is a property of how the plan
 * compares to the batch *right now* and is computed at read time (see
 * `planDrift`), the same way `displayStatus` computes `blocked` from the
 * dependency graph instead of storing it.
 */
export interface ReleasePlanRecord {
  id: string;
  release_id: string;
  status: PlanStatus;
  rationale: string;
  approved_by: string | null;
  approval_note: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * How the plan and the batch disagree, both directions. Both lists carry
 * uuids because they are data for a caller to act on; the human-facing
 * rendering happens where a human reads it (see `approvePlan`'s refusal
 * message, which spells them as task codes).
 */
export interface PlanDrift {
  /** In the batch, absent from the plan - work the plan fails to order. */
  unplanned_task_ids: string[];
  /** In the plan, no longer in the batch - an order for work that left. */
  orphaned_task_ids: string[];
}

export interface PlanItem {
  task_id: string;
  /** How a person refers to this task: `TTM-63`. See tasks.ts's `taskCode`. */
  code: string;
  title: string;
  step: number;
  position: number;
  note: string;
  added_at: string;
  /**
   * Read live from the task on every getPlan, never stored on the item - a
   * copy would be a second truth that goes stale the moment the task moves,
   * and the plan would then report a batch that is already finished as
   * pending. Same rule the schema states for the item row itself.
   */
  status: DisplayStatus;
}

export interface ReleasePlan extends ReleasePlanRecord, PlanDrift {
  items: PlanItem[];
}

/**
 * One task's place in a plan: the ref alone, or the ref plus the one-line
 * reason it sits where it does. A ref is anything `resolveTaskId` accepts -
 * a uuid or a readable code like `TTM-63`.
 */
export type PlanItemInput = string | { task: string; note?: string };

/**
 * A step is a group of items that may run in parallel; `position` only orders
 * them *inside* the step so a display stays stable. A bare item is shorthand
 * for a step of one, which is what makes a flat list of refs
 * (`["TTM-1", "TTM-2"]`) a valid plan of two sequential steps - the common
 * case, and the one a caller reaches for first.
 */
export type PlanStepInput = PlanItemInput | PlanItemInput[];

export interface UpsertPlanInput {
  steps: PlanStepInput[];
  rationale?: string;
}

export interface ApprovePlanInput {
  approved_by: string;
  note?: string;
}

/** Normalised item, with the caller's ref resolved to a uuid. */
interface ResolvedItem {
  task_id: string;
  step: number;
  position: number;
  note: string;
}

function normaliseItem(item: PlanItemInput): { task: string; note: string } {
  return typeof item === "string" ? { task: item, note: "" } : { task: item.task, note: item.note ?? "" };
}

/**
 * Turns the caller's steps into rows, resolving every ref and rejecting
 * anything that does not belong in this batch.
 *
 * Rejects rather than silently dropping, deliberately: a plan that quietly
 * omits a task it was handed is the exact failure this whole feature exists to
 * prevent, and a caller who mistyped one ref out of twelve would otherwise get
 * an "ok" and an approved plan missing a task.
 *
 * Steps and positions are 1-based so the numbers a person reads
 * ("step 2, third task") match the numbers stored.
 */
function resolveSteps(
  db: DatabaseInstance,
  releaseId: string,
  releaseRef: string,
  steps: PlanStepInput[],
): ResolvedItem[] {
  if (steps.length === 0) {
    throw new Error("upsert_plan requires at least one step");
  }

  const resolved: ResolvedItem[] = [];
  // Resolved uuids, not the caller's refs: `TTM-63` and its uuid are the same
  // task, and a plan that ordered one task twice would be self-contradictory
  // about which step it runs in. Caught here rather than left to the
  // (plan_id, task_id) primary key, which would surface as a raw SQLite
  // constraint error naming neither the task nor the plan.
  const seen = new Set<string>();

  steps.forEach((step, stepIndex) => {
    const group = Array.isArray(step) ? step : [step];
    if (group.length === 0) {
      throw new Error(`Plan step ${stepIndex + 1} has no tasks`);
    }

    group.forEach((rawItem, positionIndex) => {
      const { task: ref, note } = normaliseItem(rawItem);
      // Through requireTask so a readable code works here too, and so the
      // "unknown task" error is the one every other tool already reports.
      // Importable (unlike in releases.ts, which would close a cycle) because
      // tasks.ts does not import this module - see IMPORT DIRECTION above.
      const task = requireTask(db, ref);

      if (task.release_id !== releaseId) {
        throw new Error(
          `Task ${ref} is not in release ${releaseRef}; a plan may only order tasks in its own batch`,
        );
      }
      if (seen.has(task.id)) {
        throw new Error(`Task ${ref} appears more than once in the plan`);
      }
      seen.add(task.id);

      resolved.push({
        task_id: task.id,
        step: stepIndex + 1,
        position: positionIndex + 1,
        note,
      });
    });
  });

  return resolved;
}

function getPlanRecord(db: DatabaseInstance, releaseId: string): ReleasePlanRecord | undefined {
  return db.prepare(`SELECT * FROM release_plans WHERE release_id = ?`).get(releaseId) as
    | ReleasePlanRecord
    | undefined;
}

/**
 * The single place drift is computed, so `getPlan`'s two lists and
 * `isPlanDrifted`'s boolean can never disagree about whether a plan covers its
 * batch - which they would, being read one line apart in `approvePlan`.
 *
 * `done` and `cancelled` tasks are excluded from the unplanned side on
 * purpose. A plan is an order for work still to be done; a task that is
 * already finished or abandoned needs no place in that order, and counting it
 * would leave any batch containing one permanently drifted and therefore
 * permanently unapprovable. The orphaned side has no such filter - an item
 * pointing at a task that left the batch is a stale instruction whatever that
 * task's status.
 */
function planDrift(db: DatabaseInstance, plan: Pick<ReleasePlanRecord, "id" | "release_id">): PlanDrift {
  const unplanned = db
    .prepare(
      `SELECT id FROM tasks
       WHERE release_id = ?
         AND status NOT IN ('done', 'cancelled')
         AND id NOT IN (SELECT task_id FROM release_plan_items WHERE plan_id = ?)
       ORDER BY priority DESC, created_at ASC`,
    )
    .all(plan.release_id, plan.id) as Array<{ id: string }>;

  // `IS NOT`, not `!=`: a task moved back to the backlog has release_id NULL,
  // and `NULL != 'some-id'` evaluates to NULL rather than true - so `!=` would
  // silently miss exactly the orphan that matters most, a planned task
  // someone pulled out of the batch entirely.
  const orphaned = db
    .prepare(
      `SELECT i.task_id AS id FROM release_plan_items i
       JOIN tasks t ON t.id = i.task_id
       WHERE i.plan_id = ? AND t.release_id IS NOT ?
       ORDER BY i.step ASC, i.position ASC`,
    )
    .all(plan.id, plan.release_id) as Array<{ id: string }>;

  return {
    unplanned_task_ids: unplanned.map((row) => row.id),
    orphaned_task_ids: orphaned.map((row) => row.id),
  };
}

/**
 * Whether the plan and the batch have diverged - the `isDocDrifted`
 * (projects.ts) analogue, and used the same way: a cheap boolean a caller can
 * fold into a status answer without assembling the whole plan read model.
 *
 * Takes the plan *record* rather than a `getPlan` result so it stays callable
 * from a caller that only looked up the row, and recomputes rather than
 * reading a `getPlan` result's lists so there is one definition of drift
 * (see `planDrift`).
 */
export function isPlanDrifted(
  db: DatabaseInstance,
  plan: Pick<ReleasePlanRecord, "id" | "release_id">,
): boolean {
  const drift = planDrift(db, plan);
  return drift.unplanned_task_ids.length > 0 || drift.orphaned_task_ids.length > 0;
}

interface ItemRow {
  task_id: string;
  step: number;
  position: number;
  note: string;
  added_at: string;
  /** The task's *stored* status - `displayStatus` turns it into the live one. */
  status: TaskStatus;
  title: string;
  task_number: number;
}

function listPlanItems(db: DatabaseInstance, planId: string, codePrefix: string): PlanItem[] {
  // JOIN, not LEFT JOIN: release_plan_items.task_id cascades on task delete
  // (see schema), so an item can outlive its task's *membership* but never the
  // task row itself.
  const rows = db
    .prepare(
      `SELECT i.task_id, i.step, i.position, i.note, i.added_at,
              t.status, t.title, t.task_number
       FROM release_plan_items i
       JOIN tasks t ON t.id = i.task_id
       WHERE i.plan_id = ?
       ORDER BY i.step ASC, i.position ASC`,
    )
    .all(planId) as ItemRow[];

  return rows.map((row) => ({
    task_id: row.task_id,
    code: taskCode(codePrefix, row.task_number),
    title: row.title,
    step: row.step,
    position: row.position,
    note: row.note,
    added_at: row.added_at,
    status: displayStatus(db, { id: row.task_id, status: row.status }),
  }));
}

/**
 * Reads a batch's plan: its items in execution order, each with its live
 * status, plus the approval record and both directions of drift.
 *
 * `requireRelease`, not `requireAssignableRelease` - a released or cancelled
 * batch takes no *new* plan, but the plan it was worked under stays readable;
 * freezing the read as well would hide the record right when someone asks
 * what the batch was supposed to do.
 *
 * Returns undefined for a batch with no plan, matching `getRelease`/
 * `getProject`: "no plan" is an ordinary answer, not a failure.
 */
export function getPlan(
  db: DatabaseInstance,
  projectRef: string,
  releaseRef: string,
): ReleasePlan | undefined {
  const project = requireProject(db, projectRef);
  const release = requireRelease(db, project.id, releaseRef);

  const record = getPlanRecord(db, release.id);
  if (!record) return undefined;

  // One prefix for every item: a task's release always lives in the task's own
  // project (requireAssignableRelease is scoped by it), so every item in a
  // plan renders under the same code prefix.
  return {
    ...record,
    items: listPlanItems(db, record.id, project.code_prefix),
    ...planDrift(db, record),
  };
}

/**
 * Writes a batch's execution order, creating the plan or replacing its items
 * wholesale, in one transaction.
 *
 * Replacing an approved plan resets it to draft and clears
 * approved_by/approval_note/approved_at: a new order is a new plan, and
 * carrying the old approval forward would say the owner signed off on
 * something they never saw. `rationale` is reset the same way and for the same
 * reason - the justification for the previous order is not a justification for
 * this one.
 *
 * A plain `db.transaction`, not `.immediate()`: the only thing two racing
 * writers here can do is have the later plan win, which is what the later
 * caller asked for - unlike schema.ts's DDL rebuilds, where a race corrupts.
 */
export function upsertPlan(
  db: DatabaseInstance,
  projectRef: string,
  releaseRef: string,
  input: UpsertPlanInput,
): ReleasePlan {
  const project = requireProject(db, projectRef);
  const release = requireAssignableRelease(db, project.id, releaseRef, "write a plan for it");

  const run = db.transaction((): ReleasePlan => {
    const items = resolveSteps(db, release.id, releaseRef, input.steps);
    const now = new Date().toISOString();
    const existing = getPlanRecord(db, release.id);

    let planId: string;
    if (existing) {
      planId = existing.id;
      runOne(
        db.prepare(
          `UPDATE release_plans
           SET status = 'draft', rationale = ?, approved_by = NULL, approval_note = NULL,
               approved_at = NULL, updated_at = ?
           WHERE id = ?`,
        ),
        `upsert_plan ${releaseRef}`,
        input.rationale ?? "",
        now,
        planId,
      );
    } else {
      planId = randomUUID();
      db.prepare(
        `INSERT INTO release_plans (id, release_id, status, rationale, approved_by, approval_note, approved_at, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, NULL, NULL, NULL, ?, ?)`,
      ).run(planId, release.id, input.rationale ?? "", now, now);
    }

    // added_at answers "when did this task enter the plan", not "when was the
    // plan last written", so an item that survives a rewrite keeps the
    // timestamp it came in with. That distinction is what makes the schema's
    // "new since approval" rule (added_at > approved_at) mean anything at all;
    // stamping every row afresh on each upsert would make every task look
    // newly added whenever a single step was reordered.
    const carriedAddedAt = new Map(
      (
        db.prepare(`SELECT task_id, added_at FROM release_plan_items WHERE plan_id = ?`).all(planId) as Array<{
          task_id: string;
          added_at: string;
        }>
      ).map((row) => [row.task_id, row.added_at]),
    );

    db.prepare(`DELETE FROM release_plan_items WHERE plan_id = ?`).run(planId);

    const insertItem = db.prepare(
      `INSERT INTO release_plan_items (plan_id, task_id, step, position, note, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insertItem.run(
        planId,
        item.task_id,
        item.step,
        item.position,
        item.note,
        carriedAddedAt.get(item.task_id) ?? now,
      );
    }

    const record = getPlanRecord(db, release.id)!;
    return {
      ...record,
      items: listPlanItems(db, planId, project.code_prefix),
      ...planDrift(db, record),
    };
  });

  return run();
}

/**
 * Renders task uuids as the codes a person reads (`TTM-72`), preserving the
 * caller's order. An id whose task row is gone renders as itself rather than
 * as a code for a task_number that does not exist.
 */
function codesFor(db: DatabaseInstance, codePrefix: string, taskIds: string[]): string[] {
  if (taskIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, task_number FROM tasks WHERE id IN (${taskIds.map(() => "?").join(", ")})`,
    )
    .all(...taskIds) as Array<{ id: string; task_number: number }>;
  const numbers = new Map(rows.map((row) => [row.id, row.task_number]));
  return taskIds.map((id) => {
    const taskNumber = numbers.get(id);
    return taskNumber === undefined ? id : taskCode(codePrefix, taskNumber);
  });
}

/**
 * Records the owner's one-time sign-off on the plan: draft -> approved,
 * stamping who approved it, their verbatim words, and when.
 *
 * Refuses while the plan is drifted. Approving a plan that does not cover the
 * batch approves something untrue - the caller would then be entitled to work
 * a batch whose uncovered tasks nobody ever agreed an order for, which is the
 * one outcome this feature exists to prevent. The refusal names the tasks by
 * code, because the only useful response to it is fixing the plan.
 *
 * Refuses an already-approved plan too, rather than re-stamping: a second
 * approval would quietly overwrite the first approver, note and timestamp, and
 * the audit trail is the whole value of the record.
 *
 * `note` is stored exactly as given - not trimmed, not normalised. This
 * approval is granted by the same party that calls the tool, so their own
 * words are the only real evidence of what they agreed to, and editing them is
 * not this layer's business. `approved_by` is held to being non-blank for the
 * same reason: an approval attributed to nobody records nothing.
 */
export function approvePlan(
  db: DatabaseInstance,
  projectRef: string,
  releaseRef: string,
  input: ApprovePlanInput,
): ReleasePlan {
  const project = requireProject(db, projectRef);
  const release = requireAssignableRelease(db, project.id, releaseRef, "approve its plan");

  if (input.approved_by.trim() === "") {
    throw new Error("approve_plan requires approved_by: an approval with no approver records nothing");
  }

  const run = db.transaction((): ReleasePlan => {
    const record = getPlanRecord(db, release.id);
    if (!record) {
      throw new Error(`No plan for release ${releaseRef}; write one with upsert_plan first`);
    }

    // Before the drift check: "already approved, nothing to do" is the more
    // informative answer of the two, and a plan that is both would have been
    // reverted to draft by the createTask/setTaskRelease hooks anyway.
    if (record.status === "approved") {
      throw new Error(
        `Plan for release ${releaseRef} is already approved by ${record.approved_by} at ${record.approved_at}`,
      );
    }

    const drift = planDrift(db, record);
    if (drift.unplanned_task_ids.length > 0 || drift.orphaned_task_ids.length > 0) {
      const parts: string[] = [];
      if (drift.unplanned_task_ids.length > 0) {
        parts.push(`not in the plan: ${codesFor(db, project.code_prefix, drift.unplanned_task_ids).join(", ")}`);
      }
      if (drift.orphaned_task_ids.length > 0) {
        parts.push(
          `in the plan but no longer in the batch: ${codesFor(db, project.code_prefix, drift.orphaned_task_ids).join(", ")}`,
        );
      }
      throw new Error(
        `Plan for release ${releaseRef} does not match the batch, so it cannot be approved (${parts.join("; ")}). Rewrite it with upsert_plan.`,
      );
    }

    const now = new Date().toISOString();
    runOne(
      db.prepare(
        `UPDATE release_plans
         SET status = 'approved', approved_by = ?, approval_note = ?, approved_at = ?, updated_at = ?
         WHERE id = ?`,
      ),
      `approve_plan ${releaseRef}`,
      input.approved_by,
      input.note ?? null,
      now,
      now,
      record.id,
    );

    const approved = getPlanRecord(db, release.id)!;
    return {
      ...approved,
      items: listPlanItems(db, approved.id, project.code_prefix),
      ...drift,
    };
  });

  return run();
}

/**
 * Withdraws an approval while keeping the items: the order Claude proposed is
 * still the best guess at how to work the batch, but the batch changed under
 * it, so the sign-off no longer covers what is in front of the owner.
 *
 * Takes a raw release id and calls into no other module on purpose - this is
 * the function the createTask/setTaskRelease hooks need, and both live in
 * modules this one imports (see IMPORT DIRECTION at the top), so keeping it a
 * single self-contained UPDATE means a hook can either import it or inline the
 * same statement without a cycle either way.
 *
 * Returns whether an approval was actually withdrawn. Not `runOne`: the hooks
 * fire on every task created or moved, and the overwhelmingly common case is a
 * release with no plan, or a plan still in draft - neither of which is an
 * error. The `status = 'approved'` predicate is what makes the return value
 * honest rather than just "a row with this release_id exists".
 */
export function revertPlanToDraft(db: DatabaseInstance, releaseId: string): boolean {
  // The statement itself lives in planWrites.ts, which imports nothing from
  // the domain layer - that is what lets tasks.ts and releases.ts call it
  // without importing this module and closing a cycle. Kept exported here
  // too, because this is where a reader looks for it.
  return withdrawPlanApproval(db, releaseId);
}
