import type { DatabaseInstance } from "../db/connection.js";
import type { Task } from "./tasks.js";

/**
 * How long a hand-out (via get_next_task), an explicit claim_task, or a
 * start_slice that starts a still-pending task holds the task before it's
 * considered stale and eligible for automatic reclaim by a later get_next_task
 * call (v2 ownership semantics - v1 only guaranteed no duplicate hand-out, see
 * the doc's Non-goals/Failure Modes).
 */
export const LOCK_LEASE_MS = 30 * 60 * 1000;

/**
 * The parts of a task's status that are *derived from the dependency graph*
 * rather than stored on the row - `blocked`, and everything that reads it.
 *
 * A leaf on purpose: it imports nothing but a type, so any module may depend on
 * it. That is the whole reason it exists. plans.ts needs `displayStatus` to
 * render an item's live status, and status.ts - which used to own these three
 * functions - now needs plans.ts, so that get_next_task can follow a batch's
 * approved plan. With the primitives still living in status.ts the two modules
 * would have to import each other; extracting the lower layer both of them
 * actually wanted keeps the graph acyclic without either one hand-rolling a
 * second copy of a query (which is how releases.ts had to escape the same trap
 * - see its `requireTaskProjectAndRelease`).
 *
 * The hand-out machinery (get_next_task, the lease constant, the aggregate
 * counts) deliberately stayed behind in status.ts: it is a *policy* over these
 * primitives rather than one of them, and it is the half that needs plans.ts.
 */
export type DisplayStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

/**
 * The one spelling of "this dependency is still unmet", as an SQL predicate
 * over a `tasks` row aliased `t` (the dependency itself). Shared by
 * hasUnmetDependencies (which derives `blocked`) and the board's blocked_by
 * lookup (board.ts), so a card can never list a blocker that the status rule
 * does not count, or miss one it does.
 */
export const UNMET_DEPENDENCY_SQL = `t.status NOT IN ('done', 'cancelled')`;

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
       WHERE td.task_id = ? AND ${UNMET_DEPENDENCY_SQL}`,
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
      const dependentTask = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(dep.task_id) as
        { status: string } | undefined;
      return dependentTask?.status === "pending" && !hasUnmetDependencies(db, dep.task_id);
    })
    .map((dep) => dep.task_id);
}

export function displayStatus(db: DatabaseInstance, task: Pick<Task, "id" | "status">): DisplayStatus {
  if (task.status !== "pending") return task.status;
  return hasUnmetDependencies(db, task.id) ? "blocked" : "pending";
}
