import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import { cancelTask, completeTask, OpenSlicesError } from "../src/domain/lifecycle.js";
import { createProject } from "../src/domain/projects.js";
import {
  completeSlice,
  listSlicesForTasks,
  listTaskSlices,
  requireSlice,
  reviseTaskSlices,
  setTaskSlices,
  startSlice,
} from "../src/domain/slices.js";
import { getTaskDetail } from "../src/domain/status.js";
import { createTask, withCode, type Task } from "../src/domain/tasks.js";
import type { CompletionVerifier } from "../src/domain/verification.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };
const noopVerifier: CompletionVerifier = { verify: () => ({ passed: true, reason: "noop" }) };

function setup(): { db: DatabaseInstance; task: Task & { code: string } } {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const task = createTask(db, noopEstimator, {
    project_id: project.id,
    title: "Sliced task",
    complexity_hint: "normal",
  }).task;
  return { db, task: withCode(db, task) };
}

describe("set_task_slices / start_slice / complete_slice", () => {
  it("writes a slicing by task code, labels it, and reads it back through get_task by uuid", () => {
    const { db, task } = setup();

    const written = setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide the shape", brief: "read the plan code", exit_criterion: "a decision" },
      { phase: "implement", title: "Build it", model: "opus" },
    ]);

    expect(written.task_id).toBe(task.id);
    expect(written.slices.map((s) => [s.label, s.ref, s.phase, s.step, s.position, s.status])).toEqual([
      ["S1", `${task.code}/S1`, "design", 1, 1, "pending"],
      ["S2", `${task.code}/S2`, "implement", 2, 1, "pending"],
    ]);
    expect(written.slices[0]).toMatchObject({
      brief: "read the plan code",
      exit_criterion: "a decision",
      model: null,
      result: null,
      artifacts: [],
      metrics: null,
      started_at: null,
      completed_at: null,
    });
    expect(written.slices[1]!.model).toBe("opus");

    const detail = getTaskDetail(db, task.id);
    expect(detail.slices).toEqual(written.slices);
  });

  it("returns parallel slices in step/position order, labelled S1..Sn across steps", () => {
    const { db, task } = setup();

    setTaskSlices(db, task.id, [
      { phase: "design", title: "d" },
      [
        { phase: "implement", title: "i-a" },
        { phase: "implement", title: "i-b" },
        { phase: "implement", title: "i-c" },
      ],
      { phase: "verify", title: "v" },
    ]);

    const slices = listTaskSlices(db, task.code);
    expect(slices.map((s) => [s.label, s.title, s.step, s.position])).toEqual([
      ["S1", "d", 1, 1],
      ["S2", "i-a", 2, 1],
      ["S3", "i-b", 2, 2],
      ["S4", "i-c", 2, 3],
      ["S5", "v", 3, 1],
    ]);
  });

  it("starts and completes a slice addressed by its readable ref, and by its uuid", () => {
    const { db, task } = setup();
    const { slices } = setTaskSlices(db, task.code, [
      { phase: "implement", title: "a" },
      { phase: "verify", title: "b" },
    ]);

    const started = startSlice(db, `${task.code}/S1`);
    expect(started.status).toBe("in_progress");
    expect(started.started_at).toBeTruthy();

    const done = completeSlice(db, `${task.code}/S1`, {
      status: "done",
      result: "built",
      artifacts: ["src/domain/slices.ts"],
      metrics: { tool_uses: 12, duration_ms: 3400, reread_tokens: 900 },
    });
    expect(done).toMatchObject({
      status: "done",
      result: "built",
      artifacts: ["src/domain/slices.ts"],
      metrics: { tool_uses: 12, duration_ms: 3400, reread_tokens: 900 },
    });
    expect(done.completed_at).toBeTruthy();

    const second = slices[1]!;
    expect(startSlice(db, second.id).status).toBe("in_progress");
    const failed = completeSlice(db, second.id, { status: "failed", result: "tests red" });
    expect(failed).toMatchObject({ status: "failed", artifacts: [], metrics: null });

    // Lower-case s and a uuid task ref resolve too.
    expect(requireSlice(db, `${task.id}/s2`).id).toBe(second.id);
  });

  it("refuses to start a non-pending slice and to complete one twice", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "implement", title: "a" }]);
    const ref = `${task.code}/S1`;

    expect(() => completeSlice(db, ref, { status: "done", result: "x" })).toThrow(
      /is pending; it can be marked done only from in_progress/,
    );
    startSlice(db, ref);
    expect(() => startSlice(db, ref)).toThrow(/is in_progress; only a pending slice can be started/);
    completeSlice(db, ref, { status: "done", result: "first report" });
    expect(() => completeSlice(db, ref, { status: "skipped", result: "second report" })).toThrow(/is done/);
    expect(requireSlice(db, ref).result).toBe("first report");
  });

  it("accepts skipped straight from pending", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "measure", title: "optional bench" }]);
    const skipped = completeSlice(db, `${task.code}/S1`, { status: "skipped", result: "not needed" });
    expect(skipped).toMatchObject({ status: "skipped", started_at: null });
    expect(skipped.completed_at).toBeTruthy();
  });

  it("rejects an unknown slice ref, an out-of-range label and an unknown task", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "design", title: "only" }]);
    expect(() => startSlice(db, `${task.code}/S2`)).toThrow(/Unknown slice: .*\/S2/);
    expect(() => startSlice(db, `${task.code}/S0`)).toThrow(/Unknown slice/);
    expect(() => startSlice(db, "not-a-slice")).toThrow(/Unknown slice: not-a-slice/);
    expect(() => setTaskSlices(db, "NOPE-1", [{ phase: "design", title: "x" }])).toThrow(/Unknown task_id: NOPE-1/);
  });

  it("rejects an empty slicing and an empty parallel group", () => {
    const { db, task } = setup();
    expect(() => setTaskSlices(db, task.code, [])).toThrow(/at least one step/);
    expect(() => setTaskSlices(db, task.code, [{ phase: "design", title: "a" }, []])).toThrow(
      /Slice step 2 has no slices/,
    );
    expect(listTaskSlices(db, task.code)).toEqual([]);
  });
});

