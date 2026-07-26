import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { getNextTask, getProjectStatus, listTasks } from "../../domain/status.js";
import { jsonResult } from "../toolResult.js";

const statusEnum = z.enum(["pending", "in_progress", "blocked", "done"]);

export function registerStatusTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "get_next_task",
    {
      description:
        "Atomically pick the next unblocked pending task for a project and mark it in_progress. project_id accepts a project id or its unique name.",
      inputSchema: { project_id: z.string().min(1) },
    },
    async ({ project_id }) => jsonResult(getNextTask(db, project_id)),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks for a project as compact summary rows, optionally filtered by status and/or epic. project_id accepts a project id or its unique name; epic_id accepts an epic id or its name within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        status: statusEnum.optional(),
        epic_id: z.string().optional(),
      },
    },
    async ({ project_id, status, epic_id }) =>
      jsonResult({ tasks: listTasks(db, project_id, status, epic_id) }),
  );

  server.registerTool(
    "get_project_status",
    {
      description:
        "Aggregate task counts (and completion percent) for a project. project_id accepts a project id or its unique name.",
      inputSchema: { project_id: z.string().min(1) },
    },
    async ({ project_id }) => jsonResult(getProjectStatus(db, project_id)),
  );
}
