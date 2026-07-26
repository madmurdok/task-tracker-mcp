import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import type { BudgetEstimator } from "../../domain/budget.js";
import { createTask, createTasks, setTaskPriority, splitTask } from "../../domain/tasks.js";
import { jsonResult } from "../toolResult.js";

const complexityHintEnum = z.enum(["normal", "high"]);

const subtaskShape = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  file_paths: z.array(z.string()).optional(),
  complexity_hint: complexityHintEnum.optional(),
  priority: z.number().int().optional(),
});

const batchTaskShape = z.object({
  temp_id: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  file_paths: z.array(z.string()).optional(),
  epic_id: z.string().optional(),
  release_id: z.string().optional(),
  complexity_hint: complexityHintEnum,
  priority: z.number().int().optional(),
  depends_on: z.array(z.string()).optional(),
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
        "Create a task under a project, with its file list and an estimated context cost. project_id accepts a project id or its unique name. epic_id (optional) accepts an epic id or its name within that project. release_id (optional) accepts a release id or its version within that project - rejects an already-released release. complexity_hint is required - 'high' flags a task as worth delegating to a stronger subagent (see CLAUDE.md's Task delegation section). priority (optional, default 0) - higher sorts first in get_next_task.",
      inputSchema: {
        project_id: z.string().min(1),
        epic_id: z.string().optional(),
        release_id: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        file_paths: z.array(z.string()).optional(),
        complexity_hint: complexityHintEnum,
        priority: z.number().int().optional(),
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
    "create_tasks",
    {
      description:
        "Create a batch of tasks in one call, instead of one create_task + one add_dependency per edge - useful for planning a whole design doc's worth of tasks at once. project_id accepts a project id or its unique name. Each task's optional temp_id lets its depends_on reference a sibling created earlier in this same batch before it has a real id; a depends_on entry that isn't a temp_id in this batch is treated as an existing task_id, so a batch can also wire new tasks onto an already-existing graph. The whole call rolls back together on any error (unknown epic/release, cyclic dependency, etc.).",
      inputSchema: {
        project_id: z.string().min(1),
        tasks: z.array(batchTaskShape).min(1),
      },
    },
    async ({ project_id, tasks }) => jsonResult(createTasks(db, estimator, project_id, tasks)),
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

  server.registerTool(
    "set_task_priority",
    {
      description:
        "Adjust a task's priority after creation, once its importance turns out different than assumed. Higher sorts first in get_next_task.",
      inputSchema: {
        task_id: z.string().min(1),
        priority: z.number().int(),
      },
    },
    async ({ task_id, priority }) => {
      setTaskPriority(db, task_id, priority);
      return jsonResult({ ok: true });
    },
  );
}
