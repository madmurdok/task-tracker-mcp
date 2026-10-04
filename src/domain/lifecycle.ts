import type { DatabaseInstance } from "../db/connection.js";
import { requireProject } from "./projects.js";
import { describeSlice, listOpenSlices, type TaskSlice } from "./slices.js";
import { requireTask, resolveTaskId, withCode, withCodes } from "./tasks.js";
import { requireRelease } from "./releases.js";
import { LOCK_LEASE_MS } from "./status.js";
import { findUnblockedDependents, hasUnmetDependencies } from "./taskStatus.js";
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

/**
 * Raised when claim_task is called directly on a task that's done/cancelled -
 * there's nothing left to claim.
 */
export class TaskNotClaimableError extends Error {
  constructor(
    message: string,
    public readonly status: string,
  ) {
    super(message);
    this.name = "TaskNotClaimableError";
  }
}

/**
 * Raised when claim_task is called directly on a pending task that still has
 * unmet dependencies - the same gate get_next_task applies to its own
 * candidate query, so a direct claim can't bypass the dependency graph.
 */
export class TaskBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskBlockedError";
  }
}

function isLockActive(lockExpiresAt: string | null, nowIso: string): boolean {
  return lockExpiresAt !== null && lockExpiresAt >= nowIso;
}

/**
 * Takes a task into work directly, by id: records ownership, renews the
 * stale-lock lease (see LOCK_LEASE_MS), and - unlike the pre-fix version of
 * this function - moves a still-`pending` task to `in_progress` itself
 * (mirroring what get_next_task's handOut does), gated by the same
 * hasUnmetDependencies check so a direct claim can't skip ahead of an
 * unresolved dependency. This is the direct-pick counterpart to
 * get_next_task's queue-pull: an orchestrator/human assigning a *specific*
 * task to a *specific* parallel worker, instead of taking whatever's next in
 * priority order.
 *
 * Rejects with TaskNotClaimableError if the task is done/cancelled, with
 * TaskBlockedError if it's pending with unmet dependencies, and with
 * TaskConflictError if a different session currently holds an active
 * (non-expired) lock on it.
 */
