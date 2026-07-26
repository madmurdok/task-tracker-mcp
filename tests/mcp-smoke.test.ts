import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { createServer } from "../src/mcp/server.js";

async function connectedClient(db: DatabaseInstance) {
  const server = createServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return client;
}

describe("MCP server smoke test", () => {
  let db: DatabaseInstance;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("lists the registered tools", async () => {
    const client = await connectedClient(db);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toContain("create_project");
  });

  it("calls create_project end to end over the transport", async () => {
    const client = await connectedClient(db);

    const result = await client.callTool({
      name: "create_project",
      arguments: { name: "Demo", root_path: "/tmp/demo" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    expect(payload.project_id).toBeTruthy();

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(payload.project_id);
    expect(row).toMatchObject({ name: "Demo", root_path: "/tmp/demo" });
  });

  it("exercises all 13 registered tools over the same transport", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text);
    };

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_project",
        "list_projects",
        "check_doc_sync",
        "create_task",
        "add_dependency",
        "split_task",
        "get_next_task",
        "list_tasks",
        "get_project_status",
        "claim_task",
        "release_task",
        "add_handoff_note",
        "complete_task",
      ].sort(),
    );

    const { project_id } = await call("create_project", { name: "Demo", root_path: "/tmp/demo" });

    const { projects } = await call("list_projects", {});
    expect(projects).toEqual([{ id: project_id, name: "Demo", root_path: "/tmp/demo" }]);

    const syncBeforeDoc = await call("check_doc_sync", { project_id: "Demo" });
    expect(syncBeforeDoc).toEqual({
      tracked: false,
      in_sync: true,
      design_doc_path: null,
      stored_hash: null,
      current_hash: null,
    });

    const { task_id: prereqId } = await call("create_task", {
      project_id,
      title: "Prereq",
    });
    const { task_id: bigTaskId } = await call("create_task", {
      project_id,
      title: "Too big",
    });
    await call("add_dependency", { task_id: bigTaskId, depends_on_task_id: prereqId });

    const { new_task_ids } = await call("split_task", {
      task_id: bigTaskId,
      subtasks: [{ title: "Part 1" }, { title: "Part 2" }],
    });
    expect(new_task_ids).toHaveLength(2);

    const listed = await call("list_tasks", { project_id });
    expect(listed.tasks).toHaveLength(3); // prereq + 2 subtasks (original was replaced)

    const statusBefore = await call("get_project_status", { project_id: "Demo" });
    expect(statusBefore.total).toBe(3);

    const next = await call("get_next_task", { project_id });
    expect(next.task.id).toBe(prereqId);

    await call("claim_task", { task_id: prereqId, session_id: "session-1" });

    // release_task: giving it up puts it straight back to pending, no need to
    // wait out the lease, and a different session can then claim it.
    await call("release_task", { task_id: prereqId, session_id: "session-1" });
    const reclaimed = await call("get_next_task", { project_id });
    expect(reclaimed.task.id).toBe(prereqId);
    await call("claim_task", { task_id: prereqId, session_id: "session-1" });

    await call("add_handoff_note", {
      task_id: prereqId,
      session_id: "session-1",
      decisions: "none needed",
    });
    const { unblocked_task_ids } = await call("complete_task", {
      task_id: prereqId,
      summary: "done",
    });
    expect(unblocked_task_ids.sort()).toEqual([...new_task_ids].sort());
  });

  it("list_projects returns an empty array when nothing is registered yet", async () => {
    const client = await connectedClient(db);
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ projects: [] });
  });

  it("rejects an unknown project ref and a duplicate project name with isError", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, text: content[0].text };
    };

    const unknownRef = await call("get_project_status", { project_id: "no-such-project" });
    expect(unknownRef.isError).toBe(true);
    expect(unknownRef.text).toMatch(/Unknown project: no-such-project/);

    await call("create_project", { name: "Demo", root_path: "/tmp/demo" });
    const duplicate = await call("create_project", { name: "Demo", root_path: "/tmp/other" });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/Project name already in use: Demo/);
  });

  it("returns a distinct conflict shape for claim_task ownership contention", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, payload: JSON.parse(content[0].text) };
    };

    const { payload: project } = await call("create_project", { name: "Demo", root_path: "/tmp/demo" });
    const { payload: created } = await call("create_task", {
      project_id: project.project_id,
      title: "Solo task",
    });
    await call("get_next_task", { project_id: project.project_id });
    await call("claim_task", { task_id: created.task_id, session_id: "session-1" });

    const { isError, payload } = await call("claim_task", {
      task_id: created.task_id,
      session_id: "session-2",
    });

    expect(isError).toBe(true);
    expect(payload).toMatchObject({
      error: "conflict",
      current_owner_session_id: "session-1",
    });
    expect(payload.lock_expires_at).toBeTruthy();
  });

  it("returns a distinct verification_failed shape when complete_task's checks don't pass, and force skips them", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, payload: JSON.parse(content[0].text) };
    };

    const { payload: project } = await call("create_project", { name: "Demo", root_path: "/tmp/demo" });
    const { payload: created } = await call("create_task", {
      project_id: project.project_id,
      title: "Has declared files that never changed",
      file_paths: ["never-touched.txt"],
    });
    await call("get_next_task", { project_id: project.project_id });
    await call("claim_task", { task_id: created.task_id, session_id: "session-1" });

    const failed = await call("complete_task", { task_id: created.task_id, summary: "done" });
    expect(failed.isError).toBe(true);
    expect(failed.payload.error).toBe("verification_failed");
    expect(failed.payload.reason).toBeTruthy();

    const forced = await call("complete_task", {
      task_id: created.task_id,
      summary: "done",
      force: true,
    });
    expect(forced.isError).toBeFalsy();
    expect(forced.payload.ok).toBe(true);
  });
});
