import type { DatabaseInstance } from "../db/connection.js";

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
export function addDependency(db: DatabaseInstance, taskId: string, dependsOnTaskId: string): void {
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
