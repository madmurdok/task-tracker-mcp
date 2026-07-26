import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import type { BudgetEstimator } from "../../domain/budget.js";
import { createTask, splitTask } from "../../domain/tasks.js";
import { jsonResult } from "../toolResult.js";

const subtaskShape = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  file_paths: z.array(z.string()).optional(),
});

export function registerTaskTools(
  server: McpServer,
  db: DatabaseInstance,
  estimator: BudgetEstimator,
): void {
  server.registerTool(
    "create_task",
    {
      description:
        "Create a task under a project, with its file list and an estimated context cost. project_id accepts a project id or its unique name.",
      inputSchema: {
        project_id: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        file_paths: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      const { task, over_budget } = createTask(db, estimator, input);
      return jsonResult({
        task_id: task.id,
        estimated_tokens: task.estimated_tokens,
        over_budget,
      });
    },
  );

  server.registerTool(
    "split_task",
    {
      description:
        "Replace a task with subtasks; dependents and prerequisites are rewired onto them.",
      inputSchema: {
        task_id: z.string().min(1),
        subtasks: z.array(subtaskShape).min(1),
      },
    },
    async ({ task_id, subtasks }) => jsonResult(splitTask(db, estimator, task_id, subtasks)),
  );
}
