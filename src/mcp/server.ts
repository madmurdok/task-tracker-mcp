import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../db/connection.js";
import { HeuristicBudgetEstimator } from "../domain/budget.js";
import { registerDependencyTools } from "./tools/dependencies.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerStatusTools } from "./tools/status.js";
import { registerTaskTools } from "./tools/tasks.js";

export function createServer(db: DatabaseInstance): McpServer {
  const server = new McpServer({ name: "task-tracker-mcp", version: "0.1.0" });
  const estimator = new HeuristicBudgetEstimator();

  registerProjectTools(server, db);
  registerTaskTools(server, db, estimator);
  registerDependencyTools(server, db);
  registerStatusTools(server, db);
  registerLifecycleTools(server, db);

  return server;
}
