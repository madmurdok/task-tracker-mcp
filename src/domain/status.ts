import type { DatabaseInstance } from "../db/connection.js";
import type { Task } from "./tasks.js";

export type DisplayStatus = "pending" | "in_progress" | "blocked" | "done";

export interface TaskSummary {
  id: string;
  title: string;
  status: DisplayStatus;
  estimated_tokens: number;
}

export interface ProjectStatus {
  total: number;
  done: number;
  in_progress: number;
  blocked: number;
  pending: number;
  percent: number;
}

export type GetNextTaskResult =
  | { task: Task }
  | { task: null; reason: "all_done" }
  | { task: null; reason: "all_blocked"; blocked_on: string[] };

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
       WHERE td.task_id = ? AND t.status != 'done'`,
    )
    .get(taskId) as { cnt: number };
  return row.cnt > 0;
}

export function displayStatus(db: DatabaseInstance, task: Pick<Task, "id" | "status">): DisplayStatus {
  if (task.status !== "pending") return task.status;
  return hasUnmetDependencies(db, task.id) ? "blocked" : "pending";
}

export function getNextTask(db: DatabaseInstance, projectId: string): GetNextTaskResult {
  const select = db.transaction((): GetNextTaskResult => {
    const pendingTasks = db
      .prepare(
        `SELECT * FROM tasks WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      )
      .all(projectId) as Task[];

    for (const candidate of pendingTasks) {
      if (!hasUnmetDependencies(db, candidate.id)) {
        const updatedAt = new Date().toISOString();
        db.prepare(`UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`).run(
          updatedAt,
          candidate.id,
        );
        return { task: { ...candidate, status: "in_progress", updated_at: updatedAt } };
      }
    }

    const remaining = db
      .prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE project_id = ? AND status != 'done'`)
      .get(projectId) as { cnt: number };

    if (remaining.cnt === 0) {
      return { task: null, reason: "all_done" };
    }

    return { task: null, reason: "all_blocked", blocked_on: pendingTasks.map((t) => t.id) };
  });

  return select();
}

export function listTasks(
  db: DatabaseInstance,
  projectId: string,
  statusFilter?: DisplayStatus,
): TaskSummary[] {
  const tasks = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId) as Task[];

  const summaries = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: displayStatus(db, task),
    estimated_tokens: task.estimated_tokens,
  }));

  return statusFilter ? summaries.filter((s) => s.status === statusFilter) : summaries;
}

export function getProjectStatus(db: DatabaseInstance, projectId: string): ProjectStatus {
  const tasks = db
    .prepare(`SELECT id, status FROM tasks WHERE project_id = ?`)
    .all(projectId) as Array<Pick<Task, "id" | "status">>;

  const counts: ProjectStatus = {
    total: tasks.length,
    done: 0,
    in_progress: 0,
    blocked: 0,
    pending: 0,
    percent: 0,
  };

  for (const task of tasks) {
    const status = displayStatus(db, task);
    counts[status] += 1;
  }

  counts.percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);

  return counts;
}