describe("set_task_slices replace rules", () => {
  it("refuses to replace while a slice is in_progress, naming it and revise_task_slices, and leaves the slicing untouched", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      { phase: "implement", title: "Build" },
    ]);
    startSlice(db, `${task.code}/S1`);
    const before = listTaskSlices(db, task.code);

    expect(() => setTaskSlices(db, task.code, [{ phase: "implement", title: "Other" }])).toThrow(
      /has slices that are in progress or finished: S1 "Decide" \(in_progress\); .*use revise_task_slices/,
    );
    expect(listTaskSlices(db, task.code)).toEqual(before);
  });

  // TTM-89: replacing wholesale used to delete finished slices along with
  // their reports and metrics. Now a finished slice makes set_task_slices
  // refuse and point at revise_task_slices, and nothing is deleted.
  it("refuses once any slice is finished - done, failed or skipped - naming each, and deletes nothing", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      { phase: "implement", title: "Build" },
      { phase: "verify", title: "Check" },
      { phase: "measure", title: "Bench" },
    ]);
    startSlice(db, `${task.code}/S1`);
    completeSlice(db, `${task.code}/S1`, { status: "done", result: "decided", metrics: { tool_uses: 3 } });
    startSlice(db, `${task.code}/S2`);
    completeSlice(db, `${task.code}/S2`, { status: "failed", result: "hit a wall" });
    completeSlice(db, `${task.code}/S4`, { status: "skipped", result: "no bench" });
    const before = listTaskSlices(db, task.code);

    expect(() => setTaskSlices(db, task.code, [{ phase: "implement", title: "Other" }])).toThrow(
      /has slices that are in progress or finished: S1 "Decide" \(done\), S2 "Build" \(failed\), S4 "Bench" \(skipped\); set_task_slices only writes a first slicing - use revise_task_slices/,
    );
    expect(listTaskSlices(db, task.code)).toEqual(before);
  });

  it("replaces an all-pending slicing wholesale, renumbering from S1", () => {
    const { db, task } = setup();
    const first = setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      { phase: "implement", title: "Build" },
      { phase: "measure", title: "Bench" },
    ]);

    const second = setTaskSlices(db, task.code, [
      { phase: "implement", title: "Build" },
      { phase: "verify", title: "Check" },
    ]);

    // Nothing carried over: the surviving title "Build" is a new, pending row.
    expect(second.slices.map((s) => [s.label, s.title, s.status, s.step])).toEqual([
      ["S1", "Build", "pending", 1],
      ["S2", "Check", "pending", 2],
    ]);
    const oldIds = new Set(first.slices.map((s) => s.id));
    expect(second.slices.some((s) => oldIds.has(s.id))).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM task_slices`).get()).toEqual({ cnt: 2 });
  });

  it("refuses to rewrite the slicing of a done or cancelled task", () => {
    const { db, task } = setup();
    completeTask(db, noopVerifier, { task_id: task.code });
    expect(() => setTaskSlices(db, task.code, [{ phase: "design", title: "x" }])).toThrow(/is done/);

    const other = setup();
    cancelTask(other.db, { task_id: other.task.id, reason: "not needed" });
    expect(() => setTaskSlices(other.db, other.task.code, [{ phase: "design", title: "x" }])).toThrow(
      /is cancelled/,
    );
  });

  it("cascades: deleting the task takes its slices", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "design", title: "x" }]);
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(task.id);
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM task_slices`).get()).toEqual({ cnt: 0 });
  });
});

