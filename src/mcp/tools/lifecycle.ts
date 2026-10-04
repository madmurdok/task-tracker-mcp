import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseInstance } from "../../db/connection.js";
import { addHandoffNote } from "../../domain/handoffNotes.js";
import {
  cancelTask,
  claimTask,
  completeTask,
  CompletionVerificationError,
  OpenSlicesError,
  releaseTask,
  TaskBlockedError,
  TaskConflictError,
  TaskNotClaimableError,
} from "../../domain/lifecycle.js";
import type { CompletionVerifier } from "../../domain/verification.js";
import {
  blockedResult,
  conflictResult,
  jsonResult,
  notClaimableResult,
  openSlicesResult,
  verificationFailedResult,
} from "../toolResult.js";

export function registerLifecycleTools(
  server: McpServer,
  db: DatabaseInstance,
  verifier: CompletionVerifier,
): void {
  server.registerTool(
    "claim_task",
    {
      description:
        "Take a specific task into work: moves a pending, unblocked task straight to in_progress, or attaches/renews ownership on a task already in_progress (e.g. right after get_next_task). Use this to hand a specific task to a specific session instead of pulling from the priority queue. Rejects with a conflict error if another session's lock is still active, a blocked error if the task has unmet dependencies, or a not_claimable error if it's already done/cancelled. Accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        session_id: z.string().min(1),
      },
    },
    async ({ task_id, session_id }) => {
      try {
        claimTask(db, task_id, session_id);
      } catch (error) {
        if (error instanceof TaskConflictError) {
          return conflictResult({
            message: error.message,
            current_owner_session_id: error.currentOwnerSessionId,
            lock_expires_at: error.lockExpiresAt,
          });
        }
        if (error instanceof TaskBlockedError) {
          return blockedResult({ message: error.message });
        }
        if (error instanceof TaskNotClaimableError) {
          return notClaimableResult({ message: error.message, status: error.status });
        }
        throw error;
      }
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "release_task",
    {
      description:
        "Release ownership of a task so it's immediately available again, instead of waiting for its lock to expire. Pass force to override another session's still-active lock. Accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        session_id: z.string().min(1),
        force: z.boolean().optional(),
      },
    },
    async ({ task_id, session_id, force }) => {
      try {
        releaseTask(db, { task_id, session_id, force });
      } catch (error) {
        if (error instanceof TaskConflictError) {
          return conflictResult({
            message: error.message,
            current_owner_session_id: error.currentOwnerSessionId,
            lock_expires_at: error.lockExpiresAt,
          });
        }
        throw error;
      }
      return jsonResult({ ok: true });
    },
  );

  server.registerTool(
    "add_handoff_note",
    {
      description: "Persist decisions/remaining-work/discoveries for a task so a fresh session can resume. Accepts a task's uuid or its code (`TTM-63`).",
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
      description:
        "Mark a task done and report which dependent tasks are now unblocked. Refuses with error:'open_slices' while any of the task's slices (see set_task_slices) is still pending or in_progress, naming each one (`S2 \"title\" (pending)`) - complete, fail or skip them first. Verifies the task's declared files actually changed (and runs test_command, if given) before accepting the completion. Declared paths outside the project's git repository cannot be checked: a passing completion then lists them in unverified_paths (the field is absent otherwise). Pass force to skip both the open-slices guard and verification. Accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        summary: z.string().optional(),
        test_command: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ task_id, summary, test_command, force }) => {
      let result;
      try {
        result = completeTask(db, verifier, { task_id, summary, test_command, force });
      } catch (error) {
        if (error instanceof OpenSlicesError) {
          return openSlicesResult({
            message: error.message,
            open_slices: error.openSlices.map(({ id, ref, label, title, status }) => ({ id, ref, label, title, status })),
          });
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
    "cancel_task",
    {
      description:
        "Abandon a task that turns out unnecessary, instead of dishonestly force-completing it. Unblocks dependents the same way complete_task does. Rejects with a conflict error if another session's lock on it is still active, unless force is given. Accepts a task's uuid or its code (`TTM-63`).",
      inputSchema: {
        task_id: z.string().min(1),
        reason: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ task_id, reason, force }) => {
      let result;
      try {
        result = cancelTask(db, { task_id, reason, force });
      } catch (error) {
        if (error instanceof TaskConflictError) {
          return conflictResult({
            message: error.message,
            current_owner_session_id: error.currentOwnerSessionId,
            lock_expires_at: error.lockExpiresAt,
          });
        }
        throw error;
      }
      return jsonResult({ ok: true, ...result });
    },
  );
}
