import type { DatabaseInstance } from "../db/connection.js";
import { hasUnmetDependencies, LOCK_LEASE_MS } from "./status.js";
import type { CompletionVerifier } from "./verification.js";

/**
 * Raised when a caller tries to claim or release a task whose lock is
 * currently held (not expired) by a *different* session - the v2 ownership
 * contention case (see A3 in the v2 ownership/locking branch). Callers that
 * want to override it anyway use `releaseTask`'s `force` option.
 */
export class TaskConflictError extends Error {
  constructor(
    message: string,
    public readonly currentOwnerSessionId: string | null,
    public readonly lockExpiresAt: string | null,
  ) {
    super(message);
    this.name = "TaskConflictError";
  }
}

function isLockActive(lockExpiresAt: string | null, nowIso: string): boolean {
  return lockExpiresAt !== null && lockExpiresAt >= nowIso;
}

/**
 * Records ownership and renews the stale-lock lease (see LOCK_LEASE_MS) so an
 * actively-worked task isn't reclaimed out from under its session by a later
 * get_next_task call. Rejects with TaskConflictError if a different session
 * currently holds an active (non-expired) lock.
 */
export function claimTask(db: DatabaseInstance, taskId: string, sessionId: string): void {
  const now = new Date().toISOString();
  const lockExpiresAt = new Date(Date.parse(now) + LOCK_LEASE_MS).toISOString();

  const run = db.transaction(() => {
    const task = db
      .prepare(`SELECT owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(taskId) as { owner_session_id: string | null; lock_expires_at: string | null } | undefined;

    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }

    if (
      task.owner_session_id !== null &&
      task.owner_session_id !== sessionId &&
      isLockActive(task.lock_expires_at, now)
    ) {
      throw new TaskConflictError(
        `Task ${taskId} is currently held by session ${task.owner_session_id}`,
        task.owner_session_id,
        task.lock_expires_at,
      );
    }

    db.prepare(
      `UPDATE tasks SET owner_session_id = ?, lock_expires_at = ?, updated_at = ? WHERE id = ?`,
    ).run(sessionId, lockExpiresAt, now, taskId);
  });

  run();
}

export interface ReleaseTaskInput {
  task_id: string;
  session_id: string;
  force?: boolean;
}

/**
 * Explicitly gives up ownership of a task (or force-reclaims someone else's),
 * putting it back to `pending` so get_next_task can hand it out again right
 * away instead of waiting for the lease to expire. Without `force`, rejects
 * with TaskConflictError if another session's lock is still active.
 */
export function releaseTask(db: DatabaseInstance, input: ReleaseTaskInput): void {
  const { task_id: taskId, session_id: sessionId, force = false } = input;
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    const task = db
      .prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(taskId) as
      | { status: string; owner_session_id: string | null; lock_expires_at: string | null }
      | undefined;

    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }
    if (task.status === "done") {
      throw new Error(`Task ${taskId} is already done, nothing to release`);
    }

    if (
      !force &&
      task.owner_session_id !== null &&
      task.owner_session_id !== sessionId &&
      isLockActive(task.lock_expires_at, now)
    ) {
      throw new TaskConflictError(
        `Task ${taskId} is currently held by session ${task.owner_session_id}; pass force to override`,
        task.owner_session_id,
        task.lock_expires_at,
      );
    }

    db.prepare(
      `UPDATE tasks SET status = 'pending', owner_session_id = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, taskId);
  });

  run();
}

export interface CompleteTaskResult {
  unblocked_task_ids: string[];
}

export interface CompleteTaskInput {
  task_id: string;
  test_command?: string;
  force?: boolean;
}

/**
 * Raised when a task's declared completion doesn't check out - the file
 * check and/or test command from CompletionVerifier failed. Pass `force` to
 * skip verification for a task that was legitimately finished some other way
 * (e.g. it turned out no code change was needed).
 */
export class CompletionVerificationError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "CompletionVerificationError";
  }
}

export function completeTask(
  db: DatabaseInstance,
  verifier: CompletionVerifier,
  input: CompleteTaskInput,
): CompleteTaskResult {
  const { task_id: taskId, test_command: testCommand, force = false } = input;

  const task = db.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(taskId) as
    | { project_id: string }
    | undefined;
  if (!task) {
    throw new Error(`Unknown task_id: ${taskId}`);
  }

  if (!force) {
    const project = db
      .prepare(`SELECT root_path FROM projects WHERE id = ?`)
      .get(task.project_id) as { root_path: string };
    const filePaths = (
      db.prepare(`SELECT file_path FROM task_files WHERE task_id = ?`).all(taskId) as Array<{
        file_path: string;
      }>
    ).map((row) => row.file_path);

    const result = verifier.verify({ rootPath: project.root_path, filePaths, testCommand });
    if (!result.passed) {
      throw new CompletionVerificationError(
        `Verification failed for task ${taskId}: ${result.reason}`,
        result.reason,
      );
    }
  }

  const run = db.transaction((): CompleteTaskResult => {
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