describe("revise_task_slices (TTM-89)", () => {
  /**
   * S1 design (step 1)        -> done, with metrics
   * S2 implement (step 2, p1) -> pending   <- a pending slice before kept ones
   * S3 implement (step 2, p2) -> in_progress
   * S4 verify (step 3)        -> skipped
   * S5 verify (step 4)        -> pending
   * S6 measure (step 5)       -> failed
   */
  function slicedMidway() {
    const ctx = setup();
    const { db, task } = ctx;
    setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      [
        { phase: "implement", title: "Build A", brief: "brief A", exit_criterion: "A builds", model: "sonnet" },
        { phase: "implement", title: "Build B" },
      ],
      { phase: "verify", title: "Check" },
      { phase: "verify", title: "Recheck", model: "opus" },
      { phase: "measure", title: "Bench" },
    ]);
    startSlice(db, `${task.code}/S1`);
    completeSlice(db, `${task.code}/S1`, {
      status: "done",
      result: "the store cannot hold it",
      artifacts: ["docs/finding.md"],
      metrics: { tool_uses: 12, duration_ms: 3400 },
    });
    startSlice(db, `${task.code}/S3`);
    completeSlice(db, `${task.code}/S4`, { status: "skipped", result: "not needed" });
    startSlice(db, `${task.code}/S6`);
    completeSlice(db, `${task.code}/S6`, { status: "failed", result: "bench harness broken" });
    return ctx;
  }

  const rawRow = (db: DatabaseInstance, id: string) => db.prepare(`SELECT * FROM task_slices WHERE id = ?`).get(id);

  it("keeps finished and in_progress slices byte for byte and replaces only the pending ones", () => {
    const { db, task } = slicedMidway();
    const before = listTaskSlices(db, task.code);
    const kept = before.filter((s) => ["S1", "S3", "S4", "S6"].includes(s.label));
    const rawBefore = kept.map((s) => rawRow(db, s.id));

    const revised = reviseTaskSlices(
      db,
      task.code,
      [{ phase: "implement", title: "Rework store" }, [{ phase: "verify", title: "V1" }, { phase: "verify", title: "V2" }]],
      "S1 found the store cannot hold it",
    );

    // Every column of every kept row, unchanged - status, result, artifacts,
    // metrics, timestamps, step, position and label.
    expect(kept.map((s) => rawRow(db, s.id))).toEqual(rawBefore);
    expect(revised.slices.filter((s) => kept.some((k) => k.id === s.id))).toEqual(kept);
    // The pending ones are gone.
    const replacedIds = before.filter((s) => s.status === "pending").map((s) => s.id);
    expect(replacedIds).toHaveLength(2);
    for (const id of replacedIds) expect(rawRow(db, id)).toBeUndefined();
    expect(revised.slices.filter((s) => s.status === "pending").map((s) => s.title)).toEqual([
      "Rework store",
      "V1",
      "V2",
    ]);

    // The in_progress slice is still workable by its old ref.
    const s3 = completeSlice(db, `${task.code}/S3`, { status: "done", result: "B built anyway" });
    expect(s3.id).toBe(kept.find((s) => s.label === "S3")!.id);
  });

  it("places the new slices in steps after the highest kept step, labelled after the highest label", () => {
    const { db, task } = slicedMidway();
    const revised = reviseTaskSlices(
      db,
      task.code,
      [{ phase: "implement", title: "Rework store" }, [{ phase: "verify", title: "V1" }, { phase: "verify", title: "V2" }]],
      "re-cut",
    );

    expect(revised.slices.map((s) => [s.label, s.title, s.step, s.position, s.status])).toEqual([
      ["S1", "Decide", 1, 1, "done"],
      ["S3", "Build B", 2, 2, "in_progress"],
      ["S4", "Check", 3, 1, "skipped"],
      ["S6", "Bench", 5, 1, "failed"],
      ["S7", "Rework store", 6, 1, "pending"],
      ["S8", "V1", 7, 1, "pending"],
      ["S9", "V2", 7, 2, "pending"],
    ]);
    expect(revised.slices.map((s) => s.ref)).toEqual(revised.slices.map((s) => `${task.code}/${s.label}`));
  });

  it("keeps every kept slice's label - including one that sat after a removed pending slice - and never reuses a label", () => {
    const { db, task } = slicedMidway();
    const idOf = (ref: string) => requireSlice(db, ref).id;
    const before = { S3: idOf(`${task.code}/S3`), S4: idOf(`${task.code}/S4`), S6: idOf(`${task.code}/S6`) };

    // S2 (pending) sits before S3 and S4 (kept); S5 (pending) before S6.
    reviseTaskSlices(db, task.code, [{ phase: "implement", title: "Rework" }], "first re-cut");
    expect(idOf(`${task.code}/S3`)).toBe(before.S3);
    expect(idOf(`${task.code}/S4`)).toBe(before.S4);
    expect(idOf(`${task.code}/S6`)).toBe(before.S6);
    expect(() => requireSlice(db, `${task.code}/S2`)).toThrow(/Unknown slice/);
    expect(() => requireSlice(db, `${task.code}/S5`)).toThrow(/Unknown slice/);

    // A second revision replaces S7 (pending) and still does not reuse 7.
    const second = reviseTaskSlices(db, task.code, [{ phase: "verify", title: "Final" }], "second re-cut");
    expect(second.slices.map((s) => s.label)).toEqual(["S1", "S3", "S4", "S6", "S8"]);
    expect(idOf(`${task.code}/S3`)).toBe(before.S3);

    // The board's batch query reads the same labels as get_task.
    const board = listSlicesForTasks(db, [task], task.code.split("-")[0]!).get(task.id)!;
    expect(board.map((s) => s.label)).toEqual(["S1", "S3", "S4", "S6", "S8"]);
  });

  it("records every revision with its reason and the replaced pending slices, and get_task returns the history", () => {
    const { db, task } = slicedMidway();
    expect(getTaskDetail(db, task.id).slice_revisions).toEqual([]);

    const first = reviseTaskSlices(db, task.code, [{ phase: "implement", title: "Rework" }], "S1 found X");
    expect(first.revision).toMatchObject({ task_id: task.id, reason: "S1 found X" });
    expect(first.revision.replaced_slices).toEqual([
      expect.objectContaining({
        label: "S2",
        phase: "implement",
        step: 2,
        position: 1,
        title: "Build A",
        brief: "brief A",
        exit_criterion: "A builds",
        model: "sonnet",
      }),
      expect.objectContaining({ label: "S5", phase: "verify", step: 4, title: "Recheck", model: "opus" }),
    ]);
    const second = reviseTaskSlices(db, task.code, [{ phase: "verify", title: "Final" }], "Rework is moot");
    expect(second.revision.replaced_slices.map((s) => [s.label, s.title])).toEqual([["S7", "Rework"]]);

    expect(getTaskDetail(db, task.code).slice_revisions).toEqual([first.revision, second.revision]);
  });

  it("works on an all-pending slicing, recording what it replaced", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "design", title: "a" }, { phase: "implement", title: "b" }]);
    const revised = reviseTaskSlices(db, task.code, [{ phase: "implement", title: "c" }], "rethought");
    expect(revised.slices.map((s) => [s.label, s.title, s.step])).toEqual([["S3", "c", 1]]);
    expect(revised.revision.replaced_slices.map((s) => s.label)).toEqual(["S1", "S2"]);
  });

  it("refuses on a done or cancelled task, and without a reason, changing nothing", () => {
    const { db, task } = slicedMidway();
    const before = listTaskSlices(db, task.code);
    expect(() => reviseTaskSlices(db, task.code, [{ phase: "design", title: "x" }], "  ")).toThrow(
      /revise_task_slices requires a reason/,
    );
    expect(() => reviseTaskSlices(db, task.code, [], "why")).toThrow(/revise_task_slices requires at least one step/);
    expect(listTaskSlices(db, task.code)).toEqual(before);

    completeTask(db, noopVerifier, { task_id: task.code, force: true });
    expect(() => reviseTaskSlices(db, task.code, [{ phase: "design", title: "x" }], "why")).toThrow(
      `Task ${task.code} is done; its slicing is a finished record and cannot be revised`,
    );
    expect(listTaskSlices(db, task.code)).toEqual(before);

    const other = setup();
    setTaskSlices(other.db, other.task.code, [{ phase: "design", title: "a" }]);
    cancelTask(other.db, { task_id: other.task.id, reason: "not needed" });
    expect(() => reviseTaskSlices(other.db, other.task.code, [{ phase: "design", title: "x" }], "why")).toThrow(
      `Task ${other.task.code} is cancelled; its slicing is a finished record and cannot be revised`,
    );
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM task_slice_revisions`).get()).toEqual({ cnt: 0 });
    expect(other.db.prepare(`SELECT COUNT(*) AS cnt FROM task_slice_revisions`).get()).toEqual({ cnt: 0 });
  });

  it("cascades: deleting the task takes its revision history", () => {
    const { db, task } = slicedMidway();
    reviseTaskSlices(db, task.code, [{ phase: "design", title: "x" }], "why");
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(task.id);
    expect(db.prepare(`SELECT COUNT(*) AS cnt FROM task_slice_revisions`).get()).toEqual({ cnt: 0 });
  });
});

describe("complete_task's open-slices guard", () => {
  it("refuses while slices are pending or in_progress, naming each, and does not mark the task done", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      [
        { phase: "implement", title: "Build A" },
        { phase: "implement", title: "Build B" },
      ],
    ]);
    startSlice(db, `${task.code}/S1`);
    completeSlice(db, `${task.code}/S1`, { status: "done", result: "ok" });
    startSlice(db, `${task.code}/S2`);

    let caught: unknown;
    try {
      completeTask(db, noopVerifier, { task_id: task.code, summary: "all good" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenSlicesError);
    expect((caught as Error).message).toBe(
      `Task ${task.code} has open slices: S2 "Build A" (in_progress), S3 "Build B" (pending); complete, fail or skip them, or pass force`,
    );
    expect((caught as OpenSlicesError).openSlices.map((s) => s.label)).toEqual(["S2", "S3"]);
    expect(getTaskDetail(db, task.id).status).not.toBe("done");
  });

  it("does not run verification when it refuses", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "design", title: "Decide" }]);
    let verified = 0;
    const countingVerifier: CompletionVerifier = {
      verify: () => {
        verified += 1;
        return { passed: true, reason: "ok" };
      },
    };
    expect(() => completeTask(db, countingVerifier, { task_id: task.id })).toThrow(OpenSlicesError);
    expect(verified).toBe(0);
  });

  it("completes once every slice is done, failed or skipped", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [
      { phase: "implement", title: "a" },
      { phase: "verify", title: "b" },
      { phase: "measure", title: "c" },
    ]);
    startSlice(db, `${task.code}/S1`);
    completeSlice(db, `${task.code}/S1`, { status: "done", result: "ok" });
    startSlice(db, `${task.code}/S2`);
    completeSlice(db, `${task.code}/S2`, { status: "failed", result: "flaky" });
    completeSlice(db, `${task.code}/S3`, { status: "skipped", result: "later" });

    expect(() => completeTask(db, noopVerifier, { task_id: task.code })).not.toThrow();
    expect(getTaskDetail(db, task.id).status).toBe("done");
  });

  it("completes with open slices when force is passed", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [{ phase: "design", title: "Decide" }]);
    expect(() => completeTask(db, noopVerifier, { task_id: task.code, force: true })).not.toThrow();
    expect(getTaskDetail(db, task.id).status).toBe("done");
  });

  it("does not affect a task with no slicing", () => {
    const { db, task } = setup();
    expect(() => completeTask(db, noopVerifier, { task_id: task.code })).not.toThrow();
  });
});
