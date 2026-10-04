import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import {
  cancelRelease,
  CompletionVerificationError,
  releaseIt,
  ReleaseNotAllDoneError,
} from "../../domain/lifecycle.js";
import {
  createRelease,
  setReleaseDetails,
  setReleaseSequence,
  setTaskRelease,
} from "../../domain/releases.js";
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
        "Ship a release: rejects unless every task in it is done or cancelled (not force-skippable), then requires test_command or force:true (force skips the test gate, not the all-done gate), runs test_command through the same verifier complete_task uses, generates release_notes from the done tasks (plus a Cancelled section for cancelled ones), and marks the release released. One-shot, like complete_task - rejects a release that is already released or cancelled.",
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
    "cancel_release",
    {
      description:
        "Record a release as cancelled - built but deliberately not shipped (a gate said don't ship it, a branch that will never be merged) - so it stops sitting on the board as an unfinished 'planned' release. reason is mandatory: it's the whole point of the record, and the only thing the dashboard has to show for that lane (a cancelled release never reaches release_it, so it has no release_notes). project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project. Rejects a release that is already released or already cancelled; one-shot, there is no un-cancel. Leaves the release's tasks untouched - salvageable work is moved into a later release with set_task_release, which is allowed *out of* a cancelled release even though no new task can be assigned *into* one.",
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async ({ project_id, release_id, reason }) => {
      cancelRelease(db, { project_id, release_id, reason });
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "set_task_release",
    {
      description:
        "Move a task to a different release, or clear it (pass null) - e.g. when a task turns out not to belong in a release. Rejects if either the task's current release or its target release is already released, and rejects a cancelled release as a target. Moving a task *out of* a cancelled release is deliberately allowed - that's how salvageable work is rescued into a later release. Accepts a task's uuid or its code (`TTM-63`).",
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
        "Reorder where a release shows up in list_releases (e.g. slot a hotfix between two existing releases). Not blocked by the release already being released or cancelled. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project.",
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

  server.registerTool(
    "set_release_details",
    {
      description:
        "Rename a release and/or rewrite its description - the only release fields that can change after create_release. Pass at least one of name and description; an omitted field is left as is, and null or \"\" clears it to empty (a release should have a real name or none, never a placeholder). Nothing else is writable here: version is an identifier (unique, accepted as release_id), status, released_at, release_notes and cancellation_reason belong to release_it/cancel_release, and sequence has set_release_sequence. Not blocked by the release being released or cancelled: those freeze task membership, and release_notes are built from task titles and summaries, never from the release's name or description. project_id accepts a project id or its unique name; release_id accepts a release id or its version within that project.",
      inputSchema: {
        project_id: z.string().min(1),
        release_id: z.string().min(1),
        name: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      },
    },
    async ({ project_id, release_id, name, description }) => {
      const release = setReleaseDetails(db, { project_id, release_id, name, description });
      return jsonResult({
        release_id: release.id,
        version: release.version,
        name: release.name,
        description: release.description,
      });
    },
  );
}
