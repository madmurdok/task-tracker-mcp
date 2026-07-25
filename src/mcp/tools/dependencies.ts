import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { addDependency } from "../../domain/dependencies.js";
import { jsonResult } from "../toolResult.js";

export function registerDependencyTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "add_dependency",
    {
      description: "Declare that a task depends on another task. Rejects cycles.",
      inputSchema: {
        task_id: z.string().min(1),
        depends_on_task_id: z.string().min(1),
      },
    },
    async ({ task_id, depends_on_task_id }) => {
      addDependency(db, task_id, depends_on_task_id);
      return jsonResult({ ok: true });
    },
  );
}
