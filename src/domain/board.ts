import type { DatabaseInstance } from "../db/connection.js";
import { listEpics } from "./epics.js";
import { getPlan, type PlanStatus } from "./plans.js";
import { isDocDrifted, requireProject } from "./projects.js";
import { listReleases, type ReleaseStatus } from "./releases.js";
import { listSlicesForTasks, type SlicePhase, type SliceStatus } from "./slices.js";
import { displayStatus, LOCK_LEASE_MS, UNMET_DEPENDENCY_SQL, type DisplayStatus } from "./taskStatus.js";
import { taskCode, type Task } from "./tasks.js";

/**
 * A slice (TTM-83), trimmed to what the board's "Slices N/M" button and
 * dialog need - between the full TaskSlice (task_id/ref/brief/exit_criterion/
 * started_at/completed_at/created_at/updated_at are agent-facing detail the
 * dashboard never renders) and nothing at all.
 */
export interface BoardSlice {
  id: string;
  label: string;
  phase: SlicePhase;
  step: number;
  position: number;
  title: string;
  status: SliceStatus;
  model: string | null;
  result: string | null;
  artifacts: string[];
  metrics: Record<string, unknown> | null;
}

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  status: DisplayStatus;
  priority: number;
  epic_id: string | null;
  epic_name: string | null;
  owner_session_id: string | null;
  is_stale: boolean;
  /**
   * When the stale lock's lease was last granted or renewed (TTM-78):
   * `lock_expires_at - LOCK_LEASE_MS`, i.e. the last hand-out, claim or slice
   * write. Set only when `is_stale`, null otherwise. Derived from the task row
   * rather than a per-task activity query, so it ignores the writes that do not
   * renew a lease (add_handoff_note, amend_task) - the card reads it as "no
   * activity since", meaning no lease-renewing activity.
   */
  stale_since: string | null;
  task_number: number;
  // Step/position order, same as listTaskSlices; [] for an unsliced task.
  // The dialog re-groups this by phase then step client-side (see board.js).
  slices: BoardSlice[];
  // The unmet dependencies that make this task `blocked` (TTM-97), ordered by
  // code. Filled only when `status === "blocked"`, so a card can never show
  // "Blocked by" chips under a status that says otherwise: an in_progress task
  // whose dependency was re-opened still has an unmet one, but displayStatus
  // does not call it blocked, and neither does this list. [] otherwise.
  blocked_by: BoardBlocker[];
}

/**
 * One unmet dependency of a blocked task. `code` uses the blocker's *own*
 * project's prefix (a dependency may cross projects), and the blocker may sit
 * in any release or none - the card links to it wherever it is.
 */
export interface BoardBlocker {
  id: string;
  code: string;
  title: string;
  status: DisplayStatus;
}

/**
 * One item's place in the lane's plan - the ordering only. No title, code or
 * status: `lane.tasks` already carries all three (see BoardTask), keyed by
 * this same `task_id`, so the popup joins against it instead of the payload
 * carrying a second copy of two fields that change under the plan's feet
 * between one 1.5s poll and the next.
 */
export interface BoardPlanItem {
  task_id: string;
  step: number;
  note: string;
  /**
   * added_at > approved_at, computed here rather than read off PlanItem
   * (which doesn't carry it either) - see schema.ts's release_plan_items
   * comment for why this is never stored. false whenever the plan isn't
   * currently approved (approved_at null): "new since approval" presumes an
   * approval to be new *since*.
   */
  new_since_approval: boolean;
}

/**
 * The lane's execution plan (TTM-66/67), shaped for the popup rather than
 * re-exporting plans.ts's ReleasePlan verbatim: `orphaned_task_ids` is left
 * off on purpose - an orphaned item's task already left this lane's `tasks`,
 * so the popup would have nothing to join it against, unlike
 * `unplanned_task_ids` (still in the batch, just missing from the plan),
 * which lane.tasks can render as "not yet in the plan".
 */
