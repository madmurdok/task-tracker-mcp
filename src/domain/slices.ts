import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { requireTask, runOne, taskCode, withCode, type Task } from "./tasks.js";
import { hasUnmetDependencies, LOCK_LEASE_MS } from "./taskStatus.js";

/**
 * How one task is worked (TTM-83): an ordered list of slices, each with a
 * phase, a brief and an exit criterion, whose report and cost come back here.
 * The task-level analogue of a release plan (plans.ts), and deliberately the
 * same shape: steps run in order, slices sharing a step may run in parallel.
 *
 * IMPORT DIRECTION: this module imports tasks.ts and taskStatus.ts only.
 * lifecycle.ts (the complete_task guard) and status.ts (get_task) import it,
 * never the reverse.
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
   * `S1`, `S2`, ... - stored (task_slices.label_number), never recomputed, so
   * a slice keeps its label for life (TTM-89). A first slicing is numbered
   * 1..n in step/position order; a revision numbers its new slices after the
   * highest label the task already had, so after a revision the labels can
   * have gaps (the replaced pending slices' numbers are not reused) but still
   * rise in step/position order.
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
}

/**
 * A pending slice as it read just before a revision replaced it - the fields
 * that described the planned work. Status is always pending, and result,
 * metrics and timestamps are always empty for one, so they are not copied.
 */
export interface ReplacedSlice {
  id: string;
  label: string;
  phase: SlicePhase;
  step: number;
  position: number;
  title: string;
  brief: string;
  exit_criterion: string;
  model: string | null;
}

/** One revise_task_slices call, as get_task returns it (oldest first). */
export interface TaskSliceRevision {
  id: string;
  task_id: string;
  reason: string;
  replaced_slices: ReplacedSlice[];
  revised_at: string;
}

export interface ReviseTaskSlicesResult {
  task_id: string;
  code: string;
  /** The whole slicing after the revision: kept slices, then the new ones. */
  slices: TaskSlice[];
  revision: TaskSliceRevision;
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
  label_number: number;
}

const OPEN_STATUSES: readonly SliceStatus[] = ["pending", "in_progress"];

/** `S2 "Write the migration" (pending)` - how a slice is named in a refusal. */
export function describeSlice(slice: Pick<TaskSlice, "label" | "title" | "status">): string {
  return `${slice.label} "${slice.title}" (${slice.status})`;
}

function toSlice(row: SliceRow, code: string): TaskSlice {
  const label = `S${row.label_number}`;
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
  return rows.map((row) => toSlice(row, code));
}

/** A task's slices in step/position order; empty for an unsliced task. */
export function listTaskSlices(db: DatabaseInstance, taskRef: string): TaskSlice[] {
  return slicesFor(db, requireTask(db, taskRef));
}

/** The slices still pending or in progress - what complete_task refuses over. */
export function listOpenSlices(db: DatabaseInstance, taskRef: string): TaskSlice[] {
  return listTaskSlices(db, taskRef).filter((slice) => OPEN_STATUSES.includes(slice.status));
}

/**
 * A whole project's slices in one query, keyed by task_id - what getBoardData
 * needs (each card's "Slices N/M" button and its detail dialog) without
 * querying task_slices once per task. A task with no slices maps to an empty
 * array, same as listTaskSlices would return for it. Labels come from the
 * stored label_number, exactly as in slicesFor, so the board and get_task can
 * never disagree about which slice is `S2`.
 */
