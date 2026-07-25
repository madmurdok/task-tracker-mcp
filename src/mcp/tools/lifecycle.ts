import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { addHandoffNote } from "../../domain/handoffNotes.js";
import { claimTask, completeTask } from "../../domain/lifecycle.js";
import { jsonResult } from "../toolResult.js";

export function registerLifecycleTools(server: McpServer, db: DatabaseInstance): void {
  server.registerTool(
    "claim_task",
    {
      description: "Record which session is working a task (informational in v1, not a hard lock).",
      inputSchema: {
        task_id: z.string().min(1),
        session_id: z.string().min(1),
      },
    },
    async ({ task_id, session_id }) => {
      claimTask(db, task_id, session_id);
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "add_handoff_note",
    {
      description: "Persist decisions/remaining-work/discoveries for a task so a fresh session can resume.",
      inputSchema: {
        task_id: z.string().min(1),
        session_id: z.string().min(1),
        decisions: z.string().optional(),
        remaining_work: z.string().optional(),
        discoveries: z.string().optional(),
      },
    },
    async (input) => {
      addHandoffNote(db, input);
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task done and report which dependent tasks are now unblocked.",
      inputSchema: {
        task_id: z.string().min(1),
        summary: z.string().optional(),
      },
    },
    async ({ task_id }) => {
      const result = completeTask(db, task_id);
      return jsonResult({ ok: true, ...result });
    },
  );
}
