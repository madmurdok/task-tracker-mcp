import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import { cancelTask, completeTask, OpenSlicesError } from "../src/domain/lifecycle.js";
import { createProject } from "../src/domain/projects.js";
import {
  completeSlice,
  listTaskSlices,
  requireSlice,
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
    expect(written.discarded).toEqual([]);
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
  it("refuses to replace while a slice is in_progress, naming it, and leaves the slicing untouched", () => {
    const { db, task } = setup();
    setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      { phase: "implement", title: "Build" },
    ]);
    startSlice(db, `${task.code}/S1`);
    const before = listTaskSlices(db, task.code);

    expect(() => setTaskSlices(db, task.code, [{ phase: "implement", title: "Other" }])).toThrow(
      /has slices in progress: S1 "Decide" \(in_progress\)/,
    );
    expect(listTaskSlices(db, task.code)).toEqual(before);
  });

  it("replaces wholesale once nothing is in progress, carrying nothing over and listing the finished slices it dropped", () => {
    const { db, task } = setup();
    const first = setTaskSlices(db, task.code, [
      { phase: "design", title: "Decide" },
      { phase: "implement", title: "Build" },
      { phase: "measure", title: "Bench" },
    ]);
    startSlice(db, `${task.code}/S1`);
    completeSlice(db, `${task.code}/S1`, { status: "done", result: "decided" });
    completeSlice(db, `${task.code}/S3`, { status: "skipped", result: "no bench" });

    const second = setTaskSlices(db, task.code, [
      { phase: "implement", title: "Build" },
      { phase: "verify", title: "Check" },
    ]);

    expect(second.discarded).toEqual([
      { label: "S1", title: "Decide", status: "done" },
      { label: "S3", title: "Bench", status: "skipped" },
    ]);
    // Nothing carried over: the surviving title "Build" is a new, pending row.
    expect(second.slices.map((s) => [s.label, s.title, s.status, s.result])).toEqual([
      ["S1", "Build", "pending", null],
      ["S2", "Check", "pending", null],
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
