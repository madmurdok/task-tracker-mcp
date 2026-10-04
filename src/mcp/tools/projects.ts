import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { checkDocSync, createProject, listProjects, setDesignDoc } from "../../domain/projects.js";
import { jsonResult } from "../toolResult.js";

export function registerProjectTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "create_project",
    {
      description:
        "Register a project root so tasks can be created against it. name must be unique across all projects - other tools accept it interchangeably with project_id. Pass design_doc_path (relative to root_path) to track that doc for later check_doc_sync calls.",
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
    "list_projects",
    {
      description: "List all registered projects (id, name, root_path) so a project_id or name can be looked up without remembering it.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        projects: listProjects(db).map(({ id, name, root_path }) => ({ id, name, root_path })),
      }),
  );

  server.registerTool(
    "check_doc_sync",
    {
      description:
        "Check whether a project's tracked design doc has changed since create_project last hashed it (or since the last acknowledge). tracked:false means no design_doc_path was ever set - nothing to compare. project_id accepts a project id or its unique name. Pass acknowledge:true once the task graph has been manually reconciled with the doc's new content - this persists the current hash as the new baseline in place (no need to re-run create_project), so doc_drift stops being reported by get_next_task/get_project_status.",
      inputSchema: {
        project_id: z.string().min(1),
        acknowledge: z.boolean().optional(),
      },
    },
    async ({ project_id, acknowledge }) => {
      const result = checkDocSync(db, project_id, { acknowledge });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "set_design_doc",
    {
      description:
        "Set or clear the design doc tracked for an existing project, so a project registered without design_doc_path can still get drift detection. design_doc_path is resolved against the project's root_path and hashed now as the new baseline, as create_project does; pass null to stop tracking (check_doc_sync then reports tracked:false). Rejects a path that cannot be read, naming the resolved path, and stores nothing. project_id accepts a project id or its unique name.",
      inputSchema: {
        project_id: z.string().min(1),
        design_doc_path: z.string().min(1).nullable(),
      },
    },
    async ({ project_id, design_doc_path }) => {
      const project = setDesignDoc(db, project_id, design_doc_path);
      return jsonResult({
        project_id: project.id,
        design_doc_path: project.design_doc_path,
        design_doc_hash: project.design_doc_hash,
      });
    },
  );
}
