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
 * that shows a task code (CLI status, dashboard board) renders it identically.
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

export function requireTask(db: DatabaseInstance, taskId: string): Task {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    throw new Error(`Unknown task_id: ${taskId}`);
  }
  return task;
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
export function setTaskPriority(db: DatabaseInstance, taskId: string, priority: number): void {
  requireTask(db, taskId);
  db.prepare(`UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`).run(
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
export function deleteTask(db: DatabaseInstance, taskId: string): void {
  const task = requireTask(db, taskId);
  if (task.release_id !== null) {
    throw new Error(
      `Task ${taskId} is in a release; only backlog tasks (no release) can be deleted. Move it out with set_task_release or use cancel_task instead.`,
    );
  }

  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
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
  taskId: string,
  subtasks: SplitSubtaskInput[],
): SplitTaskResult {
  const run = db.transaction((): SplitTaskResult => {
    const original = requireTask(db, taskId);
    if (original.status === "done" || original.status === "cancelled") {
      throw new Error(`Cannot split task ${taskId}: already ${original.status}`);
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
      results.push({ temp_id, task_id: task.id, estimated_tokens: task.estimated_tokens, over_budget });
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
