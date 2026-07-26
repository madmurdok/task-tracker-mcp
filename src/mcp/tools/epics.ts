import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { createEpic } from "../../domain/epics.js";
import { getEpicStatus, listEpicsWithStatus } from "../../domain/status.js";
import { jsonResult } from "../toolResult.js";

export function registerEpicTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "create_epic",
    {
      description:
        "Create an epic to group related tasks under a project. project_id accepts a project id or its unique name. name must be unique within the project (but can repeat across different projects).",
      inputSchema: {
        project_id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
      },
    },
    async ({ project_id, name, description }) => {
      const epic = createEpic(db, { project_id, name, description });
      return jsonResult({ epic_id: epic.id });
    },
  );

  server.registerTool(
    "list_epics",
    {
      description:
        "List epics for a project with aggregate task status counts per epic. project_id accepts a project id or its unique name.",
      inputSchema: { project_id: z.string().min(1) },
    },
    async ({ project_id }) => jsonResult({ epics: listEpicsWithStatus(db, project_id) }),
  );

  server.registerTool(
    "get_epic_status",
    {
      description:
        "Aggregate task counts (and completion percent) for a single epic. project_id accepts a project id or its unique name; epic_id accepts an epic id or its name within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        epic_id: z.string().min(1),
      },
    },
    async ({ project_id, epic_id }) => jsonResult(getEpicStatus(db, project_id, epic_id)),
  );
}
