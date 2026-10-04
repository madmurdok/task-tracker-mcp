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

  it("exercises all 36 registered tools over the same transport", async () => {
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
        "set_design_doc",
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
        "cancel_release",
        "set_task_release",
        "set_release_sequence",
        "create_tasks",
        "delete_task",
        "create_plan",
        "get_plan",
        "approve_plan",
        "amend_task",
        "set_task_slices",
        "revise_task_slices",
        "start_slice",
        "complete_slice",
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

    // create_plan -> get_plan -> approve_plan, over a release and task
    // created here so the plan's own drift check has an easy-to-reason-about
    // batch, isolated from the epic/task graph exercised above.
    const { release_id: planReleaseId } = await call("create_release", {
      project_id,
      version: "1.0",
    });
    const { task_id: planTaskId } = await call("create_task", {
      project_id,
      release_id: planReleaseId,
      title: "Ship it",
      complexity_hint: "normal",
    });

    const plan = await call("create_plan", {
      project_id,
      release_id: planReleaseId,
      steps: [planTaskId],
      rationale: "only one task in this batch, so one step",
      verbose: true,
    });
    expect(plan.status).toBe("draft");
    expect(plan.items).toEqual([
      expect.objectContaining({ task_id: planTaskId, step: 1, position: 1, status: "pending" }),
    ]);

    // Read the database directly, not just the response - `steps` is a nested
    // shape that could be silently dropped the way `summary` once was for
    // complete_task (see CLAUDE.md). Confirm the row landed, not just an "ok".
    const planRow = db
      .prepare("SELECT * FROM release_plans WHERE release_id = ?")
      .get(planReleaseId) as { id: string; status: string; rationale: string };
    expect(planRow).toMatchObject({ status: "draft", rationale: "only one task in this batch, so one step" });
    const planItemRows = db
      .prepare("SELECT task_id, step, position FROM release_plan_items WHERE plan_id = ?")
      .all(planRow.id);
    expect(planItemRows).toEqual([{ task_id: planTaskId, step: 1, position: 1 }]);

    const fetchedPlan = await call("get_plan", { project_id, release_id: planReleaseId });
    expect(fetchedPlan.status).toBe("draft");
    expect(fetchedPlan.unplanned_task_ids).toEqual([]);
    expect(fetchedPlan.orphaned_task_ids).toEqual([]);
    expect(fetchedPlan.items).toEqual([
      expect.objectContaining({ task_id: planTaskId, code: expect.stringContaining("-") }),
    ]);

    // TTM-87: approve_plan refuses an open batch task with no slices, so give
    // it a minimal placeholder slicing first - the real slicing exercised
    // below (set_task_slices) replaces this one wholesale, which it may only
    // while every slice is still pending (TTM-89).
    await call("set_task_slices", {
      task_id: planTaskId,
      slices: [{ phase: "implement", title: "placeholder" }],
    });

    const approved = await call("approve_plan", {
      project_id,
      release_id: planReleaseId,
      approved_by: "valentin",
      note: "looks right, ship it",
    });
    expect(approved.status).toBe("approved");
    expect(approved.approved_by).toBe("valentin");
    expect(approved.approval_note).toBe("looks right, ship it");

    const approvedRow = db
      .prepare("SELECT status, approved_by, approval_note FROM release_plans WHERE id = ?")
      .get(planRow.id);
    expect(approvedRow).toEqual({
      status: "approved",
      approved_by: "valentin",
      approval_note: "looks right, ship it",
    });

    // amend_task (TTM-81): correcting planTaskId's title after its plan was
    // approved must not drift that approval back to draft - editing a task's
    // text is not a batch-membership change (see planWrites.ts). The original
    // text stays recoverable on get_task alongside the correction.
    const amended = await call("amend_task", {
      task_id: planTaskId,
      title: "Ship it for real",
      reason: "the original title stopped matching what this task now covers",
    });
    expect(amended.amended_fields).toEqual(["title"]);

    const amendedTask = await call("get_task", { task_id: planTaskId });
    expect(amendedTask.title).toBe("Ship it for real");
    expect(amendedTask.amendments).toEqual([
      expect.objectContaining({
        field: "title",
        previous_value: "Ship it",
        reason: "the original title stopped matching what this task now covers",
      }),
    ]);

    const planAfterAmend = await call("get_plan", { project_id, release_id: planReleaseId });
    expect(planAfterAmend.status).toBe("approved");
    expect(planAfterAmend.unplanned_task_ids).toEqual([]);
    expect(planAfterAmend.orphaned_task_ids).toEqual([]);

    // Task slices (TTM-83): written by task uuid here, addressed by readable
    // ref and by uuid below; the refusal shapes live in their own test.
    const sliced = await call("set_task_slices", {
      task_id: planTaskId,
      slices: [{ phase: "design", title: "Decide" }, [{ phase: "implement", title: "Build", model: "opus" }]],
      verbose: true,
    });
    expect(sliced.slices.map((sl: { label: string }) => sl.label)).toEqual(["S1", "S2"]);
    const startedSlice = await call("start_slice", { slice_id: sliced.slices[0].ref });
    expect(startedSlice.status).toBe("in_progress");
    const doneSlice = await call("complete_slice", {
      slice_id: sliced.slices[0].id,
      status: "done",
      result: "decided",
      metrics: { tool_uses: 3 },
      verbose: true,
    });
    expect(doneSlice).toMatchObject({ status: "done", result: "decided", metrics: { tool_uses: 3 } });
    const slicedTask = await call("get_task", { task_id: planTaskId });
    expect(slicedTask.slices.map((sl: { label: string; status: string }) => [sl.label, sl.status])).toEqual([
      ["S1", "done"],
      ["S2", "pending"],
    ]);

    // revise_task_slices (TTM-89): S1 is done, so only the pending S2 is
    // re-cut; S1 keeps its label and report, the new slice is S3.
    const revised = await call("revise_task_slices", {
      task_id: planTaskId,
      slices: [[{ phase: "implement", title: "Build smaller" }, { phase: "verify", title: "Check" }]],
      reason: "S1 decided the build splits in two",
    });
    expect(revised.slices.map((sl: { label: string; status: string }) => [sl.label, sl.status])).toEqual([
      ["S1", "done"],
      ["S3", "pending"],
      ["S4", "pending"],
    ]);
    // Full report/result detail is not in the compact ack - read it back via
    // get_task instead of asking revise_task_slices for verbose:true here.
    const revisedTask = await call("get_task", { task_id: planTaskId });
    expect(revisedTask.slices.map((sl: { label: string; status: string; result: string | null }) => [sl.label, sl.status, sl.result])).toEqual([
      ["S1", "done", "decided"],
      ["S3", "pending", null],
      ["S4", "pending", null],
    ]);
    expect(revisedTask.slice_revisions).toEqual([
      expect.objectContaining({
        reason: "S1 decided the build splits in two",
        replaced_slices: [expect.objectContaining({ label: "S2", title: "Build", model: "opus" })],
      }),
    ]);
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

  it("carries task slices end to end by task code, and complete_task's open_slices refusal with its names intact", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      let payload: unknown;
      try {
        payload = JSON.parse(content[0].text);
      } catch {
        payload = content[0].text;
      }
      return { isError: result.isError, payload: payload as any };
    };

    const { payload: project } = await call("create_project", { name: "Slices", root_path: "/tmp/slices" });
    const { payload: created } = await call("create_task", {
      project_id: project.project_id,
      title: "Worked in slices",
      complexity_hint: "normal",
    });
    const code = (await call("get_task", { task_id: created.task_id })).payload.code as string;
    expect(code).toMatch(/^[A-Z]+-1$/);

    const set = await call("set_task_slices", {
      task_id: code,
      slices: [
        { phase: "design", title: "Decide", exit_criterion: "a written decision" },
        [
          { phase: "implement", title: "Build A" },
          { phase: "implement", title: "Build B" },
        ],
      ],
    });
    expect(set.isError).toBeFalsy();
    expect(set.payload.slices.map((sl: { ref: string }) => sl.ref)).toEqual([`${code}/S1`, `${code}/S2`, `${code}/S3`]);

    await call("start_slice", { slice_id: `${code}/S1` });

    // Replacing while S1 runs is refused, names it, and points at revise_task_slices.
    const replace = await call("set_task_slices", { task_id: code, slices: [{ phase: "verify", title: "x" }] });
    expect(replace.isError).toBe(true);
    expect(String(replace.payload)).toMatch(/S1 "Decide" \(in_progress\).*use revise_task_slices/);

    // A revision without a reason is refused by the schema.
    const noReason = await call("revise_task_slices", { task_id: code, slices: [{ phase: "verify", title: "x" }] });
    expect(noReason.isError).toBe(true);

    // Revising keeps the running S1 and replaces the pending S2/S3 with S4.
    const revised = await call("revise_task_slices", {
      task_id: code,
      slices: [{ phase: "implement", title: "Build once" }],
      reason: "A and B turned out to be one change",
      verbose: true,
    });
    expect(revised.isError).toBeFalsy();
    expect(revised.payload.slices.map((sl: { ref: string }) => sl.ref)).toEqual([`${code}/S1`, `${code}/S4`]);
    expect(revised.payload.revision.replaced_slices.map((sl: { label: string }) => sl.label)).toEqual(["S2", "S3"]);

    const refused = await call("complete_task", { task_id: code, summary: "done?" });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("open_slices");
    expect(refused.payload.message).toContain(`S1 "Decide" (in_progress), S4 "Build once" (pending)`);
    expect(refused.payload.open_slices.map((sl: { ref: string }) => sl.ref)).toEqual([`${code}/S1`, `${code}/S4`]);
    expect((await call("get_task", { task_id: code })).payload.status).not.toBe("done");

    const forced = await call("complete_task", { task_id: code, summary: "done anyway", force: true });
    expect(forced.isError).toBeFalsy();
    expect(forced.payload.ok).toBe(true);
    expect((await call("get_task", { task_id: code })).payload.status).toBe("done");

    const lateRevision = await call("revise_task_slices", {
      task_id: code,
      slices: [{ phase: "verify", title: "x" }],
      reason: "too late",
    });
    expect(lateRevision.isError).toBe(true);
    expect(String(lateRevision.payload)).toContain(
      `Task ${code} is done; its slicing is a finished record and cannot be revised`,
    );
  });

  it("exercises the full release lifecycle, including its distinct error shapes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-release-e2e-"));
    try {
      await releaseLifecycleScenario(db, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries approve_plan's refusals to the caller with their message intact", async () => {
    // The happy path is covered by the all-tools inventory test. This is the
    // half that matters more at the transport boundary: approve_plan's drift
    // refusal NAMES the offending tasks by code, and that sentence is the
    // owner's only cue to re-approve. A rejection that arrived as a bare
    // "isError" with the reason stripped would leave the feature much worse
    // with nothing to catch it - and the plan popup deliberately shows no
    // Approve button, so this message is the whole interface for the failure.
    const client = await connectedClient(db);
    const callText = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, text: content[0].text };
    };
    const payloadOf = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await callText(name, args)).text);

    const project = await payloadOf("create_project", {
      name: "Plan refusals",
      root_path: "/tmp/plan-refusals",
    });
    await payloadOf("create_release", { project_id: project.project_id, version: "1.0.0" });
    const planned = await payloadOf("create_task", {
      project_id: project.project_id,
      release_id: "1.0.0",
      title: "in the plan",
      complexity_hint: "normal",
    });

    // No plan yet: a refusal, not an empty approval.
    const noPlan = await callText("approve_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      approved_by: "valentin",
    });
    expect(noPlan.isError).toBe(true);
    expect(noPlan.text).toMatch(/No plan for release/);

    await payloadOf("create_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      steps: [planned.task_id],
    });

    // A second task joins the batch, which sends the plan back to draft and
    // leaves it drifted (TTM-68's hook appends it, so the drift here is the
    // draft status rather than a missing item) - then approve twice over, to
    // pin both the already-approved refusal and that the first approver is
    // not silently overwritten.
    const late = await payloadOf("create_task", {
      project_id: project.project_id,
      release_id: "1.0.0",
      title: "joined late",
      complexity_hint: "normal",
    });
    expect(late.task_id).toBeTruthy();

    // TTM-87: both batch tasks need a slicing before the plan can be approved.
    await payloadOf("set_task_slices", {
      task_id: planned.task_id,
      slices: [{ phase: "implement", title: "do it" }],
    });
    await payloadOf("set_task_slices", {
      task_id: late.task_id,
      slices: [{ phase: "implement", title: "do it" }],
    });

    const firstApproval = await callText("approve_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      approved_by: "valentin",
      note: "план ок, работай",
    });
    expect(firstApproval.isError, firstApproval.text).toBeFalsy();

    // The note is the owner's verbatim words, and it has to survive the round
    // trip byte for byte - a paraphrase or a trim would make the audit trail
    // unquotable, which is the only thing it is for.
    const readBack = await payloadOf("get_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
    });
    expect(readBack.approval_note).toBe("план ок, работай");
    expect(readBack.status).toBe("approved");

    const twice = await callText("approve_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      approved_by: "someone else",
    });
    expect(twice.isError).toBe(true);
    expect(twice.text).toMatch(/already approved/);

    const stillTheFirstApprover = await payloadOf("get_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
    });
    expect(stillTheFirstApprover.approved_by).toBe("valentin");
  });

  it("carries approve_plan's unsliced-task refusal (TTM-87) to the caller, naming the task by code", async () => {
    const client = await connectedClient(db);
    const callText = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, text: content[0].text };
    };
    const payloadOf = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await callText(name, args)).text);

    const project = await payloadOf("create_project", {
      name: "Unsliced refusal",
      root_path: "/tmp/unsliced-refusal",
    });
    await payloadOf("create_release", { project_id: project.project_id, version: "1.0.0" });
    const task = await payloadOf("create_task", {
      project_id: project.project_id,
      release_id: "1.0.0",
      title: "not yet sliced",
      complexity_hint: "normal",
    });
    await payloadOf("create_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      steps: [task.task_id],
    });

    const refused = await callText("approve_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      approved_by: "valentin",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/has open tasks with no slices/);
    // "Unsliced refusal" derives to prefix "UR" (one initial per word - see
    // derivePrefix in projects.ts), so the first task in it is UR-1.
    expect(refused.text).toMatch(/UR-1/);
    expect(refused.text).toMatch(/set_task_slices/);

    await payloadOf("set_task_slices", {
      task_id: task.task_id,
      slices: [{ phase: "implement", title: "do it" }],
    });

    const approved = await callText("approve_plan", {
      project_id: project.project_id,
      release_id: "1.0.0",
      approved_by: "valentin",
    });
    expect(approved.isError, approved.text).toBeFalsy();
    expect(JSON.parse(approved.text).status).toBe("approved");
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

  it("TTM-91: write tools return a compact acknowledgement by default, and verbose:true restores the full object", async () => {
    const client = await connectedClient(db);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      return JSON.parse(content[0].text);
    };

    const { project_id } = await call("create_project", { name: "Compact", root_path: "/tmp/compact" });
    const { release_id } = await call("create_release", { project_id, version: "1.0" });
    const { task_id } = await call("create_task", {
      project_id,
      release_id,
      title: "Ship it",
      complexity_hint: "normal",
    });

    // Three slices, briefs ~500 chars, so a step index and a code arithmetic
    // mistake would show up in the byte-size table too: two sequential steps
    // (S1, S2), the third (S3) added by the revision below.
    const sliceSpecs = [
      { phase: "design" as const, title: "Decide", brief: "x".repeat(500), exit_criterion: "a decision" },
      { phase: "implement" as const, title: "Build", brief: "y".repeat(500), exit_criterion: "it builds" },
    ];

    // set_task_slices: compact by default - just enough to address each slice
    // and see its state, not the brief/exit_criterion the caller just wrote.
    const compactSet = await call("set_task_slices", { task_id, slices: sliceSpecs });
    expect(compactSet).toEqual({
      task_id,
      code: expect.any(String),
      slices: [
        { ref: expect.stringMatching(/\/S1$/), label: "S1", phase: "design", title: "Decide", status: "pending" },
        { ref: expect.stringMatching(/\/S2$/), label: "S2", phase: "implement", title: "Build", status: "pending" },
      ],
    });
    expect(compactSet.slices[0]).not.toHaveProperty("brief");
    expect(compactSet.slices[0]).not.toHaveProperty("id");
    const code = compactSet.code as string;

    // Same slices again (all still pending, so set_task_slices may replace
    // wholesale) - this time verbose:true, to see the full row it wrote.
    const verboseSet = await call("set_task_slices", { task_id, slices: sliceSpecs, verbose: true });
    expect(verboseSet.slices[0]).toMatchObject({ brief: "x".repeat(500), exit_criterion: "a decision" });
    expect(verboseSet.slices[0]).toHaveProperty("id");
    const s1Id = verboseSet.slices[0].id as string;

    // start_slice / complete_slice: {ok, ref, label, status} by default.
    const compactStart = await call("start_slice", { slice_id: s1Id });
    expect(compactStart).toEqual({ ok: true, ref: `${code}/S1`, label: "S1", status: "in_progress" });

    const verboseComplete = await call("complete_slice", {
      slice_id: s1Id,
      status: "done",
      result: "z".repeat(1000),
      verbose: true,
    });
    expect(verboseComplete).toMatchObject({ status: "done", result: "z".repeat(1000) });

    const compactStart2 = await call("start_slice", { slice_id: `${code}/S2` });
    expect(compactStart2).toEqual({ ok: true, ref: `${code}/S2`, label: "S2", status: "in_progress" });
    const compactComplete = await call("complete_slice", {
      slice_id: `${code}/S2`,
      status: "done",
      result: "z".repeat(1000),
    });
    expect(compactComplete).toEqual({ ok: true, ref: `${code}/S2`, label: "S2", status: "done" });
    expect(compactComplete).not.toHaveProperty("result");

    // revise_task_slices: compact keeps {task_id, code, slices, revision:
    // {id, reason}} - the replaced_slices detail is left out.
    const compactRevise = await call("revise_task_slices", {
      task_id,
      slices: [{ phase: "verify", title: "Check" }],
      reason: "found more work",
    });
    expect(compactRevise.revision).toEqual({ id: expect.any(String), reason: "found more work" });
    expect(compactRevise.revision).not.toHaveProperty("replaced_slices");
    expect(compactRevise.slices.at(-1)).toEqual({
      ref: `${compactSet.code}/S3`,
      label: "S3",
      phase: "verify",
      title: "Check",
      status: "pending",
    });

    const verboseRevise = await call("revise_task_slices", {
      task_id,
      slices: [{ phase: "verify", title: "Check again" }],
      reason: "still more work",
      verbose: true,
    });
    expect(verboseRevise.revision).toHaveProperty("replaced_slices");

    // create_plan / approve_plan: compact groups codes by step and drops
    // per-item task_id/title/note/added_at; unplanned/orphaned only appear
    // when non-empty.
    const compactPlan = await call("create_plan", {
      project_id,
      release_id,
      steps: [task_id],
    });
    expect(compactPlan).toEqual({ status: "draft", steps: [[compactSet.code]] });
    expect(compactPlan).not.toHaveProperty("unplanned");
    expect(compactPlan).not.toHaveProperty("orphaned");

    const verbosePlan = await call("create_plan", {
      project_id,
      release_id,
      steps: [task_id],
      verbose: true,
    });
    expect(verbosePlan.items).toEqual([expect.objectContaining({ task_id, step: 1, position: 1 })]);

    const compactApprove = await call("approve_plan", {
      project_id,
      release_id,
      approved_by: "valentin",
      note: "ok",
    });
    expect(compactApprove).toEqual({
      status: "approved",
      approved_by: "valentin",
      approval_note: "ok",
      steps: [[compactSet.code]],
    });
    expect(compactApprove).not.toHaveProperty("unplanned");
    expect(compactApprove).not.toHaveProperty("orphaned");
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

    // cancel_release: a third release that gets built but deliberately never
    // shipped. Rejections here come back as a bare error string rather than
    // one of the structured error payloads (not_all_done / verification_failed
    // / conflict), so they're read as text.
    const callText = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      return { isError: result.isError, text: content[0].text };
    };

    const { payload: abandoned } = await call("create_release", {
      project_id: project.project_id,
      version: "0.3",
    });
    const { payload: salvageable } = await call("create_task", {
      project_id: project.project_id,
      release_id: "0.3",
      title: "Repo map (unshipped)",
      complexity_hint: "normal",
    });

    const cancelled = await call("cancel_release", {
      project_id: project.project_id,
      release_id: "0.3",
      reason: "bench gate said the feature isn't worth shipping",
    });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.payload.ok).toBe(true);

    const { payload: withCancelled } = await call("list_releases", { project_id: project.project_id });
    expect(withCancelled.releases.find((r: { id: string }) => r.id === abandoned.release_id)).toMatchObject({
      status: "cancelled",
      cancellation_reason: "bench gate said the feature isn't worth shipping",
      released_at: null,
    });

    // Closed to new tasks in both directions of creation...
    const assignInto = await callText("create_task", {
      project_id: project.project_id,
      release_id: "0.3",
      title: "More work on a dead batch",
      complexity_hint: "normal",
    });
    expect(assignInto.isError).toBe(true);
    expect(assignInto.text).toMatch(/is cancelled; cannot assign new tasks to it/);

    // ...but deliberately open outbound, so salvageable work can be rescued.
    const rescued = await call("set_task_release", {
      task_id: salvageable.task_id,
      release_id: nextRelease.release_id,
    });
    expect(rescued.isError).toBeFalsy();

    const shipCancelled = await callText("release_it", {
      project_id: project.project_id,
      release_id: "0.3",
      force: true,
    });
    expect(shipCancelled.isError).toBe(true);
    expect(shipCancelled.text).toMatch(/already cancelled/);

    const cancelTwice = await callText("cancel_release", {
      project_id: project.project_id,
      release_id: "0.3",
      reason: "again",
    });
    expect(cancelTwice.isError).toBe(true);
    expect(cancelTwice.text).toMatch(/already cancelled, nothing to cancel/);
}
