import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("exercises all 26 registered tools over the same transport", async () => {
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
        "create_epic",
        "list_epics",
        "get_epic_status",
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
        "cancel_task",
        "get_task",
        "set_task_priority",
        "create_release",
        "list_releases",
        "get_release_status",
        "release_it",
        "set_task_release",
        "set_release_sequence",
        "create_tasks",
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

    const { epic_id } = await call("create_epic", { project_id, name: "Auth rework" });

    const { task_id: prereqId } = await call("create_task", {
      project_id,
      epic_id,
      title: "Prereq",
      complexity_hint: "normal",
    });
    const { task_id: bigTaskId } = await call("create_task", {
      project_id,
      epic_id,
      title: "Too big",
      complexity_hint: "normal",
    });
    await call("add_dependency", { task_id: bigTaskId, depends_on_task_id: prereqId });

    const { new_task_ids } = await call("split_task", {
      task_id: bigTaskId,
      subtasks: [{ title: "Part 1" }, { title: "Part 2" }],
    });
    expect(new_task_ids).toHaveLength(2);

    await call("set_task_priority", { task_id: new_task_ids[0], priority: 10 });
    const prioritized = await call("get_task", { task_id: new_task_ids[0] });
    expect(prioritized.priority).toBe(10);

    const listed = await call("list_tasks", { project_id });
    expect(listed.tasks).toHaveLength(3); // prereq + 2 subtasks (original was replaced)

    const listedByEpic = await call("list_tasks", { project_id, epic_id });
    expect(listedByEpic.tasks).toHaveLength(3); // all of them stayed under the epic

    const { epics } = await call("list_epics", { project_id });
    expect(epics).toEqual([expect.objectContaining({ id: epic_id, name: "Auth rework", total: 3 })]);

    const epicStatus = await call("get_epic_status", { project_id, epic_id: "Auth rework" });
    expect(epicStatus).toMatchObject({ id: epic_id, total: 3, pending: 1, blocked: 2 });

    const statusBefore = await call("get_project_status", { project_id: "Demo" });
    expect(statusBefore.total).toBe(3);

    const next = await call("get_next_task", { project_id });
    expect(next.task.id).toBe(prereqId);
    expect(next.task.file_paths).toEqual([]);
    expect(next.task.handoff_notes).toEqual([]);

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

    // get_task: side-effect-free re-inspection, unlike get_next_task it doesn't
    // touch ownership/lock state - the prior claim_task above stays untouched.
    const fetched = await call("get_task", { task_id: prereqId });
    expect(fetched.handoff_notes).toMatchObject([{ session_id: "session-1", decisions: "none needed" }]);
    expect(fetched.status).toBe("in_progress");
    expect(fetched.owner_session_id).toBe("session-1");

    const { unblocked_task_ids } = await call("complete_task", {
      task_id: prereqId,
      summary: "done",
    });
    expect(unblocked_task_ids.sort()).toEqual([...new_task_ids].sort());

    const cancelled = await call("cancel_task", {
      task_id: new_task_ids[0],
      reason: "turned out to be unnecessary",
    });
    expect(cancelled.ok).toBe(true);
    const afterCancel = await call("list_tasks", { project_id, status: "cancelled" });
    expect(afterCancel.tasks).toEqual([expect.objectContaining({ id: new_task_ids[0] })]);
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
      complexity_hint: "normal",
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
      complexity_hint: "normal",
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

  it("exercises the full release lifecycle, including its distinct error shapes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-release-e2e-"));
    try {
      await releaseLifecycleScenario(db, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exercises create_tasks end to end, wiring a temp_id-to-temp_id dependency", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, payload: JSON.parse(content[0].text) };
    };

    const { payload: project } = await call("create_project", { name: "Demo", root_path: "/tmp/demo" });

    const { payload: batch } = await call("create_tasks", {
      project_id: project.project_id,
      tasks: [
        { temp_id: "schema", title: "Build schema", complexity_hint: "normal" },
        {
          temp_id: "domain",
          title: "Build domain layer",
          complexity_hint: "normal",
          depends_on: ["schema"],
        },
      ],
    });

    expect(batch.tasks).toHaveLength(2);
    const schemaTask = batch.tasks.find((t: { temp_id: string }) => t.temp_id === "schema");
    const domainTask = batch.tasks.find((t: { temp_id: string }) => t.temp_id === "domain");
    expect(schemaTask.task_id).toBeTruthy();
    expect(domainTask.task_id).toBeTruthy();

    const next = await call("get_next_task", { project_id: project.project_id });
    expect(next.payload.task.id).toBe(schemaTask.task_id);

    const listed = await call("list_tasks", { project_id: project.project_id });
    expect(listed.payload.tasks).toHaveLength(2);
  });
});

