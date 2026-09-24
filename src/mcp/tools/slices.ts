import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { completeSlice, setTaskSlices, startSlice } from "../../domain/slices.js";
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
  "slice_id accepts the slice's uuid or its readable ref `<task>/S<n>` (e.g. `TTM-83/S2`, or `<task uuid>/S2`), where S<n> is the slice's 1-based label in step/position order - the `ref` field every slice carries in set_task_slices/get_task.";

export function registerSliceTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "set_task_slices",
    {
      description:
        "Write (or replace) how a task is worked: its slices, in steps. Each step is a slice, or an array of slices that may run in parallel (like create_plan's steps); a slice is {phase: design|implement|verify|measure, title, brief?, exit_criterion?, model?}. Slices are labelled S1, S2, ... in step/position order and returned with a `ref` (`TTM-83/S2`) that start_slice/complete_slice accept. Replacing is wholesale and carries nothing over - done/failed/skipped slices are dropped too and listed in `discarded`, so a re-slicing is explicit. Refuses while any slice is in_progress (finish, fail or skip it first), and on a done or cancelled task. task_id accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        slices: z.array(sliceStepShape).min(1),
      },
    },
    async ({ task_id, slices }) => jsonResult(setTaskSlices(db, task_id, slices)),
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
