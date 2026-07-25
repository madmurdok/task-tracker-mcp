import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { checkDocSync, createProject } from "../../domain/projects.js";
import { jsonResult } from "../toolResult.js";

export function registerProjectTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "create_project",
    {
      description:
        "Register a project root so tasks can be created against it. Pass design_doc_path (relative to root_path) to track that doc for later check_doc_sync calls.",
      inputSchema: {
        name: z.string().min(1),
        root_path: z.string().min(1),
        design_doc_path: z.string().optional(),
      },
    },
    async ({ name, root_path, design_doc_path }) => {
      const project = createProject(db, { name, root_path, design_doc_path });
      return jsonResult({ project_id: project.id, design_doc_hash: project.design_doc_hash });
    },
  );

  server.registerTool(
    "check_doc_sync",
    {
      description:
        "Check whether a project's tracked design doc has changed since create_project last hashed it. tracked:false means no design_doc_path was ever set - nothing to compare.",
      inputSchema: {
        project_id: z.string().min(1),
      },
    },
    async ({ project_id }) => {
      const result = checkDocSync(db, project_id);
      return jsonResult(result);
    },
  );
}
