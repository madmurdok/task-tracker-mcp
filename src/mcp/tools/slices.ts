import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import {
  completeSlice,
  reviseTaskSlices,
  setTaskSlices,
  startSlice,
  type ReviseTaskSlicesResult,
  type SetTaskSlicesResult,
  type TaskSlice,
} from "../../domain/slices.js";
import { jsonResult } from "../toolResult.js";

// TTM-91: the compact default for a slice inside set_task_slices/
// revise_task_slices - just enough to address it (ref) and see its state
// (phase/title/status), not the brief/exit_criterion/result/artifacts/metrics
// the caller either just wrote itself or hasn't produced yet. verbose:true
// restores the full TaskSlice row.
function compactSlice(slice: TaskSlice) {
  return { ref: slice.ref, label: slice.label, phase: slice.phase, title: slice.title, status: slice.status };
}

function compactSetResult(result: SetTaskSlicesResult) {
  return { task_id: result.task_id, code: result.code, slices: result.slices.map(compactSlice) };
}

function compactReviseResult(result: ReviseTaskSlicesResult) {
  return {
    task_id: result.task_id,
    code: result.code,
    slices: result.slices.map(compactSlice),
    revision: { id: result.revision.id, reason: result.revision.reason },
  };
}

// start_slice/complete_slice's compact default: just enough to confirm which
// slice moved and to what status, not the whole row it started from or the
// result/artifacts/metrics the caller just wrote in the same call.
function compactAck(slice: TaskSlice) {
  return { ok: true, ref: slice.ref, label: slice.label, status: slice.status };
}

const VERBOSE_HELP =
  " Returns a compact acknowledgement by default; pass verbose:true for today's full object.";

// Mirrors domain/slices.ts's SliceInput exactly.
const sliceShape = z.object({
  phase: z.enum(["design", "implement", "verify", "measure"]),
  title: z.string().min(1),
  brief: z.string().optional(),
  exit_criterion: z.string().optional(),
  model: z.string().optional(),
});

// A step is one slice, or an array of slices that may run in parallel - the
// same shorthand as create_plan's steps.
const sliceStepShape = z.union([sliceShape, z.array(sliceShape).min(1)]);

const SLICE_ID_HELP =
  "slice_id accepts the slice's uuid or its readable ref `<task>/S<n>` (e.g. `TTM-83/S2`, or `<task uuid>/S2`), where S<n> is the slice's label - the `ref` field every slice carries in set_task_slices/revise_task_slices/get_task. A label is fixed for the slice's life: a revision never renumbers a slice.";

export function registerSliceTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "set_task_slices",
    {
      description:
        `Write a task's first slicing: how it is worked, as slices in steps. Each step is a slice, or an array of slices that may run in parallel (like create_plan's steps); a slice is {phase: design|implement|verify|measure, title, brief?, exit_criterion?, model?}. Slices are labelled S1, S2, ... in step/position order and returned with a \`ref\` (\`TTM-83/S2\`) that start_slice/complete_slice accept. A slicing that is still all pending may be replaced wholesale by calling this again. Refuses once any slice is in_progress, done, failed or skipped - use revise_task_slices, which replaces only the pending slices and keeps the rest with their reports - and on a done or cancelled task. task_id accepts a task's uuid or its code (\`TTM-63\`). Compact default: {task_id, code, slices: [{ref, label, phase, title, status}]} - the brief/exit_criterion/model the caller just wrote are left out.${VERBOSE_HELP}`,
      inputSchema: {
        task_id: z.string().min(1),
        slices: z.array(sliceStepShape).min(1),
        verbose: z.boolean().optional(),
      },
    },
    async ({ task_id, slices, verbose }) => {
      const result = setTaskSlices(db, task_id, slices);
      return jsonResult(verbose ? result : compactSetResult(result));
    },
  );

  server.registerTool(
    "revise_task_slices",
    {
      description:
        `Re-cut the rest of a task after a slice's finding changes the plan. Replaces only the task's pending slices with \`slices\` (same step shape as set_task_slices); every done, failed, skipped and in_progress slice is kept untouched - status, result, artifacts, metrics, timestamps and label. The new slices are placed in steps after the highest step among the kept slices, and labelled after the highest label the task already had, so no existing label ever changes or is reused (\`TTM-83/S2\` keeps naming the same slice; labels may have gaps). reason is required: each revision is recorded with its reason and the pending slices it replaced, and get_task returns that history as slice_revisions. Refuses on a done or cancelled task. task_id accepts a task's uuid or its code (\`TTM-63\`). Compact default: {task_id, code, slices: [{ref, label, phase, title, status}], revision: {id, reason}} - the replaced_slices detail is left out (get_task's slice_revisions still has it).${VERBOSE_HELP}`,
      inputSchema: {
        task_id: z.string().min(1),
        slices: z.array(sliceStepShape).min(1),
        reason: z.string().min(1),
        verbose: z.boolean().optional(),
      },
    },
    async ({ task_id, slices, reason, verbose }) => {
      const result = reviseTaskSlices(db, task_id, slices, reason);
      return jsonResult(verbose ? result : compactReviseResult(result));
    },
  );

  server.registerTool(
    "start_slice",
    {
      description: `Mark a slice in progress: pending -> in_progress, stamping started_at. Refuses any slice that is not pending. Starting a slice starts its task: a task still pending moves to in_progress too, under a fresh lease (owner unchanged), as get_next_task would - so a task worked without being claimed still shows in progress on the board. A pending task with unmet dependencies is refused instead, slice and task left untouched; an in_progress task is not touched. Compact default: {ok, ref, label, status}.${VERBOSE_HELP} ${SLICE_ID_HELP}`,
      inputSchema: { slice_id: z.string().min(1), verbose: z.boolean().optional() },
    },
    async ({ slice_id, verbose }) => {
      const slice = startSlice(db, slice_id);
      return jsonResult(verbose ? slice : compactAck(slice));
    },
  );

  server.registerTool(
    "complete_slice",
    {
      description: `Record a slice's outcome, stamping completed_at. status: done|failed require the slice to be in_progress (start_slice first); skipped is accepted from pending or in_progress. One-shot: an already finished slice is refused, never overwritten. result is the slice's report; artifacts (optional) the repo paths of its durable outputs; metrics (optional) a free-form object such as {reread_tokens, max_context, tool_uses, duration_ms}. Compact default: {ok, ref, label, status} - the result/artifacts/metrics the caller just wrote are left out.${VERBOSE_HELP} ${SLICE_ID_HELP}`,
      inputSchema: {
        slice_id: z.string().min(1),
        status: z.enum(["done", "failed", "skipped"]),
        result: z.string().min(1),
        artifacts: z.array(z.string().min(1)).optional(),
        metrics: z.record(z.string(), z.unknown()).optional(),
        verbose: z.boolean().optional(),
      },
    },
    async ({ slice_id, status, result, artifacts, metrics, verbose }) => {
      const slice = completeSlice(db, slice_id, { status, result, artifacts, metrics });
      return jsonResult(verbose ? slice : compactAck(slice));
    },
  );
}
