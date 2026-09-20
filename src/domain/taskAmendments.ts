import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";

/**
 * The audit trail behind `amendTask` (TTM-81) - kept in its own leaf module,
 * the same way handoffNotes.ts is: it names no type from tasks.ts, so
 * tasks.ts can import this without closing a cycle (mirrors planWrites.ts's
 * reasoning for the same shape).
 *
 * A row is one field's one change, in the vocabulary `amendTask` writes to:
 * "correcting a fact" (title/description/acceptance_criteria/file_paths/
 * complexity_hint), not "rewriting the deal" silently. `previous_value` is a
 * plain string for every field except `file_paths`, which is a JSON array
 * string - the one field whose "value" isn't text to begin with.
 */
export type AmendableField =
  | "title"
  | "description"
  | "acceptance_criteria"
  | "file_paths"
  | "complexity_hint";

export interface TaskAmendment {
  id: string;
  task_id: string;
  field: AmendableField;
  previous_value: string;
  reason: string;
  amended_at: string;
}

/** Writes one amendment row. Never updates or deletes one - see schema.ts. */
export function recordAmendment(
  db: DatabaseInstance,
  taskId: string,
  field: AmendableField,
  previousValue: string,
  reason: string,
  amendedAt: string,
): TaskAmendment {
  const amendment: TaskAmendment = {
    id: randomUUID(),
    task_id: taskId,
    field,
    previous_value: previousValue,
    reason,
    amended_at: amendedAt,
  };

  db.prepare(
    `INSERT INTO task_amendments (id, task_id, field, previous_value, reason, amended_at)
     VALUES (@id, @task_id, @field, @previous_value, @reason, @amended_at)`,
  ).run(amendment);

  return amendment;
}

/** A task's amendment history, oldest first - the order it happened in. */
export function listTaskAmendments(db: DatabaseInstance, taskId: string): TaskAmendment[] {
  return db
    .prepare(`SELECT * FROM task_amendments WHERE task_id = ? ORDER BY amended_at ASC`)
    .all(taskId) as TaskAmendment[];
}
