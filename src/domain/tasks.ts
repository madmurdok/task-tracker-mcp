import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { isOverBudget, type BudgetEstimator } from "./budget.js";
import { addDependency } from "./dependencies.js";
import { requireEpic } from "./epics.js";
import { requireProject } from "./projects.js";
import { requireAssignableRelease } from "./releases.js";

export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";
export type TaskComplexityHint = "normal" | "high";

export interface Task {
  id: string;
  project_id: string;
  epic_id: string | null;
  release_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: TaskStatus;
  estimated_tokens: number;
  owner_session_id: string | null;
  lock_expires_at: string | null;
  complexity_hint: TaskComplexityHint;
  cancellation_reason: string | null;
  priority: number;
  task_number: number;
  completion_summary: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Per-project display counter behind the human-facing task code (`TTM-42`).
 * Same shape as releases.ts's nextSequence, but in steps of 1, not 10: a
 * release's sequence is a *sort key* that has to leave room for a hotfix to be
 * slotted between two existing releases (set_release_sequence), whereas a task
 * number is a plain identity - it's never reordered, and gaps in it would only
 * make people wonder which task went missing.
 *
 * Derived from MAX rather than a stored counter, which is safe against the one
 * path that deletes tasks (splitTask): it creates the replacement subtasks
 * *before* dropping the original, so they land above it and the retired number
 * stays a gap instead of being reissued to different work.
 */
export function nextTaskNumber(db: DatabaseInstance, projectId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(task_number), 0) AS max FROM tasks WHERE project_id = ?`)
    .get(projectId) as { max: number };
  return row.max + 1;
}

/**
 * The one place the `PREFIX-N` display form is spelled out, so every surface
 * that shows a task code (CLI status, dashboard board, and every task row the
 * MCP tools return) renders it identically.
 */
export function taskCode(prefix: string, taskNumber: number): string {
  return `${prefix}-${taskNumber}`;
}

export interface CreateTaskInput {
  project_id: string;
  epic_id?: string;
  release_id?: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  file_paths?: string[];
  complexity_hint: TaskComplexityHint;
  priority?: number;
}

export interface CreateTaskResult {
  task: Task;
  over_budget: boolean;
}

/**
 * A task code as a person writes it: the project's `code_prefix` and the
 * task's own `task_number`, e.g. `TTM-63`.
 *
 * Anchored and case-insensitive on the prefix, with a trailing integer. A uuid
 * also contains dashes, so the shape - not the presence of a `-` - is what
 * tells the two apart, and anything that is not this shape is treated as a
 * uuid and produces the error it always did.
 */
const TASK_CODE = /^([A-Za-z]+)-(\d+)$/;

/**
 * Turns whatever a caller passed for a task id into the uuid the rest of the
 * code expects: a uuid passes straight through, a task code is looked up.
 *
 * The uuid attempt comes first so no existing caller changes behaviour, and so
 * that a project which ever took a code-shaped uuid could not be shadowed.
 *
 * This exists because a uuid is unreadable, unsayable, and says nothing about
 * which project it belongs to - while the codes have been on the dashboard's
 * cards since `code_prefix` was added. Mirrors `requireProject`, which is the
 * single point every project-scoped function routes through so `project_id`
 * can be an id or a name.
 */
export function resolveTaskId(db: DatabaseInstance, ref: string): string {
  const direct = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(ref) as
    | { id: string }
    | undefined;
  if (direct) return direct.id;

  const match = TASK_CODE.exec(ref);
  if (!match) return ref;

  const byCode = db
    .prepare(
      `SELECT t.id FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE p.code_prefix = ? COLLATE NOCASE AND t.task_number = ?`,
    )
    .get(match[1], Number(match[2])) as { id: string } | undefined;

  // Deliberately returns `ref` rather than throwing: every caller already
  // reports its own "unknown task" in its own words, and a code that matches
  // nothing is not a different failure from a uuid that matches nothing.
  return byCode?.id ?? ref;
}

/**
 * Runs a statement that is supposed to change exactly one row, and refuses to
 * pass silently when it changed none.
 *
 * SQLite matches no row and raises nothing, so an `UPDATE ... WHERE id = ?`
 * given a reference that was resolved for a *read* four lines earlier and left
 * raw here updates nothing, returns void, and is reported to the caller as
 * success. That is how `set_task_release` accepted eleven task codes in a row,
 * answered `ok` to each, and moved none of them - visible only by looking at
 * the board afterwards.
 *
 * The wrong row count is the one thing a caller can never see and the one
 * thing the driver already knows, so it is worth one check at the write.
 */
export function runOne(
  // Typed loosely on purpose: better-sqlite3's `Statement` is generic over its
  // bind parameters, and pinning that here would make every call site spell
  // the tuple out for a helper whose whole job is the row count.
  statement: { run: (...params: never[]) => { changes: number } },
  what: string,
  ...params: unknown[]
): void {
  const { changes } = (statement.run as (...p: unknown[]) => { changes: number })(...params);
  if (changes !== 1) {
    throw new Error(`${what} matched ${changes} rows, expected exactly 1`);
  }
}

export function requireTask(db: DatabaseInstance, taskId: string): Task {
  const resolved = resolveTaskId(db, taskId);
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(resolved) as Task | undefined;
  if (!task) {
    throw new Error(`Unknown task_id: ${taskId}`);
  }
  return task;
}

/**
 * TTM-68, the inbound half: a task created straight into a release is
 * membership drift for that release's plan, if it has one - the plan's order
 * no longer covers the whole batch. Appends the task as a new final step
 * (not merged into the last one - the plan reasoned about the tasks it
 * already had, not this one) and returns the plan to draft so nothing is
 * handed out from it until a human re-approves. Appending, not any other
 * position, is what makes re-approval cheap: the common case is "it goes
 * last", which then costs the owner one word, and any other order is still
 * available by re-sending the plan with upsert_plan.
 *
 * Inlined rather than imported from plans.ts's `revertPlanToDraft` - plans.ts
 * imports this module (see its IMPORT DIRECTION comment), so importing back
 * would close a cycle that, per that comment, resolves to `undefined` at call
 * time in this project's ESM setup rather than failing at load - a much
 * worse failure to chase down than a few duplicated lines. The same
 * self-contained shape is duplicated in releases.ts for `setTaskRelease`,
 * rather than shared through the tasks.ts/releases.ts edge that already
 * exists between them, so this hook stays as disposable/inspectable as
 * `revertPlanToDraft` itself.
 *
 * A plain UPDATE ... WHERE status = 'approved', not an unconditional one: the
 * overwhelmingly common case is a release with no plan, or a plan already in
 * draft (e.g. every task after the first in a createTasks batch), and
 * neither needs a write. Never touches tasks.status/owner_session_id/
 * lock_expires_at - a revert gates handing out *new* work, not a task a
 * session already holds.
 */
function appendToPlanAndRevert(db: DatabaseInstance, releaseId: string, taskId: string): void {
  const plan = db.prepare(`SELECT id FROM release_plans WHERE release_id = ?`).get(releaseId) as
    | { id: string }
    | undefined;
  if (!plan) return;

  const { maxStep } = db
    .prepare(`SELECT COALESCE(MAX(step), 0) AS maxStep FROM release_plan_items WHERE plan_id = ?`)
    .get(plan.id) as { maxStep: number };

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO release_plan_items (plan_id, task_id, step, position, note, added_at)
     VALUES (?, ?, ?, 0, '', ?)`,
  ).run(plan.id, taskId, maxStep + 1, now);

  db.prepare(
    `UPDATE release_plans
     SET status = 'draft', approved_by = NULL, approval_note = NULL, approved_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'approved'`,
  ).run(now, plan.id);
}

