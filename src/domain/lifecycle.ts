import type { DatabaseInstance } from "../db/connection.js";
import { requireProject } from "./projects.js";
import { requireRelease } from "./releases.js";
import { findUnblockedDependents, LOCK_LEASE_MS } from "./status.js";
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
  summary?: string;
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
  const { task_id: taskId, summary, test_command: testCommand, force = false } = input;

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
    db.prepare(
      `UPDATE tasks SET status = 'done', completion_summary = ?, updated_at = ? WHERE id = ?`,
    ).run(summary ?? null, new Date().toISOString(), taskId);

    return { unblocked_task_ids: findUnblockedDependents(db, taskId) };
  });

  return run();
}

/**
 * Raised when release_it's "every task done or cancelled" gate isn't met.
 * Deliberately not skippable by `force` (see ReleaseItInput) - unlike a
 * missing/failing test gate, shipping unfinished work isn't something to
 * override.
 */
export class ReleaseNotAllDoneError extends Error {
  constructor(
    message: string,
    public readonly pendingTaskIds: string[],
  ) {
    super(message);
    this.name = "ReleaseNotAllDoneError";
  }
}

export interface ReleaseItInput {
  project_id: string;
  release_id: string;
  test_command?: string;
  force?: boolean;
}

export interface ReleaseItResult {
  release_notes: string;
  released_at: string;
}

/**
 * Ships a release: gates on every one of its tasks being done or cancelled
 * (not force-skippable), then on a test run (force-skippable, but not
 * silently - test_command is required unless force is given, so omitting
 * both is an error rather than a no-op pass), then generates release notes
 * from the done tasks (plus a Cancelled section for cancelled ones) and marks
 * the release released. One-shot, like complete_task has no "un-complete."
 *
 * Reuses the same CompletionVerifier complete_task uses - filePaths: [] skips
 * its git-diff check entirely (see GitDiffCompletionVerifier.verify), running
 * only testCommand, so no separate "release verifier" abstraction is needed.
 * Both the missing-test_command and the failed-test_command cases surface as
 * CompletionVerificationError, matching complete_task's verification_failed
 * shape at the MCP layer.
 */
export function releaseIt(
  db: DatabaseInstance,
  verifier: CompletionVerifier,
  input: ReleaseItInput,
): ReleaseItResult {
  const { project_id: projectRef, release_id: releaseRef, test_command: testCommand, force = false } = input;

  const project = requireProject(db, projectRef);
  const release = requireRelease(db, project.id, releaseRef);

  if (release.status === "released") {
    throw new Error(`Release ${releaseRef} is already released`);
  }

  const notDone = db
    .prepare(`SELECT id FROM tasks WHERE release_id = ? AND status NOT IN ('done', 'cancelled')`)
    .all(release.id) as Array<{ id: string }>;
  if (notDone.length > 0) {
    throw new ReleaseNotAllDoneError(
      `Release ${releaseRef} has ${notDone.length} task(s) not done or cancelled`,
      notDone.map((t) => t.id),
    );
  }

  if (!force) {
    if (!testCommand) {
      throw new CompletionVerificationError(
        "release_it requires a test_command or force:true to skip the test gate",
        "test_command required unless force is given",
      );
    }
    const result = verifier.verify({ rootPath: project.root_path, filePaths: [], testCommand });
    if (!result.passed) {
      throw new CompletionVerificationError(
        `Test gate failed for release ${releaseRef}: ${result.reason}`,
        result.reason,
      );
    }
  }

  const doneTasks = db
    .prepare(
      `SELECT title, completion_summary FROM tasks WHERE release_id = ? AND status = 'done' ORDER BY updated_at ASC`,
    )
    .all(release.id) as Array<{ title: string; completion_summary: string | null }>;
  const cancelledTasks = db
    .prepare(
      `SELECT title, cancellation_reason FROM tasks WHERE release_id = ? AND status = 'cancelled' ORDER BY updated_at ASC`,
    )
    .all(release.id) as Array<{ title: string; cancellation_reason: string | null }>;

  let notes = doneTasks
    .map((t) => `- ${t.title}${t.completion_summary ? `: ${t.completion_summary}` : ""}`)
    .join("\n");
  if (cancelledTasks.length > 0) {
    const cancelledLines = cancelledTasks
      .map((t) => `- ${t.title}${t.cancellation_reason ? `: ${t.cancellation_reason}` : ""}`)
      .join("\n");
    notes += `${notes ? "\n\n" : ""}Cancelled:\n${cancelledLines}`;
  }

  const releasedAt = new Date().toISOString();

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE releases SET status = 'released', release_notes = ?, released_at = ? WHERE id = ?`,
    ).run(notes, releasedAt, release.id);
  });
  run();

  return { release_notes: notes, released_at: releasedAt };
}

export interface CancelTaskInput {
  task_id: string;
  reason?: string;
  force?: boolean;
}

export interface CancelTaskResult {
  unblocked_task_ids: string[];
}

/**
 * Abandons a task that turns out unnecessary, without the dishonesty of a
 * force-completed complete_task call. Clears ownership/lock the same way
 * releaseTask does (a cancelled task isn't being worked by anyone), and
 * unblocks dependents the same way completeTask does - a cancelled
 * prerequisite is resolved, not stuck, from a dependent's point of view (see
 * hasUnmetDependencies in status.ts). There's no session_id parameter here
 * (unlike claim/release), so the conflict check is owner-agnostic: any active
 * lock blocks a plain cancel_task call, `force` overrides it regardless of
 * who holds it.
 */
export function cancelTask(db: DatabaseInstance, input: CancelTaskInput): CancelTaskResult {
  const { task_id: taskId, reason, force = false } = input;
  const now = new Date().toISOString();

  const run = db.transaction((): CancelTaskResult => {
    const task = db
      .prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(taskId) as
      | { status: string; owner_session_id: string | null; lock_expires_at: string | null }
      | undefined;

    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }
    if (task.status === "done" || task.status === "cancelled") {
      throw new Error(`Task ${taskId} is already ${task.status}, nothing to cancel`);
    }

    if (!force && task.owner_session_id !== null && isLockActive(task.lock_expires_at, now)) {
      throw new TaskConflictError(
        `Task ${taskId} is currently held by session ${task.owner_session_id}; pass force to override`,
        task.owner_session_id,
        task.lock_expires_at,
      );
    }

    db.prepare(
      `UPDATE tasks SET status = 'cancelled', cancellation_reason = ?, owner_session_id = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(reason ?? null, now, taskId);

    return { unblocked_task_ids: findUnblockedDependents(db, taskId) };
  });

  return run();
}
