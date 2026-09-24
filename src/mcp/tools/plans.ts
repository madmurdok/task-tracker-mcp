import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { approvePlan, codesFor, getPlan, upsertPlan, type ReleasePlan } from "../../domain/plans.js";
import { requireProject } from "../../domain/projects.js";
import { jsonResult } from "../toolResult.js";

// TTM-91: create_plan/approve_plan's compact default. `items` (task_id,
// title, step, position, note, added_at, live status) is what the caller
// either just wrote (create_plan) or already knows was approved
// (approve_plan) - so the compact form keeps only which tasks landed in which
// step, as codes, plus the approval record and (only when non-empty) the
// drift lists. get_plan is unaffected: it's a read tool and keeps the full
// ReleasePlan shape (see CLAUDE.md-style tools split at the top of this repo's
// TTM-91 slice).
function compactPlan(db: DatabaseInstance, codePrefix: string, plan: ReleasePlan) {
  const steps: string[][] = [];
  for (const item of plan.items) {
    (steps[item.step - 1] ??= []).push(item.code);
  }
  const result: {
    status: ReleasePlan["status"];
    approved_by?: string;
    approval_note?: string;
    steps: string[][];
    unplanned?: string[];
    orphaned?: string[];
  } = { status: plan.status, steps };
  if (plan.approved_by) result.approved_by = plan.approved_by;
  if (plan.approval_note) result.approval_note = plan.approval_note;
  if (plan.unplanned_task_ids.length > 0) {
    result.unplanned = codesFor(db, codePrefix, plan.unplanned_task_ids);
  }
  if (plan.orphaned_task_ids.length > 0) {
    result.orphaned = codesFor(db, codePrefix, plan.orphaned_task_ids);
  }
  return result;
}

const VERBOSE_HELP =
  " Returns a compact acknowledgement by default - {status, approved_by?, approval_note?, steps: [[code, ...], ...], unplanned?, orphaned?} (unplanned/orphaned only when non-empty); pass verbose:true for today's full plan object (items with task_id/title/step/position/note/status, unplanned_task_ids, orphaned_task_ids).";

// One item: a bare ref, or a ref plus the one-line reason it sits where it
// does. Mirrors domain/plans.ts's PlanItemInput exactly, so a schema mismatch
// here would be the only place the two could drift.
const planItemShape = z.union([
  z.string().min(1),
  z.object({ task: z.string().min(1), note: z.string().optional() }),
]);

// A step is one item, or an array of items that may run in parallel - see
// PlanStepInput. A flat array of bare refs is therefore already a valid
// `steps` value (each becomes a step of one), which is the common case.
const planStepShape = z.union([planItemShape, z.array(planItemShape).min(1)]);

export function registerPlanTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "create_plan",
    {
      description:
        `Write (or replace) a release's execution order: the sequence Claude proposes, grouped into steps that may run in parallel within a step. Upsert, not separate insert/move/remove tools - a membership change already sends the plan back to draft, so re-sending the whole plan is the normal path; replacing an approved plan resets it to draft and clears the approval, since nobody signed off on the new order. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project - rejects an already-released or cancelled release. Each step is a task ref, or an array of task refs to run in parallel; a ref accepts a task's uuid or its code (\`TTM-63\`). Rejects a task that isn't in this release, a task listed twice, or an empty steps array. rationale (optional) is reset on every upsert along with the approval, for the same reason the approval is.${VERBOSE_HELP}`,
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
        steps: z.array(planStepShape).min(1),
        rationale: z.string().optional(),
        verbose: z.boolean().optional(),
      },
    },
    async ({ project_id, release_id, steps, rationale, verbose }) => {
      const plan = upsertPlan(db, project_id, release_id, { steps, rationale });
      if (verbose) return jsonResult(plan);
      const project = requireProject(db, project_id);
      return jsonResult(compactPlan(db, project.code_prefix, plan));
    },
  );

  server.registerTool(
    "get_plan",
    {
      description:
        "Read a release's plan: its items in execution order (each with its live status), the approval record, and both directions of drift - unplanned_task_ids (in the batch, not in the plan) and orphaned_task_ids (in the plan, no longer in the batch). Returns null if the release has no plan yet, rather than an error - matching get_task/get_release's treatment of an absent optional record. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
      },
    },
    async ({ project_id, release_id }) => jsonResult(getPlan(db, project_id, release_id) ?? null),
  );

  server.registerTool(
    "approve_plan",
    {
      description:
        `Record the owner's one-time sign-off on a release's plan: draft -> approved, stamping approved_by, approved_at and note. note (optional) is stored exactly as given - the approving human's verbatim words, not a summary or comment, because that quote is the whole value of the record: the party an approval authorises is the party calling this tool. Rejects if the plan has drifted from the batch (the error names the unplanned/orphaned tasks by code), if any open (not done/cancelled) batch task has no slices (the error names them by code - slice them with set_task_slices first; no bypass), if it's already approved (no re-stamping over the first approver), or if the release has no plan yet. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project.${VERBOSE_HELP}`,
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
        approved_by: z.string().min(1),
        note: z.string().optional(),
        verbose: z.boolean().optional(),
      },
    },
    async ({ project_id, release_id, approved_by, note, verbose }) => {
      const plan = approvePlan(db, project_id, release_id, { approved_by, note });
      if (verbose) return jsonResult(plan);
      const project = requireProject(db, project_id);
      return jsonResult(compactPlan(db, project.code_prefix, plan));
    },
  );
}
