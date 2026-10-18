import type { DatabaseInstance } from "../db/connection.js";
import { requireEpic, listEpics, type Epic } from "./epics.js";
import { listHandoffNotes, type HandoffNote } from "./handoffNotes.js";
import { listTaskAmendments, type TaskAmendment } from "./taskAmendments.js";
import {
  getPlan,
  listPendingPlans,
  type PendingPlan,
  type PlanDrift,
  type PlanItem,
  type PlanStatus,
} from "./plans.js";
import { isDocDrifted, requireProject } from "./projects.js";
import { listReleases, requireRelease, type Release } from "./releases.js";
import { listSliceRevisions, listTaskSlices, type TaskSlice, type TaskSliceRevision } from "./slices.js";
import { displayStatus, hasUnmetDependencies, LOCK_LEASE_MS, type DisplayStatus } from "./taskStatus.js";
import { listTaskFilePaths, requireTask, type Task, withCode, taskCode} from "./tasks.js";

// Re-exported, not redefined: `DisplayStatus` moved to the taskStatus.ts leaf
// (see its header for the cycle that put it there), but it is still the type of
// TaskSummary.status and of listTasks' filter, both exported from here - a
// consumer of those should not have to learn a second module to name it. Only
// the type: the three functions have exactly one home, so that a call site
// never has two paths to the same query.
export type { DisplayStatus };

export interface TaskSummary {
  id: string;
  /** How a person refers to this task: `TTM-63`. See tasks.ts's `withCodes`. */
  code: string;
  title: string;
  status: DisplayStatus;
  estimated_tokens: number;
  epic_id: string | null;
  release_id: string | null;
  task_number: number;
}

export interface ProjectStatus {
  total: number;
  done: number;
  in_progress: number;
  blocked: number;
  pending: number;
  cancelled: number;
  percent: number;
}

/**
 * The plan situation of the batch a release-scoped get_next_task was pointed
 * at. `PlanStatus`'s own two values are the *stored* ones; the two added here
 * are computed at read time, exactly as plans.ts explains for drift - `none`
 * because a batch with no plan row is an ordinary answer rather than a failure,
 * and `drifted` because it is a property of how an approved plan compares to
 * the batch right now.
 *
 * Reported *beside* `reason`, not folded into it, deliberately. `reason` has
 * always meant "why there is no task", and case 4 of this feature can hand a
 * task out and still need to say the batch has no plan - one field cannot carry
 * both facts without changing the meaning every existing caller relies on.
 */
export type ReportedPlanStatus = PlanStatus | "drifted" | "none";

/**
 * The previous holder of a task get_next_task just reclaimed (TTM-78), read
 * before the hand-out cleared it. Reclaim is automatic and runs on elapsed
 * time alone, which cannot tell a dead session from a paused one (usage limit,
 * overnight, waiting on the owner) - so the answer says it happened and leaves
 * the receiver to confirm the previous holder is gone before working on it.
 *
 * `last_activity_at` is the latest tracker write about the task: its own
 * `updated_at`, its slices' `created_at`/`started_at`/`completed_at`, and its
 * handoff notes' `created_at`. The slice stamps are included because
 * renewLease (the slice heartbeat) deliberately leaves `updated_at` alone, so
 * `updated_at` by itself would miss exactly the activity that keeps a lease
 * alive; `created_at` covers set/revise_task_slices, which renew it too.
 * Handoff notes do not renew the lease but are counted: a note written after
 * the last slice event is still a sign of a worker. Never null - `updated_at`
 * is always set.
 */
export interface ReclaimedFrom {
  owner_session_id: string | null;
  lock_expires_at: string;
  last_activity_at: string;
}

/**
 * An in_progress task under a live lease, reported when nothing could be
 * handed out so the caller knows whom it is waiting for and until when.
 * `id` matches `blocked_on`'s uuids; `code` is the `PREFIX-N` form people and
 * orchestrators use. `lock_expires_at` is null only on legacy rows;
 * `owner_session_id` is null for a get_next_task hand-out (TTM-78).
 */