export interface BoardPlan {
  status: PlanStatus;
  rationale: string;
  approved_by: string | null;
  approval_note: string | null;
  approved_at: string | null;
  drifted: boolean;
  unplanned_task_ids: string[];
  items: BoardPlanItem[];
}

export interface BoardLane {
  release_id: string | null;
  release_version: string | null;
  release_name: string | null;
  // Imported rather than re-spelled as a literal union: this field used to
  // duplicate ReleaseStatus by hand and silently fell behind it when a third
  // status was added.
  release_status: ReleaseStatus | null;
  release_notes: string | null;
  release_cancellation_reason: string | null;
  tasks: BoardTask[];
  // null for the Backlog lane (no release, so nothing to plan) and for a
  // release nobody has written a plan for yet - "no plan" is an ordinary
  // answer here too, matching getPlan's own return type.
  plan: BoardPlan | null;
}

export interface BoardData {
  project_id: string;
  project_name: string;
  project_code_prefix: string;
  doc_drift: boolean;
  lanes: BoardLane[];
}

/**
 * A task is "stale" once its lock has gone a whole lease (LOCK_LEASE_MS in
 * taskStatus.ts, 2 h) with no tracker activity that renews it - no hand-out,
 * claim or slice write (TTM-78). It is the same condition get_next_task's
 * reclaim checks, surfaced early. A signal for a human, not a verdict: elapsed
 * time cannot tell a dead session from a paused one (usage limit, overnight,
 * waiting on the owner), which is also why a reclaim carries reclaimed_from.
 */
function isStale(task: Task, nowIso: string): boolean {
  return task.status === "in_progress" && task.lock_expires_at !== null && task.lock_expires_at < nowIso;
}

/**
 * Every unmet dependency of every task in the project, keyed by the dependent
 * task's id - one query per board, never one per task (the board can list
 * hundreds of tasks per 1.5s poll; see listSlicesForTasks for the same shape).
 * "Unmet" is UNMET_DEPENDENCY_SQL, the predicate hasUnmetDependencies uses to
 * derive `blocked`. A blocker's own status is reported as stored: an unmet
 * dependency is pending or in_progress by that same predicate.
 */
function listUnmetBlockers(db: DatabaseInstance, projectId: string): Map<string, BoardBlocker[]> {
  const rows = db
    .prepare(
      `SELECT td.task_id AS dependent_id, t.id, t.title, t.status, t.task_number, p.code_prefix
       FROM task_dependencies td
       JOIN tasks d ON d.id = td.task_id
       JOIN tasks t ON t.id = td.depends_on_task_id
       JOIN projects p ON p.id = t.project_id
       WHERE d.project_id = ? AND ${UNMET_DEPENDENCY_SQL}
       ORDER BY td.task_id ASC, p.code_prefix ASC, t.task_number ASC`,
    )
    .all(projectId) as Array<{
    dependent_id: string;
    id: string;
    title: string;
    status: DisplayStatus;
    task_number: number;
    code_prefix: string;
  }>;

  const byTaskId = new Map<string, BoardBlocker[]>();
  for (const row of rows) {
    const list = byTaskId.get(row.dependent_id) ?? [];
    list.push({
      id: row.id,
      code: taskCode(row.code_prefix, row.task_number),
      title: row.title,
      status: row.status,
    });
    byTaskId.set(row.dependent_id, list);
  }
  return byTaskId;
}

/**
 * Shapes a release's plan (if it has one) for the board - see BoardPlan for
 * what is deliberately left out. `drifted` is folded from the same two lists
 * getPlan already computed (planDrift, in plans.ts) rather than a second call
 * to isPlanDrifted, which would just re-run that query.
 */
function toBoardPlan(db: DatabaseInstance, projectId: string, releaseId: string): BoardPlan | null {
  const plan = getPlan(db, projectId, releaseId);
  if (!plan) return null;

  return {
    status: plan.status,
    rationale: plan.rationale,
    approved_by: plan.approved_by,
    approval_note: plan.approval_note,
    approved_at: plan.approved_at,
    drifted: plan.unplanned_task_ids.length > 0 || plan.orphaned_task_ids.length > 0,
    unplanned_task_ids: plan.unplanned_task_ids,
    items: plan.items.map((item) => ({
      task_id: item.task_id,
      step: item.step,
      note: item.note,
      new_since_approval: plan.approved_at !== null && item.added_at > plan.approved_at,
    })),
  };
}

