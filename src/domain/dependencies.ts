import type { DatabaseInstance } from "../db/connection.js";
import { resolveTaskId } from "./tasks.js";

function isReachable(db: DatabaseInstance, fromTaskId: string, toTaskId: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [fromTaskId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === toTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = db
      .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
      .all(current) as Array<{ depends_on_task_id: string }>;
    for (const dep of deps) {
      queue.push(dep.depends_on_task_id);
    }
  }

  return false;
}

/**
 * Adds `taskId depends on dependsOnTaskId`. Rejects self-deps and anything that
 * would create a cycle (i.e. dependsOnTaskId can already, transitively, reach taskId).
 */
export function addDependency(db: DatabaseInstance, taskRef: string, dependsOnRef: string): void {
  // Resolved before the self-check below, not after: `TTM-63` and that task's
  // own uuid are the same task, and comparing the two raw strings would let a
  // self-dependency through the one guard that exists to stop it.
  const taskId = resolveTaskId(db, taskRef);
  const dependsOnTaskId = resolveTaskId(db, dependsOnRef);

  if (taskId === dependsOnTaskId) {
    throw new Error("A task cannot depend on itself");
  }

  if (isReachable(db, dependsOnTaskId, taskId)) {
    throw new Error(
      `Adding dependency ${taskId} -> ${dependsOnTaskId} would create a cycle`,
    );
  }

  db.prepare(
    "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
  ).run(taskId, dependsOnTaskId);
}