export interface HeldTask {
  id: string;
  code: string;
  lock_expires_at: string | null;
  owner_session_id: string | null;
}

type NextTaskOutcome =
  /**
   * `reclaimed_from` only when the task was in_progress under a lapsed lease;
   * absent (no key) on a fresh hand-out of a pending task, so that answer stays
   * exactly what it always was.
   */
  | { task: TaskDetail; reclaimed_from?: ReclaimedFrom }
  | { task: null; reason: "all_done" }
  /**
   * Work remains but none can be handed out. `all_blocked` when some pending
   * task waits on a dependency (`blocked_on`), `all_held` when every remaining
   * task is in progress under a live lease - wait for the holders. `held` is on
   * both, possibly empty, soonest-lapsing lease first.
   */
  | { task: null; reason: "all_blocked"; blocked_on: string[]; held: HeldTask[] }
  | { task: null; reason: "all_held"; blocked_on: []; held: HeldTask[] }
  /**
   * A batch was named, but its plan is a draft or has drifted, so there is no
   * approved order to work it in. `drift` names the disagreeing tasks whenever
   * there is one, because the only useful response to this refusal is fixing
   * the plan - by uuid, matching plans.ts's convention for these two lists.
   */
  | { task: null; reason: "plan_not_approved"; drift?: PlanDrift };

export type GetNextTaskResult = NextTaskOutcome & {
  doc_drift: boolean;
  /**
   * Unscoped calls only, and absent (not `[]`) when there is nothing to report,
   * following this project's "absent is not zero" habit - which is also what
   * keeps the answer byte-identical for every project that has no plans.
   * See plans.ts's `listPendingPlans` for why an unscoped call reports these
   * rather than refusing.
   */
  plan_pending?: PendingPlan[];
  /**
   * Release-scoped calls only. Absent on an unscoped one, where there is no
   * single batch whose plan the answer could be describing.
   */
  plan_status?: ReportedPlanStatus;
};

export interface TaskDetail extends Task {
  /** How a person refers to this task: `TTM-63`. See tasks.ts's `withCodes`. */
  code: string;
  file_paths: string[];
  handoff_notes: HandoffNote[];
  /**
   * amend_task's trail (TTM-81), oldest first - empty for a never-amended
   * task. The row's own fields are always the *current* text; this is what
   * makes what a plan was approved against, or what a card used to say,
   * recoverable rather than silently overwritten.
   */
  amendments: TaskAmendment[];
  /**
   * How the task is worked (TTM-83), in step/position order - slices sharing
   * a step may run in parallel. Empty for a task nobody has sliced yet.
   */
  slices: TaskSlice[];
  /**
   * revise_task_slices's trail (TTM-89), oldest first - each revision's reason
   * and the pending slices it replaced. Empty for a task never revised.
   */
  slice_revisions: TaskSliceRevision[];
}

/**
 * The "compact task packet" the architecture doc's data flow promises from
 * get_next_task (files, acceptance criteria, prior handoff notes) - composes
 * requireTask/listTaskFilePaths (tasks.ts) with listHandoffNotes
 * (handoffNotes.ts) and listTaskAmendments (taskAmendments.ts). Also backs the
 * side-effect-free get_task MCP tool.
 */
export function getTaskDetail(db: DatabaseInstance, taskId: string): TaskDetail {
  const task = requireTask(db, taskId);
  // `task.id`, not the caller's `taskId`: the caller may have named this task
  // by its code, and everything below addresses rows by uuid.
  return {
    ...withCode(db, task),
    file_paths: listTaskFilePaths(db, task.id),
    handoff_notes: listHandoffNotes(db, task.id),
    amendments: listTaskAmendments(db, task.id),
    slices: listTaskSlices(db, task.id),
    slice_revisions: listSliceRevisions(db, task.id),
  };
}