/**
 * Read-only aggregation for the dashboard (REQUIREMENTS.md Item 8): groups a
 * project's tasks into swimlanes by release (a "no release"/Backlog lane
 * always first, then one per release newest-sequence-first), and shapes each task with
 * exactly the fields the board needs - between TaskSummary (too little: no
 * priority/description/ownership) and TaskDetail (too much: drags in
 * file_paths/handoff_notes/acceptance_criteria, which are agent-facing detail
 * a human watching the board doesn't need).
 */
export function getBoardData(db: DatabaseInstance, projectRef: string): BoardData {
  const project = requireProject(db, projectRef);
  const nowIso = new Date().toISOString();

  const tasks = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC`)
    .all(project.id) as Task[];
  const releases = listReleases(db, project.id);
  const epicNameById = new Map(listEpics(db, project.id).map((epic) => [epic.id, epic.name]));
  // One query for every task's slices, not one per task (see
  // listSlicesForTasks) - the board can list hundreds of tasks per poll.
  const slicesByTaskId = listSlicesForTasks(db, tasks, project.code_prefix);
  const blockersByTaskId = listUnmetBlockers(db, project.id);

  const toBoardTask = (task: Task): BoardTask => {
    const status = displayStatus(db, task);
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status,
      priority: task.priority,
      epic_id: task.epic_id,
      epic_name: task.epic_id ? (epicNameById.get(task.epic_id) ?? null) : null,
      owner_session_id: task.owner_session_id,
      is_stale: isStale(task, nowIso),
      stale_since: isStale(task, nowIso)
        ? new Date(Date.parse(task.lock_expires_at!) - LOCK_LEASE_MS).toISOString()
        : null,
      task_number: task.task_number,
      slices: (slicesByTaskId.get(task.id) ?? []).map((slice) => ({
        id: slice.id,
        label: slice.label,
        phase: slice.phase,
        step: slice.step,
        position: slice.position,
        title: slice.title,
        status: slice.status,
        model: slice.model,
        result: slice.result,
        artifacts: slice.artifacts,
        metrics: slice.metrics,
      })),
      blocked_by: status === "blocked" ? (blockersByTaskId.get(task.id) ?? []) : [],
    };
  };

  const lanes: BoardLane[] = [];

  const unreleasedTasks = tasks.filter((task) => task.release_id === null).map(toBoardTask);
  // Always show the "no release" (Backlog) lane first, even when empty - it's
  // a fixed landmark at the top of the board, not something that should
  // appear/disappear as tasks get assigned to releases.
  lanes.push({
    release_id: null,
    release_version: null,
    release_name: null,
    release_status: null,
    release_notes: null,
    release_cancellation_reason: null,
    tasks: unreleasedTasks,
    plan: null,
  });

  // listReleases orders oldest/lowest-sequence first (needed as-is for
  // list_releases and status aggregation); the board instead wants the most
  // recent release directly under Backlog, so reverse a local copy just for
  // lane ordering.
  for (const release of [...releases].reverse()) {
    lanes.push({
      release_id: release.id,
      release_version: release.version,
      release_name: release.name,
      release_status: release.status,
      release_notes: release.release_notes,
      // Mutually exclusive with release_notes in practice (a cancelled
      // release never reaches release_it, which is what generates those), but
      // carried as its own field rather than folded into release_notes so the
      // dashboard can label it as what it is.
      release_cancellation_reason: release.cancellation_reason,
      tasks: tasks.filter((task) => task.release_id === release.id).map(toBoardTask),
      plan: toBoardPlan(db, project.id, release.id),
    });
  }

  return {
    project_id: project.id,
    project_name: project.name,
    project_code_prefix: project.code_prefix,
    doc_drift: isDocDrifted(project),
    lanes,
  };
}
