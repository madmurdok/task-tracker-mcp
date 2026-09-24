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
import { listTaskSlices, type TaskSlice } from "./slices.js";
import { displayStatus, hasUnmetDependencies, type DisplayStatus } from "./taskStatus.js";
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

type NextTaskOutcome =
  | { task: TaskDetail }
  | { task: null; reason: "all_done" }
  | { task: null; reason: "all_blocked"; blocked_on: string[] }
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
  };
}

/**
 * How long a hand-out (via get_next_task) or an explicit claim_task holds a
 * task before it's considered stale and eligible for automatic reclaim by a
 * later get_next_task call (v2 ownership semantics - v1 only guaranteed no
 * duplicate hand-out, see the doc's Non-goals/Failure Modes).
 */
export const LOCK_LEASE_MS = 30 * 60 * 1000;

function withLease(nowIso: string): string {
  return new Date(Date.parse(nowIso) + LOCK_LEASE_MS).toISOString();
}

function handOut(
  db: DatabaseInstance,
  candidate: Task,
  nowIso: string,
  ownerSessionId: string | null,
): NextTaskOutcome {
  const lockExpiresAt = withLease(nowIso);
  db.prepare(
    `UPDATE tasks SET status = 'in_progress', owner_session_id = ?, lock_expires_at = ?, updated_at = ? WHERE id = ?`,
  ).run(ownerSessionId, lockExpiresAt, nowIso, candidate.id);
  return { task: getTaskDetail(db, candidate.id) };
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
 * holds no unfinished work at all, otherwise all_blocked naming the pending
 * tasks that were passed over. Shared by both selection strategies so the two
 * cannot disagree about what an exhausted pool is called.
 */
function exhausted(db: DatabaseInstance, scope: HandOutScope, skipped: Task[]): NextTaskOutcome {
  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM tasks WHERE ${scope.column} = ? AND status NOT IN ('done', 'cancelled')`,
    )
    .get(scope.id) as { cnt: number };

  if (remaining.cnt === 0) {
    return { task: null, reason: "all_done" };
  }

  return { task: null, reason: "all_blocked", blocked_on: skipped.map((t) => t.id) };
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

  // No fresh pending work - see if an in_progress task's lock has expired
  // (its session died or never completed) and can be automatically reclaimed.
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
    return handOut(db, reclaimable, nowIso, null);
  }

  return exhausted(db, scope, pendingTasks);
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

  for (const item of items) {
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
    // reclaim branch, `IS NOT NULL` included, because an in_progress task with
    // no lease was never handed out by this path and is not this path's to take
    // back. String comparison, not Date parsing: these are all
    // `toISOString()` output, fixed-width UTC, so lexicographic order is
    // chronological order - the same assumption the SQL above already makes.
    if (task.lock_expires_at !== null && task.lock_expires_at < nowIso) {
      return handOut(db, task, nowIso, null);
    }
  }

  return exhausted(db, scope, blocked);
}

/**
 * Hands out the next task to work, marking it in_progress under a fresh lease.
 *
 * Unscoped (no `releaseRef`) it behaves as it always has: project-wide,
 * priority order, the stale-lock reclaim, all_done/all_blocked. It gains one
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
