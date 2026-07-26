import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import {
  CompletionVerificationError,
  releaseIt,
  ReleaseNotAllDoneError,
} from "../../domain/lifecycle.js";
import { createRelease, setReleaseSequence, setTaskRelease } from "../../domain/releases.js";
import { getReleaseStatus, listReleasesWithStatus } from "../../domain/status.js";
import type { CompletionVerifier } from "../../domain/verification.js";
import { jsonResult, notAllDoneResult, verificationFailedResult } from "../toolResult.js";

export function registerReleaseTools(
  server: McpServer,
  db: DatabaseInstance,
  verifier: CompletionVerifier,
): void {
  server.registerTool(
    "create_release",
    {
      description:
        "Create a release to group tasks by version, orthogonal to epics (which group by feature). project_id accepts a project id or its unique name. version must be unique within the project (but can repeat across different projects).",
      inputSchema: {
        project_id: z.string().min(1),
        version: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ project_id, version, name, description }) => {
      const release = createRelease(db, { project_id, version, name, description });
      return jsonResult({ release_id: release.id });
    },
  );

  server.registerTool(
    "list_releases",
    {
      description:
        "List releases for a project with aggregate task status counts per release, ordered by their sequence (not creation time - see set_release_sequence). project_id accepts a project id or its unique name.",
      inputSchema: { project_id: z.string().min(1) },
    },
    async ({ project_id }) => jsonResult({ releases: listReleasesWithStatus(db, project_id) }),
  );

  server.registerTool(
    "get_release_status",
    {
      description:
        "Aggregate task counts (and completion percent) for a single release. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
      },
    },
    async ({ project_id, release_id }) => jsonResult(getReleaseStatus(db, project_id, release_id)),
  );

  server.registerTool(
    "release_it",
    {
      description:
        "Ship a release: rejects unless every task in it is done or cancelled (not force-skippable), then requires test_command or force:true (force skips the test gate, not the all-done gate), runs test_command through the same verifier complete_task uses, generates release_notes from the done tasks (plus a Cancelled section for cancelled ones), and marks the release released. One-shot, like complete_task.",
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
        test_command: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ project_id, release_id, test_command, force }) => {
      let result;
      try {
        result = releaseIt(db, verifier, { project_id, release_id, test_command, force });
      } catch (error) {
        if (error instanceof ReleaseNotAllDoneError) {
          return notAllDoneResult({ message: error.message, pending_task_ids: error.pendingTaskIds });
        }
        if (error instanceof CompletionVerificationError) {
          return verificationFailedResult({ message: error.message, reason: error.reason });
        }
        throw error;
      }
      return jsonResult({ ok: true, ...result });
    },
  );

  server.registerTool(
    "set_task_release",
    {
      description:
        "Move a task to a different release, or clear it (pass null) - e.g. when a task turns out not to belong in a release. Rejects if either the task's current release or its target release is already released.",
      inputSchema: {
        task_id: z.string().min(1),
        release_id: z.string().nullable(),
      },
    },
    async ({ task_id, release_id }) => {
      setTaskRelease(db, task_id, release_id);
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "set_release_sequence",
    {
      description:
        "Reorder where a release shows up in list_releases (e.g. slot a hotfix between two existing releases). Not blocked by the release already being released. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
        sequence: z.number().int(),
      },
    },
    async ({ project_id, release_id, sequence }) => {
      setReleaseSequence(db, project_id, release_id, sequence);
      return jsonResult({ ok: true });
    },
  );
}