/**
 * Attaches each task's code to rows on their way out of this layer.
 *
 * One prefix lookup per call rather than per row: the join would otherwise
 * have to be added to every `SELECT * FROM tasks` in the codebase, and there
 * are many. Returning the code matters more than accepting one - a client that
 * has to assemble `GM-231` from a prefix it must already know will get it
 * wrong the first time a project is renamed, and did get it wrong once by
 * hand before this existed.
 */
export function withCodes<T extends { project_id: string; task_number: number }>(
  db: DatabaseInstance,
  rows: T[],
): Array<T & { code: string }> {
  if (rows.length === 0) return [];
  const prefixes = new Map(
    (
      db.prepare(`SELECT id, code_prefix FROM projects`).all() as Array<{
        id: string;
        code_prefix: string | null;
      }>
    ).map((row) => [row.id, row.code_prefix]),
  );
  return rows.map((row) => ({
    ...row,
    code: taskCode(prefixes.get(row.project_id) ?? "?", row.task_number),
  }));
}

/** Single-row [`withCodes`], for the tools that answer with one task. */
export function withCode<T extends { project_id: string; task_number: number }>(
  db: DatabaseInstance,
  row: T,
): T & { code: string } {
  return withCodes(db, [row])[0]!;
}

export function listTaskFilePaths(db: DatabaseInstance, taskId: string): string[] {
  return (
    db
      .prepare(`SELECT file_path FROM task_files WHERE task_id = ? ORDER BY file_path`)
      .all(taskId) as Array<{ file_path: string }>
  ).map((row) => row.file_path);
}

/**
 * Deliberately its own single-purpose mutator rather than a general
 * "update_task" tool - priority is the only field that turns out to need
 * adjusting after the fact once a task's importance becomes clearer mid-project.
 */
