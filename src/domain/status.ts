import type { DatabaseInstance } from "../db/connection.js";
import { requireEpic, listEpics, type Epic } from "./epics.js";
import { listHandoffNotes, type HandoffNote } from "./handoffNotes.js";
import { isDocDrifted, requireProject } from "./projects.js";
import { listReleases, requireRelease, type Release } from "./releases.js";
import { listTaskFilePaths, requireTask, type Task } from "./tasks.js";

export type DisplayStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

export interface TaskSummary {
  id: string;
  title: string;
  status: DisplayStatus;
  estimated_tokens: number;
  epic_id: string | null;
  release_id: string | null;
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

type NextTaskOutcome =
  | { task: TaskDetail }
  | { task: null; reason: "all_done" }
  | { task: null; reason: "all_blocked"; blocked_on: string[] };

export type GetNextTaskResult = NextTaskOutcome & { doc_drift: boolean };

export interface TaskDetail extends Task {
  file_paths: string[];
  handoff_notes: HandoffNote[];
}

/**
 * The "compact task packet" the architecture doc's data flow promises from
 * get_next_task (files, acceptance criteria, prior handoff notes) - composes
 * requireTask/listTaskFilePaths (tasks.ts) with listHandoffNotes
 * (handoffNotes.ts). Also backs the side-effect-free get_task MCP tool.
 */
export function getTaskDetail(db: DatabaseInstance, taskId: string): TaskDetail {
  const task = requireTask(db, taskId);
  return {
    ...task,
    file_paths: listTaskFilePaths(db, taskId),
    handoff_notes: listHandoffNotes(db, taskId),
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

/**
 * `status = blocked` is never stored (see schema) - it's computed here from unmet
 * dependencies at query time, so it can't drift out of sync with the graph.
 */
export function hasUnmetDependencies(db: DatabaseInstance, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on_task_id
       WHERE td.task_id = ? AND t.status NOT IN ('done', 'cancelled')`,
    )
    .get(taskId) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Dependents of `taskId` that just became unblocked because it's no longer
 * pending work - shared by completeTask and cancelTask (lifecycle.ts), since
 * resolving a task (whether by finishing it or abandoning it) unblocks its
 * dependents the same way.
 */
export function findUnblockedDependents(db: DatabaseInstance, taskId: string): string[] {
  const dependents = db
    .prepare(`SELECT DISTINCT task_id FROM task_dependencies WHERE depends_on_task_id = ?`)
    .all(taskId) as Array<{ task_id: string }>;

  return dependents
    .filter((dep) => {
      const dependentTask = db
        .prepare(`SELECT status FROM tasks WHERE id = ?`)
        .get(dep.task_id) as { status: string } | undefined;
      return dependentTask?.status === "pending" && !hasUnmetDependencies(db, dep.task_id);
    })
    .map((dep) => dep.task_id);
}

export function displayStatus(db: DatabaseInstance, task: Pick<Task, "id" | "status">): DisplayStatus {
  if (task.status !== "pending") return task.status;
  return hasUnmetDependencies(db, task.id) ? "blocked" : "pending";
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

export function getNextTask(db: DatabaseInstance, projectRef: string): GetNextTaskResult {
  const project = requireProject(db, projectRef);

  const select = db.transaction((): NextTaskOutcome => {
    const projectId = project.id;
    const nowIso = new Date().toISOString();

    const pendingTasks = db
      .prepare(
        `SELECT * FROM tasks WHERE project_id = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC`,
      )
      .all(projectId) as Task[];

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
         WHERE project_id = ? AND status = 'in_progress'
           AND lock_expires_at IS NOT NULL AND lock_expires_at < ?
         ORDER BY lock_expires_at ASC
         LIMIT 1`,
      )
      .get(projectId, nowIso) as Task | undefined;

    if (reclaimable) {
      return handOut(db, reclaimable, nowIso, null);
    }

    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'cancelled')`,
      )
      .get(projectId) as { cnt: number };

    if (remaining.cnt === 0) {
      return { task: null, reason: "all_done" };
    }

    return { task: null, reason: "all_blocked", blocked_on: pendingTasks.map((t) => t.id) };
  });

  return { ...select(), doc_drift: isDocDrifted(project) };
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

  const summaries = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: displayStatus(db, task),
    estimated_tokens: task.estimated_tokens,
    epic_id: task.epic_id,
    release_id: task.release_id,
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