// Defined in taskStatus.ts so slices.ts (start_slice) can grant the same
// lease without importing this module; re-exported for existing importers.
export { LOCK_LEASE_MS };

function withLease(nowIso: string): string {
  return new Date(Date.parse(nowIso) + LOCK_LEASE_MS).toISOString();
}

function handOut(
  db: DatabaseInstance,
  candidate: Task,
  nowIso: string,
  ownerSessionId: string | null,
): { task: TaskDetail } {
  const lockExpiresAt = withLease(nowIso);
  db.prepare(
    `UPDATE tasks SET status = 'in_progress', owner_session_id = ?, lock_expires_at = ?, updated_at = ? WHERE id = ?`,
  ).run(ownerSessionId, lockExpiresAt, nowIso, candidate.id);
  return { task: getTaskDetail(db, candidate.id) };
}

/** See `ReclaimedFrom` for which writes count as activity. */
function lastActivityAt(db: DatabaseInstance, task: Task): string {
  // Every timestamp here is `toISOString()` output (fixed-width UTC), so MAX
  // over the strings is the chronological maximum. Aggregate MAX skips the
  // NULL started_at/completed_at of slices not yet run.
  const row = db
    .prepare(
      `SELECT MAX(t) AS last FROM (
         SELECT created_at AS t FROM task_slices WHERE task_id = ?
         UNION ALL SELECT started_at FROM task_slices WHERE task_id = ?
         UNION ALL SELECT completed_at FROM task_slices WHERE task_id = ?
         UNION ALL SELECT created_at FROM handoff_notes WHERE task_id = ?
       )`,
    )
    .get(task.id, task.id, task.id, task.id) as { last: string | null };
  return row.last !== null && row.last > task.updated_at ? row.last : task.updated_at;
}

/**
 * Hands out an in_progress task whose lease has lapsed, with the owner cleared,
 * and reports who held it. The one reclaim path for both selection strategies,
 * so the two report it identically. `task` is the row as read before the
 * hand-out: handOut overwrites its owner, lease and updated_at.
 */
function reclaim(db: DatabaseInstance, task: Task, nowIso: string): NextTaskOutcome {
  const reclaimedFrom: ReclaimedFrom = {
    owner_session_id: task.owner_session_id,
    // Non-null: both callers select only tasks whose lease is set and lapsed.
    lock_expires_at: task.lock_expires_at!,
    last_activity_at: lastActivityAt(db, task),
  };
  return { ...handOut(db, task, nowIso, null), reclaimed_from: reclaimedFrom };
}

/**
 * Which pool a hand-out draws from: the whole project (an unscoped call - what
 * every session has always got) or the one release batch it was pointed at.
 *
 * `column` is interpolated into the SQL below rather than bound, which is safe
 * *because* it is a union of two literals written here - no caller-supplied
 * string ever reaches it. Binding is impossible for a column name anyway, and
 * the alternative (two near-identical copies of every statement) is exactly the
 * duplication that lets the scoped path drift away from the unscoped one.
 */
interface HandOutScope {
  column: "project_id" | "release_id";
  id: string;
}

/**
 * The answer when nothing could be handed out: all_done only when the pool
 * holds no unfinished work at all; otherwise all_blocked naming the pending
 * tasks that were passed over, or all_held when there are none and everything
 * left is in progress under a live lease. Both carry `held`. Shared by both
 * selection strategies so the two cannot disagree about what an exhausted pool
 * is called.
 *
 * `held` is queried here with the live-lease predicate written out rather than
 * inferred from the pickers having reclaimed every lapsed lease, so a lapsed
 * lease can never be reported as held even if a picker changes.
 */
