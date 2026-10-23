import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../db/connection.js";
import { HeuristicBudgetEstimator } from "../domain/budget.js";
import { GitDiffCompletionVerifier } from "../domain/verification.js";
import { registerBackupTools } from "./tools/backup.js";
import { registerDependencyTools } from "./tools/dependencies.js";
import { registerEpicTools } from "./tools/epics.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerPlanTools } from "./tools/plans.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerReleaseTools } from "./tools/releases.js";
import { registerSliceTools } from "./tools/slices.js";
import { registerStatusTools } from "./tools/status.js";
import { registerTaskTools } from "./tools/tasks.js";
import { packageVersion } from "../version.js";

export function createServer(db: DatabaseInstance): McpServer {
  // Read from package.json, never retyped here. This literal said "0.5.0"
  // through two releases, and an honest handshake version is the only way a
  // client can tell it is talking to a build older than a fix it depends on -
  // see src/version.ts for what that cost.
  const server = new McpServer({ name: "task-tracker-mcp", version: packageVersion() });
  const estimator = new HeuristicBudgetEstimator();
  const verifier = new GitDiffCompletionVerifier();

  registerProjectTools(server, db);
  registerEpicTools(server, db);
  registerReleaseTools(server, db, verifier);
  registerTaskTools(server, db, estimator);
  registerDependencyTools(server, db);
  registerStatusTools(server, db);
  registerLifecycleTools(server, db, verifier);
  registerPlanTools(server, db);
  registerSliceTools(server, db);
  registerBackupTools(server, db);

  return server;
}
