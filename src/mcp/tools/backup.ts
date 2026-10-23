import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { BackupRefusal, exportToFile, importFromFile, RootPathMapError } from "../../domain/backup.js";
import { backupRefusalResult, errorResult, jsonResult } from "../toolResult.js";

export function registerBackupTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "export_projects",
    {
      description:
        "Export one project (project_id: id or unique name) or every project (all:true) to a JSON backup file at out_path. Exactly one of project_id/all is required. out_path must be absolute; the database file and its -wal/-shm are refused (forbidden_out_path). Returns only the written path, the projects, per-table row counts and external_dependencies (edges pointing at tasks outside the export) - never the file's content. Restore with import_projects.",
      inputSchema: {
        project_id: z.string().min(1).optional(),
        all: z.boolean().optional(),
        out_path: z.string().min(1),
      },
    },
    async ({ project_id, all, out_path }) => {
      if (!path.isAbsolute(out_path)) return errorResult(`out_path must be an absolute path: ${out_path}`);
      if ((project_id !== undefined) === (all === true)) {
        return errorResult("Pass exactly one of project_id or all:true");
      }
      try {
        const result = exportToFile(db, project_id !== undefined ? project_id : { all: true }, out_path);
        return jsonResult(result);
      } catch (error) {
        if (error instanceof BackupRefusal) {
          return backupRefusalResult({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "import_projects",
    {
      description:
        "Import projects from a JSON file written by export_projects into this database, all or nothing. path must be absolute. Refuses (isError, error = code) an unsupported format or version, a schema_mismatch, a clash with existing ids/names/prefixes, a dangling_reference, or an unknown_project; nothing is inserted on refusal. root_path_map maps old absolute project root prefixes to new ones ({\"/old/root\": \"/new/root\"}) for a restore on another machine. Returns the path, imported projects, per-table inserted counts, skipped_dependencies and root-path rewrite reports - never the file's content.",
      inputSchema: {
        path: z.string().min(1),
        root_path_map: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ path: filePath, root_path_map }) => {
      if (!path.isAbsolute(filePath)) return errorResult(`path must be an absolute path: ${filePath}`);
      const entries = Object.entries(root_path_map ?? {}).map(([from, to]) => `${from}=${to}`);
      try {
        return jsonResult(importFromFile(db, filePath, { rootPathMap: entries }));
      } catch (error) {
        if (error instanceof BackupRefusal) {
          return backupRefusalResult({ code: error.code, message: error.message, details: error.details });
        }
        if (error instanceof RootPathMapError) return errorResult(error.message);
        throw error;
      }
    },
  );
}
