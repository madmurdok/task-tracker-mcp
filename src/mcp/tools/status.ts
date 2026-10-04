import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { getNextTask, getProjectStatus, getTaskDetail, listTasks } from "../../domain/status.js";
import { jsonResult } from "../toolResult.js";

const statusEnum = z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]);

export function registerStatusTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "get_next_task",
    {
      description:
        "Atomically pick the next unblocked pending task for a project and mark it in_progress. project_id accepts a project id or its unique name. Pass release_id to work one release batch instead of the whole project: it accepts a release id or its version within that project, and the batch's plan then decides the order - an approved plan is followed step by step (plan_status:'approved'), a draft or drifted one refuses with reason:'plan_not_approved' until it is fixed and approved, and a batch with no plan falls back to priority order (plan_status:'none'). Without release_id the pick is project-wide and in priority order as always, and plan_pending lists any batches whose plan is still draft or drifted - a task handed out from one of those is work whose order nobody approved. doc_drift:true means the project's tracked design doc changed since it was last hashed - re-check the plan and call check_doc_sync(acknowledge:true) once reconciled. When nothing pending is available, a task held in_progress under a lapsed lease (2 h with no slice activity) is reclaimed and handed out again, and the answer then carries reclaimed_from: { owner_session_id, lock_expires_at, last_activity_at } describing the previous holder. A lapsed lease may be a paused session, not a dead one: before working on a reclaimed task, confirm the previous holder is gone (its agent finished or died, its branch idle) - another worker may still be on it.",
      inputSchema: { project_id: z.string().min(1), release_id: z.string().optional() },
    },
    async ({ project_id, release_id }) => jsonResult(getNextTask(db, project_id, release_id)),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks for a project as compact summary rows, optionally filtered by status, epic, and/or release (combinable). project_id accepts a project id or its unique name; epic_id accepts an epic id or its name within that project; release_id accepts a release id or its version within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        status: statusEnum.optional(),
        epic_id: z.string().optional(),
        release_id: z.string().optional(),
      },
    },
    async ({ project_id, status, epic_id, release_id }) =>
      jsonResult({ tasks: listTasks(db, project_id, status, epic_id, release_id) }),
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Fetch a single task's full detail (including file_paths, handoff_notes, amendments, slices - in step/position order, see set_task_slices - and slice_revisions, the re-slicing history, see revise_task_slices) by id, with no claim/lock side effect - unlike get_next_task, safe to call anytime just to re-inspect a task. Accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: { task_id: z.string().min(1) },
    },
    async ({ task_id }) => jsonResult(getTaskDetail(db, task_id)),
  );

  server.registerTool(
    "get_project_status",
    {
      description:
        "Aggregate task counts (and completion percent) for a project. project_id accepts a project id or its unique name. doc_drift:true means the tracked design doc changed since it was last hashed - see check_doc_sync.",
      inputSchema: { project_id: z.string().min(1) },
    },
    async ({ project_id }) => jsonResult(getProjectStatus(db, project_id)),
  );
}
