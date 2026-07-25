import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { createProject } from "../../domain/projects.js";
import { jsonResult } from "../toolResult.js";

export function registerProjectTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "create_project",
    {
      description: "Register a project root so tasks can be created against it.",
      inputSchema: {
        name: z.string().min(1),
        root_path: z.string().min(1),
      },
    },
    async ({ name, root_path }) => {
      const project = createProject(db, { name, root_path });
      return jsonResult({ project_id: project.id });
    },
  );
}
