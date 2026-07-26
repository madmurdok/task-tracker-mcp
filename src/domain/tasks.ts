import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { isOverBudget, type BudgetEstimator } from "./budget.js";
import { addDependency } from "./dependencies.js";
import { requireProject } from "./projects.js";

export type TaskStatus = "pending" | "in_progress" | "done";

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: TaskStatus;
  estimated_tokens: number;
  owner_session_id: string | null;
  lock_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  project_id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  file_paths?: string[];
}

export interface CreateTaskResult {
  task: Task;
  over_budget: boolean;
}

export function createTask(
  db: DatabaseInstance,
  estimator: BudgetEstimator,
  input: CreateTaskInput,
): CreateTaskResult {
  const project = requireProject(db, input.project_id);

  const filePaths = input.file_paths ?? [];
  const estimatedTokens = estimator.estimateTokens(project.root_path, filePaths);
  const now = new Date().toISOString();

  const task: Task = {
    id: randomUUID(),
    project_id: project.id,
    title: input.title,
    description: input.description ?? "",
    acceptance_criteria: input.acceptance_criteria ?? "",
    status: "pending",
    estimated_tokens: estimatedTokens,
    owner_session_id: null,
    lock_expires_at: null,
    created_at: now,
    updated_at: now,
  };

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, status, estimated_tokens, owner_session_id, lock_expires_at, created_at, updated_at)
     VALUES (@id, @project_id, @title, @description, @acceptance_criteria, @status, @estimated_tokens, @owner_session_id, @lock_expires_at, @created_at, @updated_at)`,
  );
  const insertFile = db.prepare(`INSERT INTO task_files (task_id, file_path) VALUES (?, ?)`);

  const insertAll = db.transaction(() => {
    insertTask.run(task);
    for (const filePath of filePaths) {
      insertFile.run(task.id, filePath);
    }
  });
  insertAll();

  return { task, over_budget: isOverBudget(estimatedTokens) };
}

export interface SplitSubtaskInput {
  title: string;
  description?: string;
  acceptance_criteria?: string;
  file_paths?: string[];
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
    const original = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
    if (!original) {
      throw new Error(`Unknown task_id: ${taskId}`);
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

    const newTaskIds = subtasks.map(
      (subtaskInput) =>
        createTask(db, estimator, { project_id: original.project_id, ...subtaskInput }).task.id,
    );

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