export function listSlicesForTasks(
  db: DatabaseInstance,
  tasks: Array<Pick<Task, "id" | "task_number">>,
  codePrefix: string,
): Map<string, TaskSlice[]> {
  const byTaskId = new Map<string, TaskSlice[]>(tasks.map((task) => [task.id, []]));
  if (tasks.length === 0) return byTaskId;

  const placeholders = tasks.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM task_slices WHERE task_id IN (${placeholders}) ORDER BY task_id ASC, step ASC, position ASC`,
    )
    .all(...tasks.map((task) => task.id)) as SliceRow[];

  const taskNumberById = new Map(tasks.map((task) => [task.id, task.task_number]));
  for (const row of rows) {
    const code = taskCode(codePrefix, taskNumberById.get(row.task_id)!);
    byTaskId.get(row.task_id)!.push(toSlice(row, code));
  }
  return byTaskId;
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
    const label = `S${Number(match[2])}`;
    const found = listTaskSlices(db, match[1]!).find((slice) => slice.label === label);
    if (found) return found;
  }

  throw new Error(`Unknown slice: ${sliceRef}`);
}

/**
 * Validates and flattens `steps` into rows numbered from `firstStep`, in the
 * order they will be labelled. Shared by setTaskSlices and reviseTaskSlices so
 * both accept exactly the same step shape.
 */
function flattenSteps(
  tool: string,
  steps: SliceStepInput[],
  firstStep: number,
): Array<SliceInput & { step: number; position: number }> {
  if (steps.length === 0) {
    throw new Error(`${tool} requires at least one step`);
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
      rows.push({ ...slice, step: firstStep + stepIndex, position: positionIndex + 1 });
    });
  });
  return rows;
}

/** Inserts pending slices, labelling them S<firstLabel>, S<firstLabel+1>, ... in order. */
function insertSlices(
  db: DatabaseInstance,
  taskId: string,
  rows: Array<SliceInput & { step: number; position: number }>,
  firstLabel: number,
  now: string,
): void {
  const insert = db.prepare(
    `INSERT INTO task_slices (id, task_id, phase, step, position, title, brief, exit_criterion, status, model, label_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  );
  rows.forEach((row, index) => {
    insert.run(
      randomUUID(),
      taskId,
      row.phase,
      row.step,
      row.position,
      row.title,
      row.brief ?? "",
      row.exit_criterion ?? "",
      row.model ?? null,
      firstLabel + index,
      now,
      now,
    );
  });
}

function refuseFinishedTask(task: Task, code: string, verb: string): void {
  if (task.status === "done" || task.status === "cancelled") {
    throw new Error(`Task ${code} is ${task.status}; its slicing is a finished record and cannot be ${verb}`);
  }
}

/**
 * Writes a task's first slicing - or replaces one that nothing has started.
 *
 * Rules, and why:
 * - Refused once any slice is in_progress, done, failed or skipped (TTM-89).
 *   Replacing wholesale would delete that slice's row, and with it the report
 *   and metrics of work that ran - often the very finding that made a
 *   re-slice necessary. revise_task_slices re-cuts only the pending rest and
 *   keeps the rest untouched; the refusal names it.
 * - An all-pending slicing is replaced wholesale and renumbered S1..Sn: none
 *   of it ran, so no label of it can be a record of anything yet.
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

  refuseFinishedTask(task, code, "replaced");
  const rows = flattenSteps("set_task_slices", steps, 1);

  const run = db.transaction((): SetTaskSlicesResult => {
    const started = slicesFor(db, task).filter((slice) => slice.status !== "pending");
    if (started.length > 0) {
      throw new Error(
        `Task ${code} has slices that are in progress or finished: ${started.map(describeSlice).join(", ")}; set_task_slices only writes a first slicing - use revise_task_slices to replace the pending slices while keeping these`,
      );
    }

    db.prepare(`DELETE FROM task_slices WHERE task_id = ?`).run(task.id);
    insertSlices(db, task.id, rows, 1, new Date().toISOString());

    return { task_id: task.id, code, slices: slicesFor(db, task) };
  });

  return run();
}

interface SliceRevisionRow {
  id: string;
  task_id: string;
  reason: string;
  replaced_slices: string;
  revised_at: string;
}

function toRevision(row: SliceRevisionRow): TaskSliceRevision {
  return { ...row, replaced_slices: JSON.parse(row.replaced_slices) as ReplacedSlice[] };
}

/** A task's slice revisions, oldest first - the order they happened in. */
export function listSliceRevisions(db: DatabaseInstance, taskId: string): TaskSliceRevision[] {
  const rows = db
    .prepare(`SELECT * FROM task_slice_revisions WHERE task_id = ? ORDER BY revised_at ASC, rowid ASC`)
    .all(taskId) as SliceRevisionRow[];
  return rows.map(toRevision);
}

/**
 * Re-cuts the rest of a task (TTM-89): replaces its pending slices with
 * `steps`, keeping every other slice exactly as it is.
 *
 * - Kept untouched: done, failed, skipped and in_progress slices - status,
 *   result, artifacts, metrics, timestamps, step, position and label. An
 *   in_progress slice is kept rather than refused over: some agent is working
 *   it, and its complete_slice must still find its row.
 * - Replaced: only pending slices. The new ones go in steps after the highest
 *   step among the kept slices, so they run after everything already started.
 * - Labels: the new slices are numbered after the highest label the task had
 *   before the revision (replaced pending slices included), so no label is
 *   ever reused for different work and no kept slice is renumbered.
 * - History: every revision writes one task_slice_revisions row with the
 *   required reason and the replaced pending slices, never updated later.
 * - Refused on a done or cancelled task, like set_task_slices.
 */
