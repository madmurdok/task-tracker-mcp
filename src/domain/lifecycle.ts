import type { DatabaseInstance } from "../db/connection.js";
import { hasUnmetDependencies, LOCK_LEASE_MS } from "./status.js";

/**
 * Records ownership and renews the stale-lock lease (see LOCK_LEASE_MS) so an
 * actively-worked task isn't reclaimed out from under its session by a later
 * get_next_task call.
 */
export function claimTask(db: DatabaseInstance, taskId: string, sessionId: string): void {
  const now = new Date().toISOString();
  const lockExpiresAt = new Date(Date.parse(now) + LOCK_LEASE_MS).toISOString();

  const result = db
    .prepare(`UPDATE tasks SET owner_session_id = ?, lock_expires_at = ?, updated_at = ? WHERE id = ?`)
    .run(sessionId, lockExpiresAt, now, taskId);

  if (result.changes === 0) {
    throw new Error(`Unknown task_id: ${taskId}`);
  }
}

export interface CompleteTaskResult {
  unblocked_task_ids: string[];
}

export function completeTask(db: DatabaseInstance, taskId: string): CompleteTaskResult {
  const run = db.transaction((): CompleteTaskResult => {
    const task = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(taskId);
    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }

    db.prepare(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      taskId,
    );

    const dependents = db
      .prepare(`SELECT DISTINCT task_id FROM task_dependencies WHERE depends_on_task_id = ?`)
      .all(taskId) as Array<{ task_id: string }>;

    const unblocked = dependents
      .filter((dep) => {
        const dependentTask = db
          .prepare(`SELECT status FROM tasks WHERE id = ?`)
          .get(dep.task_id) as { status: string } | undefined;
        return dependentTask?.status === "pending" && !hasUnmetDependencies(db, dep.task_id);
      })
      .map((dep) => dep.task_id);

    return { unblocked_task_ids: unblocked };
  });

  return run();
}
