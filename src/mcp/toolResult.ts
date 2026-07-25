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
