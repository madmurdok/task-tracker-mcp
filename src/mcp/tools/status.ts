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
        "Atomically pick the next unblocked pending task for a project and mark it in_progress. project_id accepts a project id or its unique name. doc_drift:true means the project's tracked design doc changed since it was last hashed - re-check the plan and call check_doc_sync(acknowledge:true) once reconciled.",
      inputSchema: { project_id: z.string().min(1) },
    },
    async ({ project_id }) => jsonResult(getNextTask(db, project_id)),
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
        "Fetch a single task's full detail (including file_paths and handoff_notes) by id, with no claim/lock side effect - unlike get_next_task, safe to call anytime just to re-inspect a task. Accepts a task's uuid or its code (`TTM-63`).",
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
