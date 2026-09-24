import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

export function conflictResult(details: {
  message: string;
  current_owner_session_id: string | null;
  lock_expires_at: string | null;
}): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "conflict", ...details }) }],
    isError: true,
  };
}

export function verificationFailedResult(details: { message: string; reason: string }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "verification_failed", ...details }) }],
    isError: true,
  };
}

export function notAllDoneResult(details: { message: string; pending_task_ids: string[] }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "not_all_done", ...details }) }],
    isError: true,
  };
}

export function blockedResult(details: { message: string }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "blocked", ...details }) }],
    isError: true,
  };
}

export function notClaimableResult(details: { message: string; status: string }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "not_claimable", ...details }) }],
    isError: true,
  };
}

export function openSlicesResult(details: {
  message: string;
  open_slices: Array<{ id: string; ref: string; label: string; title: string; status: string }>;
}): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "open_slices", ...details }) }],
    isError: true,
  };
}