async function releaseLifecycleScenario(db: DatabaseInstance, rootPath: string): Promise<void> {
  const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, payload: JSON.parse(content[0].text) };
    };

    const { payload: project } = await call("create_project", { name: "Demo", root_path: rootPath });
    const { payload: release } = await call("create_release", {
      project_id: project.project_id,
      version: "0.1",
    });
    expect(release.release_id).toBeTruthy();

    const { payload: shipped } = await call("create_task", {
      project_id: project.project_id,
      release_id: release.release_id,
      title: "Add login form",
      complexity_hint: "normal",
    });
    const { payload: dropped } = await call("create_task", {
      project_id: project.project_id,
      release_id: "0.1",
      title: "Add SSO (descoped)",
      complexity_hint: "normal",
    });

    // Gate 1: rejects while tasks are still pending, with a distinct shape - and
    // this isn't skippable by force.
    const tooEarly = await call("release_it", {
      project_id: project.project_id,
      release_id: release.release_id,
      force: true,
    });
    expect(tooEarly.isError).toBe(true);
    expect(tooEarly.payload.error).toBe("not_all_done");
    expect(tooEarly.payload.pending_task_ids.sort()).toEqual(
      [shipped.task_id, dropped.task_id].sort(),
    );

    await call("complete_task", { task_id: shipped.task_id, summary: "wired up the login form" });
    await call("cancel_task", { task_id: dropped.task_id, reason: "descoped for this release" });

    // Gate 2: all tasks resolved now, but no test_command/force - reuses
    // complete_task's verification_failed shape rather than a silent pass.
    const noTestCommand = await call("release_it", {
      project_id: project.project_id,
      release_id: release.release_id,
    });
    expect(noTestCommand.isError).toBe(true);
    expect(noTestCommand.payload.error).toBe("verification_failed");

    const released = await call("release_it", {
      project_id: project.project_id,
      release_id: release.release_id,
      test_command: "true",
    });
    expect(released.isError).toBeFalsy();
    expect(released.payload.release_notes).toBe(
      "- Add login form: wired up the login form\n\nCancelled:\n- Add SSO (descoped): descoped for this release",
    );

    const status = await call("get_release_status", {
      project_id: project.project_id,
      release_id: "0.1",
    });
    expect(status.payload).toMatchObject({ total: 2, done: 1, cancelled: 1 });

    const { payload: listed } = await call("list_releases", { project_id: project.project_id });
    expect(listed.releases).toEqual([
      expect.objectContaining({ id: release.release_id, status: "released", total: 2 }),
    ]);

    // set_task_release / set_release_sequence, exercised against a second,
    // still-open release.
    const { payload: nextRelease } = await call("create_release", {
      project_id: project.project_id,
      version: "0.2",
    });
    const { payload: extra } = await call("create_task", {
      project_id: project.project_id,
      title: "Unassigned",
      complexity_hint: "normal",
    });
    const moved = await call("set_task_release", {
      task_id: extra.task_id,
      release_id: nextRelease.release_id,
    });
    expect(moved.isError).toBeFalsy();

    const reordered = await call("set_release_sequence", {
      project_id: project.project_id,
      release_id: nextRelease.release_id,
      sequence: 5,
    });
    expect(reordered.isError).toBeFalsy();
    const { payload: reListed } = await call("list_releases", { project_id: project.project_id });
    expect(reListed.releases[0].id).toBe(nextRelease.release_id); // sequence 5 now sorts first
}
