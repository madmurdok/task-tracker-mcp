import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { requireTask, runOne, withCode, type Task } from "./tasks.js";

/**
 * How one task is worked (TTM-83): an ordered list of slices, each with a
 * phase, a brief and an exit criterion, whose report and cost come back here.
 * The task-level analogue of a release plan (plans.ts), and deliberately the
 * same shape: steps run in order, slices sharing a step may run in parallel.
 *
 * IMPORT DIRECTION: this module imports tasks.ts only. lifecycle.ts (the
 * complete_task guard) and status.ts (get_task) import it, never the reverse.
 */
export type SlicePhase = "design" | "implement" | "verify" | "measure";
export type SliceStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type SliceOutcome = "done" | "failed" | "skipped";

export const SLICE_PHASES: readonly SlicePhase[] = ["design", "implement", "verify", "measure"];
export const SLICE_OUTCOMES: readonly SliceOutcome[] = ["done", "failed", "skipped"];

export interface TaskSlice {
  id: string;
  task_id: string;
  /**
   * `S1`, `S2`, ... in step/position order, 1-based across the whole task.
   * Computed at read time, not stored: a slicing is only ever replaced
   * wholesale (see setTaskSlices), so nothing can renumber it in place.
   */
  label: string;
  /**
   * `TTM-83/S2` - the task's code plus the label. Accepted anywhere a slice_id
   * is, so an orchestrator can address a slice by what it reads rather than by
   * a uuid it has to carry around.
   */
  ref: string;
  phase: SlicePhase;
  step: number;
  position: number;
  title: string;
  brief: string;
  exit_criterion: string;
  status: SliceStatus;
  model: string | null;
  result: string | null;
  artifacts: string[];
  metrics: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SliceInput {
  phase: SlicePhase;
  title: string;
  brief?: string;
  exit_criterion?: string;
  model?: string;
}

/**
 * A step is one slice, or an array of slices that may run in parallel - the
 * same shorthand as plans.ts's PlanStepInput, so a flat list is a valid
 * slicing of sequential steps.
 */
export type SliceStepInput = SliceInput | SliceInput[];

export interface SetTaskSlicesResult {
  task_id: string;
  code: string;
  slices: TaskSlice[];
  /**
   * Previous slices that had already finished (done/failed/skipped) and were
   * dropped by this replacement. Replacing carries nothing over, so this is
   * the caller's one visible trace of what the re-slicing threw away.
   */
  discarded: Array<{ label: string; title: string; status: SliceStatus }>;
}

export interface CompleteSliceInput {
  status: SliceOutcome;
  result: string;
  artifacts?: string[];
  metrics?: Record<string, unknown>;
}

interface SliceRow {
  id: string;
  task_id: string;
  phase: SlicePhase;
  step: number;
  position: number;
  title: string;
  brief: string;
  exit_criterion: string;
  status: SliceStatus;
  model: string | null;
  result: string | null;
  artifacts: string;
  metrics: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const OPEN_STATUSES: readonly SliceStatus[] = ["pending", "in_progress"];

/** `S2 "Write the migration" (pending)` - how a slice is named in a refusal. */
export function describeSlice(slice: Pick<TaskSlice, "label" | "title" | "status">): string {
  return `${slice.label} "${slice.title}" (${slice.status})`;
}

function toSlice(row: SliceRow, index: number, code: string): TaskSlice {
  const label = `S${index + 1}`;
  return {
    id: row.id,
    task_id: row.task_id,
    label,
    ref: `${code}/${label}`,
    phase: row.phase,
    step: row.step,
    position: row.position,
    title: row.title,
    brief: row.brief,
    exit_criterion: row.exit_criterion,
    status: row.status,
    model: row.model,
    result: row.result,
    artifacts: JSON.parse(row.artifacts) as string[],
    metrics: row.metrics === null ? null : (JSON.parse(row.metrics) as Record<string, unknown>),
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function slicesFor(db: DatabaseInstance, task: Task): TaskSlice[] {
  const { code } = withCode(db, task);
  const rows = db
    .prepare(`SELECT * FROM task_slices WHERE task_id = ? ORDER BY step ASC, position ASC`)
    .all(task.id) as SliceRow[];
  return rows.map((row, index) => toSlice(row, index, code));
}

/** A task's slices in step/position order; empty for an unsliced task. */
export function listTaskSlices(db: DatabaseInstance, taskRef: string): TaskSlice[] {
  return slicesFor(db, requireTask(db, taskRef));
}

/** The slices still pending or in progress - what complete_task refuses over. */
export function listOpenSlices(db: DatabaseInstance, taskRef: string): TaskSlice[] {
  return listTaskSlices(db, taskRef).filter((slice) => OPEN_STATUSES.includes(slice.status));
}

/** `TTM-83/S2`, or `<task uuid>/S2`. Case-insensitive on the `S`. */
const SLICE_REF = /^(.+)\/[Ss](\d+)$/;

/**
 * Resolves a slice_id to its slice: the slice's own uuid, or a task ref plus
 * its label (`TTM-83/S2`). The uuid is tried first, the same order
 * resolveTaskId uses, so no uuid can be shadowed by the readable form.
 */
export function requireSlice(db: DatabaseInstance, sliceRef: string): TaskSlice {
  const direct = db.prepare(`SELECT task_id FROM task_slices WHERE id = ?`).get(sliceRef) as
    | { task_id: string }
    | undefined;
  if (direct) {
    const found = listTaskSlices(db, direct.task_id).find((slice) => slice.id === sliceRef);
    if (found) return found;
  }

  const match = SLICE_REF.exec(sliceRef);
  if (match) {
    const slices = listTaskSlices(db, match[1]!);
    const found = slices[Number(match[2]) - 1];
    if (found) return found;
  }

  throw new Error(`Unknown slice: ${sliceRef}`);
}

/**
 * Writes a task's whole slicing, replacing whatever was there.
 *
 * Replace rules, and why:
 * - Refused while any slice is in_progress. Some agent is working that slice
 *   right now; deleting the row under it would make its complete_slice fail
 *   and lose its report. Finish, fail or skip it first.
 * - Otherwise nothing is carried over - done/failed/skipped slices included.
 *   A re-slicing is a new decomposition, and matching old slices to new ones
 *   by title or position would be a guess. The discarded finished slices are
 *   named in the result so the loss is visible, never silent.
 * - Refused on a done or cancelled task: its slicing is the record of how it
 *   was worked, and rewriting it afterwards would erase that record.
 */
export function setTaskSlices(
  db: DatabaseInstance,
  taskRef: string,
  steps: SliceStepInput[],
): SetTaskSlicesResult {
  const task = requireTask(db, taskRef);
  const { code } = withCode(db, task);

  if (task.status === "done" || task.status === "cancelled") {
    throw new Error(`Task ${code} is ${task.status}; its slicing is a finished record and cannot be replaced`);
  }
  if (steps.length === 0) {
    throw new Error("set_task_slices requires at least one step");
  }

  const rows: Array<SliceInput & { step: number; position: number }> = [];
  steps.forEach((step, stepIndex) => {
    const group = Array.isArray(step) ? step : [step];
    if (group.length === 0) {
      throw new Error(`Slice step ${stepIndex + 1} has no slices`);
    }
    group.forEach((slice, positionIndex) => {
      if (!SLICE_PHASES.includes(slice.phase)) {
        throw new Error(`Unknown phase "${slice.phase}"; expected one of ${SLICE_PHASES.join(", ")}`);
      }
      rows.push({ ...slice, step: stepIndex + 1, position: positionIndex + 1 });
    });
  });

  const run = db.transaction((): SetTaskSlicesResult => {
    const previous = slicesFor(db, task);
    const running = previous.filter((slice) => slice.status === "in_progress");
    if (running.length > 0) {
      throw new Error(
        `Task ${code} has slices in progress: ${running.map(describeSlice).join(", ")}; complete, fail or skip them before replacing the slicing`,
      );
    }

    db.prepare(`DELETE FROM task_slices WHERE task_id = ?`).run(task.id);

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO task_slices (id, task_id, phase, step, position, title, brief, exit_criterion, status, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        randomUUID(),
        task.id,
        row.phase,
        row.step,
        row.position,
        row.title,
        row.brief ?? "",
        row.exit_criterion ?? "",
        row.model ?? null,
        now,
        now,
      );
    }

    return {
      task_id: task.id,
      code,
      slices: slicesFor(db, task),
      discarded: previous
        .filter((slice) => !OPEN_STATUSES.includes(slice.status))
        .map(({ label, title, status }) => ({ label, title, status })),
    };
  });

  return run();
}

/** pending -> in_progress, stamping started_at. Refuses any other status. */
export function startSlice(db: DatabaseInstance, sliceRef: string): TaskSlice {
  const slice = requireSlice(db, sliceRef);
  if (slice.status !== "pending") {
    throw new Error(`Slice ${slice.ref} is ${slice.status}; only a pending slice can be started`);
  }
  const now = new Date().toISOString();
  runOne(
    db.prepare(
      `UPDATE task_slices SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    ),
    `start_slice ${sliceRef}`,
    now,
    now,
    slice.id,
  );
  return requireSlice(db, slice.id);
}

/**
 * Records a slice's outcome and report, stamping completed_at. One-shot, like
 * complete_task: a slice already done/failed/skipped is refused rather than
 * overwritten, so a report cannot be silently replaced.
 *
 * done and failed require the slice to have been started - they report on
 * work that ran, and started_at is half of its duration. skipped is also
 * accepted straight from pending: a slice that never ran is the normal case
 * for a skip.
 */
export function completeSlice(db: DatabaseInstance, sliceRef: string, input: CompleteSliceInput): TaskSlice {
  const slice = requireSlice(db, sliceRef);
  if (!SLICE_OUTCOMES.includes(input.status)) {
    throw new Error(`Unknown slice outcome "${input.status}"; expected one of ${SLICE_OUTCOMES.join(", ")}`);
  }
  const allowedFrom: SliceStatus[] = input.status === "skipped" ? ["pending", "in_progress"] : ["in_progress"];
  if (!allowedFrom.includes(slice.status)) {
    throw new Error(
      `Slice ${slice.ref} is ${slice.status}; it can be marked ${input.status} only from ${allowedFrom.join(" or ")}`,
    );
  }

  const now = new Date().toISOString();
  runOne(
    db.prepare(
      `UPDATE task_slices
       SET status = ?, result = ?, artifacts = ?, metrics = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    ),
    `complete_slice ${sliceRef}`,
    input.status,
    input.result,
    JSON.stringify(input.artifacts ?? []),
    input.metrics === undefined ? null : JSON.stringify(input.metrics),
    now,
    now,
    slice.id,
    slice.status,
  );
  return requireSlice(db, slice.id);
}