export function claimTask(db: DatabaseInstance, taskRef: string, sessionId: string): void {
  const taskId = resolveTaskId(db, taskRef);
  const now = new Date().toISOString();
  const lockExpiresAt = new Date(Date.parse(now) + LOCK_LEASE_MS).toISOString();

  const run = db.transaction(() => {
    const task = db
      .prepare(`SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?`)
      .get(taskId) as
      | { status: string; owner_session_id: string | null; lock_expires_at: string | null }
      | undefined;

    if (!task) {
      throw new Error(`Unknown task_id: ${taskId}`);
    }

    if (task.status === "done" || task.status === "cancelled") {
      throw new TaskNotClaimableError(`Task ${taskId} is already ${task.status}, nothing to claim`, task.status);
    }

    if (task.status === "pending" && hasUnmetDependencies(db, taskId)) {
      throw new TaskBlockedError(`Task ${taskId} is blocked by unmet dependencies`);
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
      `UPDATE tasks SET status = 'in_progress', owner_session_id = ?, lock_expires_at = ?, updated_at = ? WHERE id = ?`,
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
  const { task_id: taskRef, session_id: sessionId, force = false } = input;
  const taskId = resolveTaskId(db, taskRef);
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

/**
 * Ends the leases of every task the given session still holds, for the
 * SessionEnd hook (docs/design/TTM-100-session-end.md, sections 2-3).
 *
 * Expire, not release: the row stays `in_progress` with its owner, and only
 * `lock_expires_at` moves to `now - 1 ms`, so the next get_next_task reclaims
 * it with `reclaimed_from` (TTM-78) and a resumed session's slice write renews
 * it. The 1 ms lets a reclaim in the same millisecond see `lock_expires_at <
 * now`; `MIN` never moves an already-lapsed lease later; `IS NOT NULL` mirrors
 * renewLease (a legacy NULL-lease row stays unreclaimable). `updated_at` is
 * deliberately untouched: a session ending is not work on the task.
 *
 * Returns the expired tasks' codes (e.g. `TTM-100`).
 */
export function expireSessionLeases(db: DatabaseInstance, sessionId: string, nowIso: string): string[] {
  const endedAt = new Date(new Date(nowIso).getTime() - 1).toISOString();
  const rows = db
    .prepare(
      `UPDATE tasks SET lock_expires_at = MIN(lock_expires_at, ?)
       WHERE owner_session_id = ? AND status = 'in_progress' AND lock_expires_at IS NOT NULL
       RETURNING project_id, task_number`,
    )
    .all(endedAt, sessionId) as Array<{ project_id: string; task_number: number }>;
  return withCodes(db, rows).map((row) => row.code);
}

export interface CompleteTaskResult {
  unblocked_task_ids: string[];
  /**
   * Declared paths verification passed without checking (outside the
   * project's git repository). Present only when non-empty; absent on a
   * forced completion, which runs no verification at all.
   */
  unverified_paths?: string[];
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

/**
 * Raised when complete_task is called on a task whose slicing (TTM-83) still
 * has slices pending or in progress. A task is worked as its slices, so
 * "done" with some of them never run is a claim the record contradicts.
 * `force` skips this the same way it skips verification - it is the explicit
 * "I know, finish it anyway".
 */
export class OpenSlicesError extends Error {
  constructor(
    message: string,
    public readonly openSlices: TaskSlice[],
  ) {
    super(message);
    this.name = "OpenSlicesError";
  }
}

export function completeTask(
  db: DatabaseInstance,
  verifier: CompletionVerifier,
  input: CompleteTaskInput,
): CompleteTaskResult {
  const { task_id: taskRef, summary, test_command: testCommand, force = false } = input;
  const taskId = resolveTaskId(db, taskRef);

  const task = db.prepare(`SELECT project_id, created_at FROM tasks WHERE id = ?`).get(taskId) as
    | { project_id: string; created_at: string }
    | undefined;
  if (!task) {
    throw new Error(`Unknown task_id: ${taskId}`);
  }

  let unverifiedPaths: string[] = [];
  if (!force) {
    // Before verification, not after: it is free, and verification may run a
    // test_command that would be wasted on a completion refused anyway.
    const open = listOpenSlices(db, taskId);
    if (open.length > 0) {
      const { code } = withCode(db, requireTask(db, taskId));
      throw new OpenSlicesError(
        `Task ${code} has open slices: ${open.map(describeSlice).join(", ")}; complete, fail or skip them, or pass force`,
        open,
      );
    }

    const project = db
      .prepare(`SELECT root_path FROM projects WHERE id = ?`)
      .get(task.project_id) as { root_path: string };
    const filePaths = (
      db.prepare(`SELECT file_path FROM task_files WHERE task_id = ?`).all(taskId) as Array<{
        file_path: string;
      }>
    ).map((row) => row.file_path);

    // created_at, not the claim timestamp: it's the one task timestamp that
    // never moves forward, so it can't end up after the commits it bounds
    // (see GitDiffCompletionVerifier.checkFilesChanged).
    const result = verifier.verify({
      rootPath: project.root_path,
      filePaths,
      testCommand,
      changesSinceIso: task.created_at,
    });
    if (!result.passed) {
      throw new CompletionVerificationError(
        `Verification failed for task ${taskId}: ${result.reason}`,
        result.reason,
      );
    }
    unverifiedPaths = result.uncheckedPaths ?? [];
  }

  const run = db.transaction((): CompleteTaskResult => {
    // lock_expires_at cleared, owner_session_id deliberately KEPT - the two
    // columns mean different things and only one of them is untrue here.
    //
    // A lease means "may be reclaimed once this passes". On a finished task
    // there is nothing to reclaim, so leaving it set states something false
    // that goes on expiring forever. `owner_session_id` is the opposite: on a
    // done task it is real provenance - which session finished this - and the
    // dashboard already renders it on the card. So this is not the same write
    // as cancelTask's, which clears both: a cancelled task has no completion
    // to attribute.
    //
    // Left set, the falsehood was reachable rather than theoretical. Nothing
    // exploits it today (getNextTask's reclaim branch and board.ts's isStale
    // both filter `status = 'in_progress'`), but the plan walker in status.ts
    // is a single pass whose lease check has no status filter of its own - its
    // explicit done/cancelled skip was the only thing standing between a
    // lapsed lease on a completed task and that task being handed straight
    // back out. This restores that skip to belt-and-braces; both stay.
    db.prepare(
      `UPDATE tasks SET status = 'done', completion_summary = ?, lock_expires_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(summary ?? null, new Date().toISOString(), taskId);

    return {
      unblocked_task_ids: findUnblockedDependents(db, taskId),
      ...(unverifiedPaths.length > 0 ? { unverified_paths: unverifiedPaths } : {}),
    };
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

  // Both terminal statuses are one-shot: a shipped release can't ship twice,
  // and a cancelled one was deliberately taken off the table (cancelRelease
  // below has no un-cancel, so this isn't a state anything can back out of).
  if (release.status === "released" || release.status === "cancelled") {
    throw new Error(`Release ${releaseRef} is already ${release.status}`);
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

export interface CancelReleaseInput {
  project_id: string;
  release_id: string;
  reason: string;
}

/**
 * Records a release as built-but-deliberately-not-shipped: the release_it
 * counterpart to cancel_task's relationship with complete_task. Without it a
 * batch that was measured and rejected (or a branch that will never be merged)
 * sits at 100% done and `planned` forever, and the only honest-looking way to
 * clear it off the board is to lie about it with release_it.
 *
 * `reason` is mandatory here, unlike cancelTask's optional one: a cancelled
 * *task* usually reads as self-explanatory next to its siblings, while a
 * cancelled *release* is a whole batch of finished work being written off, and
 * "why" is the entire value of the record afterwards. It's also all the
 * dashboard has to show for that lane - a cancelled release never reaches
 * release_it, so it has no generated release_notes.
 *
 * One-shot in both directions: rejects a release that already shipped (its
 * notes are published, cancelling after the fact would be a false record) and
 * one already cancelled, mirroring cancelTask's "already X, nothing to
 * cancel". There is deliberately no un-cancel, same as cancel_task.
 *
 * Note what this does *not* do: nothing happens to the release's tasks. A
 * cancelled release keeps its membership as the record of what was abandoned,
 * and its still-open tasks stay claimable - work that turns out salvageable is
 * moved into a later release with set_task_release (allowed outbound; see
 * setTaskRelease), not resurrected here.
 */
export function cancelRelease(db: DatabaseInstance, input: CancelReleaseInput): void {
  const { project_id: projectRef, release_id: releaseRef, reason } = input;

  const project = requireProject(db, projectRef);
  const release = requireRelease(db, project.id, releaseRef);

  if (release.status === "released" || release.status === "cancelled") {
    throw new Error(`Release ${releaseRef} is already ${release.status}, nothing to cancel`);
  }

  const run = db.transaction(() => {
    db.prepare(`UPDATE releases SET status = 'cancelled', cancellation_reason = ? WHERE id = ?`).run(
      reason,
      release.id,
    );
  });
  run();
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
 * hasUnmetDependencies in taskStatus.ts). There's no session_id parameter here
 * (unlike claim/release), so the conflict check is owner-agnostic: any active
 * lock blocks a plain cancel_task call, `force` overrides it regardless of
 * who holds it.
 */
export function cancelTask(db: DatabaseInstance, input: CancelTaskInput): CancelTaskResult {
  const { task_id: taskRef, reason, force = false } = input;
  const taskId = resolveTaskId(db, taskRef);
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