function exhausted(
  db: DatabaseInstance,
  scope: HandOutScope,
  skipped: Task[],
  nowIso: string,
): NextTaskOutcome {
  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM tasks WHERE ${scope.column} = ? AND status NOT IN ('done', 'cancelled')`,
    )
    .get(scope.id) as { cnt: number };

  if (remaining.cnt === 0) {
    return { task: null, reason: "all_done" };
  }

  // Soonest lease to lapse first; a NULL (legacy) lease never lapses, so it
  // goes last - SQLite would otherwise sort NULL first in ASC order.
  const heldRows = db
    .prepare(
      `SELECT t.id, p.code_prefix, t.task_number, t.lock_expires_at, t.owner_session_id
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.${scope.column} = ? AND t.status = 'in_progress'
         AND (t.lock_expires_at IS NULL OR t.lock_expires_at >= ?)
       ORDER BY t.lock_expires_at IS NULL, t.lock_expires_at ASC, t.created_at ASC`,
    )
    .all(scope.id, nowIso) as {
    id: string;
    code_prefix: string;
    task_number: number;
    lock_expires_at: string | null;
    owner_session_id: string | null;
  }[];
  const held: HeldTask[] = heldRows.map((r) => ({
    id: r.id,
    code: taskCode(r.code_prefix, r.task_number),
    lock_expires_at: r.lock_expires_at,
    owner_session_id: r.owner_session_id,
  }));

  if (skipped.length === 0) {
    return { task: null, reason: "all_held", blocked_on: [], held };
  }
  return { task: null, reason: "all_blocked", blocked_on: skipped.map((t) => t.id), held };
}

/**
 * Priority order: highest priority first, oldest first among equals, then the
 * stale-lock reclaim pass.
 *
 * Parameterised by scope rather than copied, so the release-scoped fallback for
 * a batch with no plan (case 4) runs the *same* algorithm as the unscoped call
 * instead of a lookalike that can drift away from it. The unscoped call passes
 * project_id and gets behaviour identical to what it always had - the contract
 * every session in this project depends on.
 */
function pickByPriority(db: DatabaseInstance, scope: HandOutScope, nowIso: string): NextTaskOutcome {
  const pendingTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE ${scope.column} = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC`,
    )
    .all(scope.id) as Task[];

  for (const candidate of pendingTasks) {
    if (!hasUnmetDependencies(db, candidate.id)) {
      return handOut(db, candidate, nowIso, candidate.owner_session_id);
    }
  }

  // No fresh pending work - see if an in_progress task's lock has expired and
  // can be automatically reclaimed. Its session may have died, or only paused
  // (elapsed time cannot tell which), so the answer carries reclaimed_from.
  const reclaimable = db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${scope.column} = ? AND status = 'in_progress'
         AND lock_expires_at IS NOT NULL AND lock_expires_at < ?
       ORDER BY lock_expires_at ASC
       LIMIT 1`,
    )
    .get(scope.id, nowIso) as Task | undefined;

  if (reclaimable) {
    return reclaim(db, reclaimable, nowIso);
  }

  return exhausted(db, scope, pendingTasks, nowIso);
}

/**
 * The approved plan's own order - step then position, exactly as `getPlan`
 * returns it - instead of priority. Priority is a standing guess about what
 * matters most; an approved plan is a decision a person made about this batch,
 * and the point of pointing get_next_task at a batch is that the decision wins.
 *
 * The two candidate shapes mirror `pickByPriority`'s two branches one for one -
 * a pending task, or an in_progress one whose lease has lapsed and is therefore
 * reclaimable - so following a plan changes *which* task is handed out and
 * never the ownership semantics of handing it out. It does reorder the two
 * branches against each other: a reclaimable step-1 task now beats a fresh
 * pending step-2 one, where the unscoped path drains all pending work before
 * reclaiming anything. That is the plan being followed, not an oversight - the
 * plan says step 1 comes first, and a dead session's abandoned task is still
 * step 1's work.
 *
 * Within one step the two shapes are NOT interleaved by position: every
 * unclaimed pending task in the step is handed out before any task of that
 * step is reclaimed (TTM-98). A step's tasks run in parallel, so a sibling
 * nobody has started yet is the step's missing work, whereas a lapsed lease on
 * one already handed out most often means a live orchestrator outran the lease
 * rather than a dead one - reclaiming it first handed the same task out twice
 * and left its sibling unclaimed while an agent worked on it (g-mesh 3.20.0,
 * step [GM-486, GM-490]). Across steps the order above is unchanged: a
 * reclaimable step-1 task still beats a pending step-2 one.
 *
 * So the two paths differ only in order: pickByPriority reclaims nothing while
 * any pending task in the pool is unblocked, and then takes the oldest lapsed
 * lease; this walker reclaims within the first step that has no unclaimed
 * pending task, in position order. Whichever path reclaims, it goes through
 * `reclaim`, so the answer carries the same `reclaimed_from` marker (TTM-78)
 * naming the previous holder - the receiver confirms that holder is gone
 * before working on it, because a lapsed lease may be a paused session rather
 * than a dead one.
 *
 * A task held under a live lease is never handed out again, including when
 * every task of its step is so held: get_next_task hands out work nobody holds,
 * and a holder resumes its own task by id (get_task/claim_task), which it
 * already has. Returning a held task "for resuming" would be the very
 * duplicate hand-out above, to whichever session asked next. Such a step
 * contributes no candidate and the walk moves on to the next step, exactly as
 * it always has for a held task; if no step has a candidate the answer is the
 * same all_done/all_blocked/all_held any exhausted pool gets (all_held when
 * every remaining task is so held).
 *
 * A task in the batch but absent from the plan is not a candidate and is not
 * looked for here: that set being non-empty *is* drift, so the caller has
 * already refused before reaching this function.
 */
function pickByPlan(
  db: DatabaseInstance,
  scope: HandOutScope,
  items: PlanItem[],
  nowIso: string,
): NextTaskOutcome {
  // Only the ones actually passed over as blocked, so an exhausted plan reports
  // the same blocked_on a priority-ordered pass would have: every task it saw
  // still pending and still waiting on something.
  const blocked: Task[] = [];

  // getPlan returns items in step then position order, so consecutive runs of
  // one step number are exactly the plan's steps, each still in position order.
  const steps: PlanItem[][] = [];
  for (const item of items) {
    const last = steps[steps.length - 1];
    if (last && last[0]!.step === item.step) last.push(item);
    else steps.push([item]);
  }

  for (const step of steps) {
    const reclaimable: Task[] = [];

    for (const item of step) {
      // getPlan JOINs items to tasks, and the item row cascades on task delete,
      // so this row always exists; the guard narrows the type rather than
      // handling a case that can occur.
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(item.task_id) as Task | undefined;
      if (!task) continue;

      if (task.status === "done" || task.status === "cancelled") continue;

      if (task.status === "pending") {
        if (hasUnmetDependencies(db, task.id)) {
          blocked.push(task);
          continue;
        }
        return handOut(db, task, nowIso, task.owner_session_id);
      }

      // in_progress: someone holds it. Reclaimable only once the lease it was
      // handed out under has lapsed - the same predicate as pickByPriority's
      // reclaim branch, `IS NOT NULL` included, because an in_progress task
      // with no lease was never handed out by this path and is not this path's
      // to take back. String comparison, not Date parsing: these are all
      // `toISOString()` output, fixed-width UTC, so lexicographic order is
      // chronological order - the same assumption the SQL above already makes.
      // Collected, not returned: the step's pending tasks go first.
      if (task.lock_expires_at !== null && task.lock_expires_at < nowIso) {
        reclaimable.push(task);
      }
    }

    // In position order, not pickByPriority's oldest-lease-first: the plan's
    // order is the one being followed here.
    const reclaimCandidate = reclaimable[0];
    if (reclaimCandidate) {
      return reclaim(db, reclaimCandidate, nowIso);
    }
  }

  return exhausted(db, scope, blocked, nowIso);
}

/**
 * Hands out the next task to work, marking it in_progress under a fresh lease.
 * A task reclaimed from a lapsed lease, on either path, carries
 * `reclaimed_from` (see `ReclaimedFrom`).
 *
 * Unscoped (no `releaseRef`) it behaves as it always has: project-wide,
 * priority order, the stale-lock reclaim, all_done/all_blocked/all_held. It gains one
 * reported field, `plan_pending`, so that handing out a task from a batch whose
 * plan nobody approved is visible in the answer rather than silent.
 *
 * Given a `releaseRef` it works one batch, and the batch's plan decides how:
 * an approved plan is followed in its own order; a draft or drifted plan
 * refuses outright, which is the whole point of a plan being approved at all;
 * and a batch with no plan falls back to priority order within the batch. That
 * last case is deliberately not treated as an implicit plan - a batch nobody
 * has ordered yet still has to be workable, or writing the plan would be
 * impossible without first refusing all work on the tasks it orders.
 */
export function getNextTask(
  db: DatabaseInstance,
  projectRef: string,
  releaseRef?: string,
): GetNextTaskResult {
  const project = requireProject(db, projectRef);
  // `requireRelease`, not `requireAssignableRelease`: an unknown batch is the
  // caller's mistake and should throw the same "Unknown release" every other
  // tool throws, whereas whether a shipped or cancelled batch may still hand
  // work out is a separate question this change deliberately leaves alone -
  // release_id here scopes the same hand-out, it does not add a new gate.
  const release = releaseRef === undefined ? null : requireRelease(db, project.id, releaseRef);
  const doc_drift = isDocDrifted(project);
  const nowIso = new Date().toISOString();

  if (release === null) {
    const outcome = db.transaction(() =>
      pickByPriority(db, { column: "project_id", id: project.id }, nowIso),
    )();
    const planPending = listPendingPlans(db, project.id);
    return {
      ...outcome,
      doc_drift,
      ...(planPending.length > 0 ? { plan_pending: planPending } : {}),
    };
  }

  const scope: HandOutScope = { column: "release_id", id: release.id };
  const plan = getPlan(db, project.id, release.id);

  if (!plan) {
    return { ...db.transaction(() => pickByPriority(db, scope, nowIso))(), doc_drift, plan_status: "none" };
  }

  const drift: PlanDrift = {
    unplanned_task_ids: plan.unplanned_task_ids,
    orphaned_task_ids: plan.orphaned_task_ids,
  };
  const drifted = drift.unplanned_task_ids.length > 0 || drift.orphaned_task_ids.length > 0;

  if (plan.status !== "approved" || drifted) {
    // The enforced half. A draft plan was never signed off; an approved one
    // that has drifted was signed off on a batch that has since changed. Either
    // way, handing work out would be handing out work whose order nobody
    // agreed - so nothing is handed out, and no transaction is needed because
    // nothing is written. `plan_status` reports the plan's *own* state, which
    // is why a drifted draft still reads `draft`: the approval is the first
    // thing missing, and drift is reported alongside it either way.
    return {
      task: null,
      reason: "plan_not_approved",
      doc_drift,
      plan_status: plan.status === "approved" ? "drifted" : "draft",
      ...(drifted ? { drift } : {}),
    };
  }

  return {
    ...db.transaction(() => pickByPlan(db, scope, plan.items, nowIso))(),
    doc_drift,
    plan_status: "approved",
  };
}

export function listTasks(
  db: DatabaseInstance,
  projectRef: string,
  statusFilter?: DisplayStatus,
  epicRef?: string,
  releaseRef?: string,
): TaskSummary[] {
  const projectId = requireProject(db, projectRef).id;
  const epicId = epicRef ? requireEpic(db, projectId, epicRef).id : null;
  const releaseId = releaseRef ? requireRelease(db, projectId, releaseRef).id : null;

  const conditions = ["project_id = ?"];
  const params: string[] = [projectId];
  if (epicId) {
    conditions.push("epic_id = ?");
    params.push(epicId);
  }
  if (releaseId) {
    conditions.push("release_id = ?");
    params.push(releaseId);
  }

  const tasks = db
    .prepare(`SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`)
    .all(...params) as Task[];

  // `code` beside `task_number`, not instead of it: the number is the datum,
  // the code is how a person says it, and a caller quoting a task in a branch
  // name or a commit should never have to assemble one from a prefix it had to
  // learn elsewhere.
  const prefix = requireProject(db, projectId).code_prefix;
  const summaries = tasks.map((task) => ({
    id: task.id,
    code: taskCode(prefix, task.task_number),
    title: task.title,
    status: displayStatus(db, task),
    estimated_tokens: task.estimated_tokens,
    epic_id: task.epic_id,
    release_id: task.release_id,
    task_number: task.task_number,
  }));

  return statusFilter ? summaries.filter((s) => s.status === statusFilter) : summaries;
}

/**
 * Shared by getProjectStatus and the epic-scoped variants below - status
 * counting is identical, only the task set fed in (by project vs. by epic)
 * differs.
 */
function aggregateStatus(db: DatabaseInstance, tasks: Array<Pick<Task, "id" | "status">>): ProjectStatus {
  const counts: ProjectStatus = {
    total: tasks.length,
    done: 0,
    in_progress: 0,
    blocked: 0,
    pending: 0,
    cancelled: 0,
    percent: 0,
  };

  for (const task of tasks) {
    const status = displayStatus(db, task);
    counts[status] += 1;
  }

  counts.percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);

  return counts;
}

export function getProjectStatus(
  db: DatabaseInstance,
  projectRef: string,
): ProjectStatus & { doc_drift: boolean } {
  const project = requireProject(db, projectRef);
  const tasks = db
    .prepare(`SELECT id, status FROM tasks WHERE project_id = ?`)
    .all(project.id) as Array<Pick<Task, "id" | "status">>;

  return { ...aggregateStatus(db, tasks), doc_drift: isDocDrifted(project) };
}

export type EpicStatus = Epic & ProjectStatus;

function epicTaskCounts(db: DatabaseInstance, epicId: string): ProjectStatus {
  const tasks = db
    .prepare(`SELECT id, status FROM tasks WHERE epic_id = ?`)
    .all(epicId) as Array<Pick<Task, "id" | "status">>;
  return aggregateStatus(db, tasks);
}

export function getEpicStatus(db: DatabaseInstance, projectRef: string, epicRef: string): EpicStatus {
  const projectId = requireProject(db, projectRef).id;
  const epic = requireEpic(db, projectId, epicRef);

  return { ...epic, ...epicTaskCounts(db, epic.id) };
}

export function listEpicsWithStatus(db: DatabaseInstance, projectRef: string): EpicStatus[] {
  const projectId = requireProject(db, projectRef).id;
  const epics = listEpics(db, projectId);

  return epics.map((epic) => ({ ...epic, ...epicTaskCounts(db, epic.id) }));
}

export type ReleaseStatusSummary = Release & ProjectStatus;

function releaseTaskCounts(db: DatabaseInstance, releaseId: string): ProjectStatus {
  const tasks = db
    .prepare(`SELECT id, status FROM tasks WHERE release_id = ?`)
    .all(releaseId) as Array<Pick<Task, "id" | "status">>;
  return aggregateStatus(db, tasks);
}

export function getReleaseStatus(
  db: DatabaseInstance,
  projectRef: string,
  releaseRef: string,
): ReleaseStatusSummary {
  const projectId = requireProject(db, projectRef).id;
  const release = requireRelease(db, projectId, releaseRef);

  return { ...release, ...releaseTaskCounts(db, release.id) };
}

export function listReleasesWithStatus(db: DatabaseInstance, projectRef: string): ReleaseStatusSummary[] {
  const projectId = requireProject(db, projectRef).id;
  const releases = listReleases(db, projectId);

  return releases.map((release) => ({ ...release, ...releaseTaskCounts(db, release.id) }));
}
