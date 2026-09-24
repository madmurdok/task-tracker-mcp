import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { completeSlice, reviseTaskSlices, setTaskSlices, startSlice } from "../../domain/slices.js";
import { jsonResult } from "../toolResult.js";

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
        "Write a task's first slicing: how it is worked, as slices in steps. Each step is a slice, or an array of slices that may run in parallel (like create_plan's steps); a slice is {phase: design|implement|verify|measure, title, brief?, exit_criterion?, model?}. Slices are labelled S1, S2, ... in step/position order and returned with a `ref` (`TTM-83/S2`) that start_slice/complete_slice accept. A slicing that is still all pending may be replaced wholesale by calling this again. Refuses once any slice is in_progress, done, failed or skipped - use revise_task_slices, which replaces only the pending slices and keeps the rest with their reports - and on a done or cancelled task. task_id accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        slices: z.array(sliceStepShape).min(1),
      },
    },
    async ({ task_id, slices }) => jsonResult(setTaskSlices(db, task_id, slices)),
  );

  server.registerTool(
    "revise_task_slices",
    {
      description:
        "Re-cut the rest of a task after a slice's finding changes the plan. Replaces only the task's pending slices with `slices` (same step shape as set_task_slices); every done, failed, skipped and in_progress slice is kept untouched - status, result, artifacts, metrics, timestamps and label. The new slices are placed in steps after the highest step among the kept slices, and labelled after the highest label the task already had, so no existing label ever changes or is reused (`TTM-83/S2` keeps naming the same slice; labels may have gaps). reason is required: each revision is recorded with its reason and the pending slices it replaced, and get_task returns that history as slice_revisions. Returns {task_id, code, slices, revision}. Refuses on a done or cancelled task. task_id accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        slices: z.array(sliceStepShape).min(1),
        reason: z.string().min(1),
      },
    },
    async ({ task_id, slices, reason }) => jsonResult(reviseTaskSlices(db, task_id, slices, reason)),
  );

  server.registerTool(
    "start_slice",
    {
      description: `Mark a slice in progress: pending -> in_progress, stamping started_at. Refuses any slice that is not pending. Returns the updated slice. ${SLICE_ID_HELP}`,
      inputSchema: { slice_id: z.string().min(1) },
    },
    async ({ slice_id }) => jsonResult(startSlice(db, slice_id)),
  );

  server.registerTool(
    "complete_slice",
    {
      description: `Record a slice's outcome, stamping completed_at. status: done|failed require the slice to be in_progress (start_slice first); skipped is accepted from pending or in_progress. One-shot: an already finished slice is refused, never overwritten. result is the slice's report; artifacts (optional) the repo paths of its durable outputs; metrics (optional) a free-form object such as {reread_tokens, max_context, tool_uses, duration_ms}. Returns the updated slice. ${SLICE_ID_HELP}`,
      inputSchema: {
        slice_id: z.string().min(1),
        status: z.enum(["done", "failed", "skipped"]),
        result: z.string().min(1),
        artifacts: z.array(z.string().min(1)).optional(),
        metrics: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ slice_id, status, result, artifacts, metrics }) =>
      jsonResult(completeSlice(db, slice_id, { status, result, artifacts, metrics })),
  );
}