export function setTaskPriority(db: DatabaseInstance, taskRef: string, priority: number): void {
  const taskId = requireTask(db, taskRef).id;
  runOne(
    db.prepare(`UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`),
    `set_task_priority ${taskRef}`,
    priority,
    new Date().toISOString(),
    taskId,
  );
}

export function createTask(
  db: DatabaseInstance,
  estimator: BudgetEstimator,
  input: CreateTaskInput,
): CreateTaskResult {
  const project = requireProject(db, input.project_id);
  const epicId = input.epic_id ? requireEpic(db, project.id, input.epic_id).id : null;
  const releaseId = input.release_id
    ? requireAssignableRelease(db, project.id, input.release_id).id
    : null;

  const filePaths = input.file_paths ?? [];
  const estimatedTokens = estimator.estimateTokens(project.root_path, filePaths);
  const now = new Date().toISOString();

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project_id, epic_id, release_id, title, description, acceptance_criteria, status, estimated_tokens, owner_session_id, lock_expires_at, complexity_hint, cancellation_reason, priority, task_number, completion_summary, created_at, updated_at)
     VALUES (@id, @project_id, @epic_id, @release_id, @title, @description, @acceptance_criteria, @status, @estimated_tokens, @owner_session_id, @lock_expires_at, @complexity_hint, @cancellation_reason, @priority, @task_number, @completion_summary, @created_at, @updated_at)`,
  );
  const insertFile = db.prepare(`INSERT INTO task_files (task_id, file_path) VALUES (?, ?)`);

  // task_number is read inside the transaction, not before it, so the
  // MAX(task_number) lookup and the INSERT that consumes it can't be split
  // apart by another writer handing out the same number.
  const insertAll = db.transaction((): Task => {
    const task: Task = {
      id: randomUUID(),
      project_id: project.id,
      epic_id: epicId,
      release_id: releaseId,
      title: input.title,
      description: input.description ?? "",
      acceptance_criteria: input.acceptance_criteria ?? "",
      status: "pending",
      estimated_tokens: estimatedTokens,
      owner_session_id: null,
      lock_expires_at: null,
      complexity_hint: input.complexity_hint,
      cancellation_reason: null,
      priority: input.priority ?? 0,
      task_number: nextTaskNumber(db, project.id),
      completion_summary: null,
      created_at: now,
      updated_at: now,
    };

    insertTask.run(task);
    for (const filePath of filePaths) {
      insertFile.run(task.id, filePath);
    }
    // TTM-68: created straight into a planned batch, so its plan (if any)
    // needs this task appended and, if approved, sent back to draft.
    if (releaseId) {
      appendToPlanAndRevert(db, releaseId, task.id);
    }
    return task;
  });

  return { task: insertAll(), over_budget: isOverBudget(estimatedTokens) };
}

/**
 * Hard-deletes a task: the row plus its task_files, both directions of
 * task_dependencies, and its handoff_notes, all via schema.ts's ON DELETE
 * CASCADE against tasks(id) - no explicit cleanup needed here. Restricted to
 * backlog tasks (release_id null) because a released/planned release's task
 * membership is meant to be a stable record (see requireAssignableRelease);
 * deleting a task out from under a release would silently corrupt that
 * record, whereas moving it out first (set_task_release) or cancelling it
 * (cancel_task, which just flips status) both leave an audit trail behind.
 * Deliberately no lock/ownership guard beyond that - unlike claim/complete,
 * deleting a mis-created backlog task isn't gated by who has it locked.
 */
export function deleteTask(db: DatabaseInstance, taskRef: string): void {
  const task = requireTask(db, taskRef);
  if (task.release_id !== null) {
    throw new Error(
      `Task ${taskRef} is in a release; only backlog tasks (no release) can be deleted. Move it out with set_task_release or use cancel_task instead.`,
    );
  }

  runOne(db.prepare(`DELETE FROM tasks WHERE id = ?`), `delete_task ${taskRef}`, task.id);
}

export interface SplitSubtaskInput {
  title: string;
  description?: string;
  acceptance_criteria?: string;
  file_paths?: string[];
  complexity_hint?: TaskComplexityHint;
  priority?: number;
}

export interface SplitTaskResult {
  new_task_ids: string[];
}

/**
 * Replaces `taskId` with the given subtasks: every task that depended on it now
 * depends on all the subtasks, and every subtask inherits all of its prerequisites.
 */
export function splitTask(
  db: DatabaseInstance,
  estimator: BudgetEstimator,
  taskRef: string,
  subtasks: SplitSubtaskInput[],
): SplitTaskResult {
  const run = db.transaction((): SplitTaskResult => {
    const original = requireTask(db, taskRef);
    // Everything below addresses rows by id - the dependency queries included,
    // which would silently find none for a code.
    const taskId = original.id;
    if (original.status === "done" || original.status === "cancelled") {
      throw new Error(`Cannot split task ${taskRef}: already ${original.status}`);
    }
    if (subtasks.length === 0) {
      throw new Error("split_task requires at least one subtask");
    }

    const dependents = db
      .prepare(`SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?`)
      .all(taskId) as Array<{ task_id: string }>;
    const prerequisites = db
      .prepare(`SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?`)
      .all(taskId) as Array<{ depends_on_task_id: string }>;

    const newTaskIds = subtasks.map((subtaskInput) => {
      const { complexity_hint, priority, ...rest } = subtaskInput;
      return createTask(db, estimator, {
        project_id: original.project_id,
        epic_id: original.epic_id ?? undefined,
        release_id: original.release_id ?? undefined,
        complexity_hint: complexity_hint ?? original.complexity_hint,
        priority: priority ?? original.priority,
        ...rest,
      }).task.id;
    });

    for (const dependent of dependents) {
      for (const newTaskId of newTaskIds) {
        addDependency(db, dependent.task_id, newTaskId);
      }
    }
    for (const prerequisite of prerequisites) {
      for (const newTaskId of newTaskIds) {
        addDependency(db, newTaskId, prerequisite.depends_on_task_id);
      }
    }

    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);

    return { new_task_ids: newTaskIds };
  });

  return run();
}

export interface CreateTasksSpec {
  temp_id?: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  file_paths?: string[];
  epic_id?: string;
  release_id?: string;
  complexity_hint: TaskComplexityHint;
  priority?: number;
  depends_on?: string[];
}

export interface CreateTasksResultItem {
  temp_id?: string;
  task_id: string;
  /** How a person refers to this task: `TTM-63` - see `withCodes`. */
  code: string;
  estimated_tokens: number;
  over_budget: boolean;
}

export interface CreateTasksResult {
  tasks: CreateTasksResultItem[];
}

/**
 * Plans a whole batch of tasks (e.g. from a design doc) in one call instead of
 * one create_task + one add_dependency per edge. `temp_id` is an arbitrary
 * client-chosen string scoped to this batch, letting a task's `depends_on`
 * reference a sibling created earlier in the *same* call before it has a real
 * id; an entry that isn't a known temp_id in this batch is treated as an
 * existing task_id, so a batch can also wire new tasks onto an
 * already-existing graph. Tasks are created first, in a separate pass from
 * dependency edges, so creation order within the batch never has to match
 * dependency order. Whole call runs in one transaction - a bad epic/release
 * ref or a cyclic edge rolls back the entire batch instead of leaving a
 * half-planned graph.
 *
 * TTM-68: each createTask call below carries its own plan-append (see
 * appendToPlanAndRevert), so a batch of several tasks into one planned
 * release lands every one of them as its own final step, each computing the
 * next step number fresh off the previous insert - not fighting itself, just
 * N inserts in a row. The revert side of that hook is a
 * `WHERE status = 'approved'` UPDATE, so only the first call (if the plan
 * started approved) actually changes a row; every call after it is a
 * no-op against an already-draft plan, which is what makes the whole batch
 * revert once in effect rather than thrash. And because every call happens
 * inside this function's own transaction, a spec that fails partway (a bad
 * epic/release ref, a cyclic dependency) rolls the whole thing back -
 * appended plan items included - so there is no half-appended plan left
 * behind by a batch that didn't fully land.
 */
export function createTasks(
  db: DatabaseInstance,
  estimator: BudgetEstimator,
  projectId: string,
  specs: CreateTasksSpec[],
): CreateTasksResult {
  const seenTempIds = new Set<string>();
  for (const spec of specs) {
    if (spec.temp_id) {
      if (seenTempIds.has(spec.temp_id)) {
        throw new Error(`Duplicate temp_id in batch: ${spec.temp_id}`);
      }
      seenTempIds.add(spec.temp_id);
    }
  }

  const run = db.transaction((): CreateTasksResult => {
    const tempIdToTaskId = new Map<string, string>();
    const results: CreateTasksResultItem[] = [];

    for (const spec of specs) {
      const { temp_id, depends_on: _depends_on, ...createInput } = spec;
      const { task, over_budget } = createTask(db, estimator, {
        project_id: projectId,
        ...createInput,
      });
      if (temp_id) {
        tempIdToTaskId.set(temp_id, task.id);
      }
      results.push({
        temp_id,
        task_id: task.id,
        code: withCode(db, task).code,
        estimated_tokens: task.estimated_tokens,
        over_budget,
      });
    }

    specs.forEach((spec, i) => {
      for (const ref of spec.depends_on ?? []) {
        const dependsOnTaskId = tempIdToTaskId.get(ref) ?? ref;
        addDependency(db, results[i].task_id, dependsOnTaskId);
      }
    });

    return { tasks: results };
  });

  return run();
}