export function reviseTaskSlices(
  db: DatabaseInstance,
  taskRef: string,
  steps: SliceStepInput[],
  reason: string,
): ReviseTaskSlicesResult {
  const task = requireTask(db, taskRef);
  const { code } = withCode(db, task);

  refuseFinishedTask(task, code, "revised");
  if (reason.trim() === "") {
    throw new Error("revise_task_slices requires a reason: a revision with no reason records nothing");
  }
  // Validates the shape before anything is read or written; the steps are
  // renumbered below once the kept slices are known.
  flattenSteps("revise_task_slices", steps, 1);

  const run = db.transaction((): ReviseTaskSlicesResult => {
    const previous = slicesFor(db, task);
    const kept = previous.filter((slice) => slice.status !== "pending");
    const replaced = previous.filter((slice) => slice.status === "pending");

    const firstStep = Math.max(0, ...kept.map((slice) => slice.step)) + 1;
    const firstLabel =
      (db.prepare(`SELECT COALESCE(MAX(label_number), 0) AS max FROM task_slices WHERE task_id = ?`).get(task.id) as {
        max: number;
      }).max + 1;
    const rows = flattenSteps("revise_task_slices", steps, firstStep);

    const now = new Date().toISOString();
    db.prepare(`DELETE FROM task_slices WHERE task_id = ? AND status = 'pending'`).run(task.id);
    insertSlices(db, task.id, rows, firstLabel, now);

    const revision: TaskSliceRevision = {
      id: randomUUID(),
      task_id: task.id,
      reason,
      replaced_slices: replaced.map(({ id, label, phase, step, position, title, brief, exit_criterion, model }) => ({
        id,
        label,
        phase,
        step,
        position,
        title,
        brief,
        exit_criterion,
        model,
      })),
      revised_at: now,
    };
    db.prepare(
      `INSERT INTO task_slice_revisions (id, task_id, reason, replaced_slices, revised_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(revision.id, task.id, reason, JSON.stringify(revision.replaced_slices), now);

    return { task_id: task.id, code, slices: slicesFor(db, task), revision };
  });

  return run();
}

/**
 * pending -> in_progress, stamping started_at. Refuses any other status.
 *
 * Starting a slice is starting its task's work, so a task still `pending`
 * moves to `in_progress` with it (TTM-98), under a fresh lease and with its
 * owner left as it was - exactly what get_next_task's hand-out writes. Moving
 * the task rather than returning a warning field: the failure this closes is
 * an orchestrator that started a parallel task's slices without claiming it,
 * and the board then showed the task pending while its agent ran; a warning
 * fixes that only if the caller reads it, whereas the move makes the board
 * true by construction. The cost is that start_slice now writes the task row,
 * so it applies claim_task's gate first: a pending task with unmet
 * dependencies is refused, slice and task both left untouched, rather than
 * started ahead of its prerequisite. An `in_progress` task is not touched (its
 * holder and lease stay as they are), nor is a done/cancelled one.
 */
export function startSlice(db: DatabaseInstance, sliceRef: string): TaskSlice {
  const slice = requireSlice(db, sliceRef);
  if (slice.status !== "pending") {
    throw new Error(`Slice ${slice.ref} is ${slice.status}; only a pending slice can be started`);
  }
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const task = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(slice.task_id) as
      | { status: string }
      | undefined;
    if (task?.status === "pending") {
      if (hasUnmetDependencies(db, slice.task_id)) {
        throw new Error(
          `Slice ${slice.ref} cannot start: its task is pending and blocked by unmet dependencies`,
        );
      }
      const lockExpiresAt = new Date(Date.parse(now) + LOCK_LEASE_MS).toISOString();
      db.prepare(
        `UPDATE tasks SET status = 'in_progress', lock_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(lockExpiresAt, now, slice.task_id);
    }
    runOne(
      db.prepare(
        `UPDATE task_slices SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ),
      `start_slice ${sliceRef}`,
      now,
      now,
      slice.id,
    );
  });
  run();
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
