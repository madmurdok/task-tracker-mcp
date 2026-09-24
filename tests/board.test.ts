import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { getBoardData } from "../src/domain/board.js";
import { addDependency } from "../src/domain/dependencies.js";
import { createEpic } from "../src/domain/epics.js";
import { createProject } from "../src/domain/projects.js";
import { cancelRelease } from "../src/domain/lifecycle.js";
import { approvePlan, upsertPlan } from "../src/domain/plans.js";
import { createRelease } from "../src/domain/releases.js";
import { setTaskSlices } from "../src/domain/slices.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

// board.js is a plain browser script (no exports, top-level side effects that
// run on load) rather than a module, so it can't just be imported. This is a
// minimal DOM/browser shim - just enough fake globals for the script's
// top-level calls (loadBoard/wireShutdownButton/wireReleaseNotesDialog) to
// run without throwing - loaded into its own vm context so its top-level
// `function` declarations (like laneTitle) come back out as properties on
// the returned sandbox object, ready to call directly in assertions.
function domElementStub(): any {
  const el: any = {
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {},
    children: [] as any[],
    classList: { add() {}, toggle() {}, contains: () => false },
    appendChild(child: any) {
      el.children.push(child);
      return child;
    },
    removeChild(child: any) {
      el.children = el.children.filter((c: any) => c !== child);
      return child;
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    // Stored (not a no-op) so tests can simulate a click via fireClick below
    // - needed to assert "clicking Plan opens the dialog without toggling
    // collapse", which is a behavior, not just a markup shape.
    _listeners: {} as Record<string, Array<() => void>>,
    addEventListener(type: string, handler: () => void) {
      (el._listeners[type] ??= []).push(handler);
    },
    setAttribute() {},
    showModal() {
      el.showModalCalls = (el.showModalCalls ?? 0) + 1;
    },
    close() {},
  };
  return el;
}

// Invokes every "click" listener registered on a stub via addEventListener.
function fireClick(el: any): void {
  for (const handler of el._listeners?.click ?? []) handler();
}

// Resolved relative to this test file (not process.cwd()) so it always reads
// the board.js sitting next to it in this checkout/worktree, regardless of
// what directory the test runner itself was launched from.
const BOARD_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/dashboard/public/board.js");

function loadBoardScript(): any {
  const src = readFileSync(BOARD_JS_PATH, "utf8");
  // Same id must return the same stub across calls (unlike createElement,
  // which always returns a fresh node) - showPlanDialog looks a dialog up by
  // id in one call and a test needs that exact object back afterward to
  // check showModalCalls, the same way a real `document.getElementById`
  // would return the same element every time.
  const elementsById = new Map<string, any>();
  const getElementById = (id: string) => {
    if (!elementsById.has(id)) elementsById.set(id, domElementStub());
    return elementsById.get(id);
  };
  const sandbox: any = {
    document: {
      title: "",
      createElement: () => domElementStub(),
      getElementById,
    },
    window: { location: { search: "" } },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    fetch: async () => {
      throw new Error("fetch is not available in the board.js test shim");
    },
    URLSearchParams,
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  return { db, project };
}

describe("getBoardData", () => {
  it("puts unreleased tasks in a 'no release' lane and released ones in their own release lane, newest release first", () => {
    const { db, project } = setup();
    const v1 = createRelease(db, { project_id: project.id, version: "0.1", name: "First" });
    const v2 = createRelease(db, { project_id: project.id, version: "0.2", name: "Second" });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Backlog item",
      complexity_hint: "normal",
    });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "For v0.1",
      complexity_hint: "normal",
      release_id: v1.id,
    });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "For v0.2",
      complexity_hint: "normal",
      release_id: v2.id,
    });

    const board = getBoardData(db, project.id);

    expect(board.project_id).toBe(project.id);
    expect(board.project_name).toBe("Demo");
    // Emitted once per board (not repeated per task) - together with each
    // task's task_number this is what lets the dashboard render the
    // PREFIX-N code (e.g. "DEM-1") on a card.
    expect(board.project_code_prefix).toBe("DEM");
    expect(board.lanes).toHaveLength(3);
    expect(board.lanes[0]).toMatchObject({ release_id: null });
    expect(board.lanes[0].tasks.map((t) => t.title)).toEqual(["Backlog item"]);
    expect(board.lanes[0].tasks.map((t) => t.task_number)).toEqual([1]);
    expect(board.lanes[1]).toMatchObject({ release_id: v2.id, release_version: "0.2" });
    expect(board.lanes[1].tasks.map((t) => t.title)).toEqual(["For v0.2"]);
    expect(board.lanes[1].tasks.map((t) => t.task_number)).toEqual([3]);
    expect(board.lanes[2]).toMatchObject({ release_id: v1.id, release_version: "0.1" });
    expect(board.lanes[2].tasks.map((t) => t.title)).toEqual(["For v0.1"]);
    expect(board.lanes[2].tasks.map((t) => t.task_number)).toEqual([2]);
  });

  it("surfaces a release's status, release_notes and cancellation reason on its lane; all null for a planned release and for the no-release lane", () => {
    const { db, project } = setup();
    const planned = createRelease(db, { project_id: project.id, version: "0.2" });
    const released = createRelease(db, { project_id: project.id, version: "0.1" });
    const cancelled = createRelease(db, { project_id: project.id, version: "0.3" });
    db.prepare(`UPDATE releases SET status = 'released', release_notes = ? WHERE id = ?`).run(
      "- Task A\n- Task B",
      released.id,
    );
    cancelRelease(db, {
      project_id: project.id,
      release_id: cancelled.id,
      reason: "bench gate said don't ship it",
    });
    createTask(db, noopEstimator, { project_id: project.id, title: "Backlog item", complexity_hint: "normal" });

    const board = getBoardData(db, project.id);
    const byReleaseId = new Map(board.lanes.map((lane) => [lane.release_id, lane]));

    expect(byReleaseId.get(null)).toMatchObject({
      release_status: null,
      release_notes: null,
      release_cancellation_reason: null,
    });
    expect(byReleaseId.get(planned.id)).toMatchObject({
      release_status: "planned",
      release_notes: null,
      release_cancellation_reason: null,
    });
    expect(byReleaseId.get(released.id)).toMatchObject({
      release_status: "released",
      release_notes: "- Task A\n- Task B",
      release_cancellation_reason: null,
    });
    // A cancelled lane carries the reason where a shipped one carries notes -
    // it never reached release_it, so it has none of the latter.
    expect(byReleaseId.get(cancelled.id)).toMatchObject({
      release_status: "cancelled",
      release_notes: null,
      release_cancellation_reason: "bench gate said don't ship it",
    });
  });

  it("always shows the 'no release' (Backlog) lane first, even when empty - both for a brand-new project and one where every task has a release", () => {
    const { db, project } = setup();
    const v1 = createRelease(db, { project_id: project.id, version: "0.1" });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Only task",
      complexity_hint: "normal",
      release_id: v1.id,
    });

    const board = getBoardData(db, project.id);
    expect(board.lanes.map((l) => l.release_id)).toEqual([null, v1.id]);
    expect(board.lanes[0]).toMatchObject({ release_id: null, tasks: [] });

    const { db: db2, project: project2 } = setup();
    expect(getBoardData(db2, project2.id).lanes).toEqual([
      {
        release_id: null,
        release_version: null,
        release_name: null,
        release_status: null,
        release_notes: null,
        release_cancellation_reason: null,
        tasks: [],
        plan: null,
      },
    ]);
  });

  it("orders multiple release lanes highest-sequence-first, with Backlog always on top", () => {
    const { db, project } = setup();
    const v1 = createRelease(db, { project_id: project.id, version: "0.1" });
    const v2 = createRelease(db, { project_id: project.id, version: "0.2" });
    const v3 = createRelease(db, { project_id: project.id, version: "0.3" });

    const board = getBoardData(db, project.id);

    expect(board.lanes.map((l) => l.release_id)).toEqual([null, v3.id, v2.id, v1.id]);
  });

  it("derives 'blocked' status for a task with an unmet dependency", () => {
    const { db, project } = setup();
    const a = createTask(db, noopEstimator, { project_id: project.id, title: "A", complexity_hint: "normal" }).task;
    const b = createTask(db, noopEstimator, { project_id: project.id, title: "B", complexity_hint: "normal" }).task;
    addDependency(db, b.id, a.id);

    const board = getBoardData(db, project.id);
    const bCard = board.lanes[0].tasks.find((t) => t.id === b.id);
    expect(bCard?.status).toBe("blocked");
  });

  it("flags an in_progress task whose lock has already expired as is_stale, but not a freshly-leased one", () => {
    const { db, project } = setup();
    const stale = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Stale",
      complexity_hint: "normal",
    }).task;
    const fresh = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Fresh",
      complexity_hint: "normal",
    }).task;
    const now = new Date();
    db.prepare(`UPDATE tasks SET status = 'in_progress', lock_expires_at = ? WHERE id = ?`).run(
      new Date(now.getTime() - 1000).toISOString(),
      stale.id,
    );
    db.prepare(`UPDATE tasks SET status = 'in_progress', lock_expires_at = ? WHERE id = ?`).run(
      new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      fresh.id,
    );

    const board = getBoardData(db, project.id);
    const byId = new Map(board.lanes[0].tasks.map((t) => [t.id, t]));
    expect(byId.get(stale.id)?.is_stale).toBe(true);
    expect(byId.get(fresh.id)?.is_stale).toBe(false);
  });

  it("resolves epic_name for a task with an epic, and null for one without", () => {
    const { db, project } = setup();
    const epic = createEpic(db, { project_id: project.id, name: "Auth" });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "With epic",
      complexity_hint: "normal",
      epic_id: epic.id,
    });
    createTask(db, noopEstimator, { project_id: project.id, title: "No epic", complexity_hint: "normal" });

    const board = getBoardData(db, project.id);
    const byTitle = new Map(board.lanes[0].tasks.map((t) => [t.title, t]));
    expect(byTitle.get("With epic")).toMatchObject({ epic_id: epic.id, epic_name: "Auth" });
    expect(byTitle.get("No epic")).toMatchObject({ epic_id: null, epic_name: null });
  });

  it("reflects doc_drift the same way getProjectStatus does", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-board-docsync-"));
    try {
      writeFileSync(path.join(dir, "design.md"), "# Design\n");
      const db: DatabaseInstance = openDatabase(":memory:");
      const project = createProject(db, { name: "Demo", root_path: dir, design_doc_path: "design.md" });

      expect(getBoardData(db, project.id).doc_drift).toBe(false);

      writeFileSync(path.join(dir, "design.md"), "# Design\n\nchanged\n");
      expect(getBoardData(db, project.id).doc_drift).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves lane.plan null for a release nobody has written a plan for, and for the Backlog lane", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.4" });
    createTask(db, noopEstimator, { project_id: project.id, title: "Backlog item", complexity_hint: "normal" });

    const board = getBoardData(db, project.id);

    expect(board.lanes.find((l) => l.release_id === null)?.plan).toBeNull();
    expect(board.lanes.find((l) => l.release_id === release.id)?.plan).toBeNull();
  });

  it("carries a plan's approval header and items' ordering only - no title, status or code duplicated onto an item", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.5" });
    const a = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "A",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;
    const b = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "B",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;

    upsertPlan(db, project.id, release.id, {
      steps: [{ task: a.id, note: "do first" }, b.id],
      rationale: "A unblocks B",
    });

    const board = getBoardData(db, project.id);
    const plan = board.lanes.find((l) => l.release_id === release.id)?.plan;

    expect(plan).toMatchObject({
      status: "draft",
      rationale: "A unblocks B",
      approved_by: null,
      approval_note: null,
      approved_at: null,
      drifted: false,
      unplanned_task_ids: [],
    });
    expect(plan?.items).toEqual([
      { task_id: a.id, step: 1, note: "do first", new_since_approval: false },
      { task_id: b.id, step: 2, note: "", new_since_approval: false },
    ]);
    // toEqual above already pins the exact key set, but spelled out here too
    // since it's the one thing this task's acceptance criteria calls out by
    // name: no title/status/code key sneaks onto an item.
    for (const item of plan?.items ?? []) {
      expect(Object.keys(item).sort()).toEqual(["new_since_approval", "note", "step", "task_id"]);
    }

    // TTM-87: approve_plan refuses an open batch task with no slices.
    setTaskSlices(db, a.id, [{ phase: "implement", title: "do it" }]);
    setTaskSlices(db, b.id, [{ phase: "implement", title: "do it" }]);
    approvePlan(db, project.id, release.id, { approved_by: "valentin", note: "looks right" });
    const approvedPlan = getBoardData(db, project.id).lanes.find((l) => l.release_id === release.id)?.plan;
    expect(approvedPlan).toMatchObject({
      status: "approved",
      approved_by: "valentin",
      approval_note: "looks right",
      drifted: false,
    });
    expect(approvedPlan?.approved_at).not.toBeNull();
  });

  it("populates unplanned_task_ids and drifted when the batch has a task the plan doesn't cover", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.6" });
    const planned = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Planned",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;
    const unplanned = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Unplanned",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;

    upsertPlan(db, project.id, release.id, { steps: [planned.id] });

    const plan = getBoardData(db, project.id).lanes.find((l) => l.release_id === release.id)?.plan;

    expect(plan?.drifted).toBe(true);
    expect(plan?.unplanned_task_ids).toEqual([unplanned.id]);
  });

  it("flags a plan item new_since_approval when it entered the plan after the current approval, false for items that predate it", () => {
    const { db, project } = setup();
    const release = createRelease(db, { project_id: project.id, version: "0.7" });
    const a = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "A",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;
    // Left unassigned to any release for now - if it belonged to this release
    // already, upsertPlan's own drift check would refuse to approve (task c
    // not in the plan). It only needs to actually be in the release at
    // getBoardData time, which the raw UPDATE below arranges for.
    const c = createTask(db, noopEstimator, { project_id: project.id, title: "C", complexity_hint: "normal" }).task;

    upsertPlan(db, project.id, release.id, { steps: [a.id] });
    // TTM-87: approve_plan refuses an open batch task with no slices.
    setTaskSlices(db, a.id, [{ phase: "implement", title: "do it" }]);
    const approved = approvePlan(db, project.id, release.id, { approved_by: "valentin" });

    // upsertPlan always demotes an approved plan back to draft the moment it
    // touches items (see plans.ts's comment on why), and setTaskRelease's
    // hook demotes it too the moment a task joins the release it covers - so
    // there is no domain call that leaves a plan *approved* with a freshly
    // -added item. The only way to observe the read-time rule in isolation
    // (added_at > approved_at, schema.ts's rationale for not storing it) is
    // to place the rows directly, the same way this file already reaches
    // past the domain layer to set up a stale lock or a release's notes.
    db.prepare(`UPDATE tasks SET release_id = ? WHERE id = ?`).run(release.id, c.id);
    const laterThanApproval = new Date(new Date(approved.approved_at!).getTime() + 1000).toISOString();
    db.prepare(
      `INSERT INTO release_plan_items (plan_id, task_id, step, position, note, added_at) VALUES (?, ?, ?, ?, '', ?)`,
    ).run(approved.id, c.id, 2, 1, laterThanApproval);

    const plan = getBoardData(db, project.id).lanes.find((l) => l.release_id === release.id)?.plan;
    const byTask = new Map(plan?.items.map((item) => [item.task_id, item]));

    expect(byTask.get(a.id)?.new_since_approval).toBe(false);
    expect(byTask.get(c.id)?.new_since_approval).toBe(true);
  });

  it("carries a task's slices in step/position order (TTM-84), and an empty list for a task without any", () => {
    const { db, project } = setup();
    const sliced = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Sliced",
      complexity_hint: "normal",
    }).task;
    const unsliced = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Unsliced",
      complexity_hint: "normal",
    }).task;

    // Two slices sharing step 1 (parallel), then one alone in step 2 - listed
    // here out of title order (B before A) so a re-sort by title, rather than
    // by step/position, would show up as a failure.
    setTaskSlices(db, sliced.id, [
      [
        { phase: "design", title: "B", model: "sonnet" },
        { phase: "design", title: "A", model: "sonnet" },
      ],
      { phase: "implement", title: "C", model: "opus" },
    ]);

    const board = getBoardData(db, project.id);
    const byId = new Map(board.lanes[0].tasks.map((task) => [task.id, task]));

    expect(byId.get(unsliced.id)?.slices).toEqual([]);
    expect(byId.get(sliced.id)?.slices.map((slice) => slice.label)).toEqual(["S1", "S2", "S3"]);
    expect(byId.get(sliced.id)?.slices.map((slice) => slice.title)).toEqual(["B", "A", "C"]);
    expect(
      byId.get(sliced.id)?.slices.map((slice) => ({ step: slice.step, position: slice.position })),
    ).toEqual([
      { step: 1, position: 1 },
      { step: 1, position: 2 },
      { step: 2, position: 1 },
    ]);
    expect(byId.get(sliced.id)?.slices.map((slice) => slice.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("numbers each task's slices from S1 and never shows another project's slices (TTM-84)", () => {
    const { db, project } = setup();
    const first = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "First",
      complexity_hint: "normal",
    }).task;
    const second = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Second",
      complexity_hint: "normal",
    }).task;
    const other = createProject(db, { name: "Other", root_path: "/tmp/other" });
    const foreign = createTask(db, noopEstimator, {
      project_id: other.id,
      title: "Foreign",
      complexity_hint: "normal",
    }).task;

    setTaskSlices(db, first.id, [
      { phase: "implement", title: "first-1" },
      { phase: "verify", title: "first-2" },
    ]);
    setTaskSlices(db, second.id, [
      { phase: "implement", title: "second-1" },
      { phase: "verify", title: "second-2" },
    ]);
    setTaskSlices(db, foreign.id, [{ phase: "implement", title: "foreign-1" }]);

    const board = getBoardData(db, project.id);
    const tasks = board.lanes.flatMap((lane) => lane.tasks);
    const byId = new Map(tasks.map((task) => [task.id, task]));

    // The label counter restarts per task: the second task's slices are S1/S2,
    // not S3/S4 carried over from the first.
    expect(byId.get(first.id)?.slices.map((slice) => slice.label)).toEqual(["S1", "S2"]);
    expect(byId.get(second.id)?.slices.map((slice) => slice.label)).toEqual(["S1", "S2"]);
    expect(byId.get(second.id)?.slices.map((slice) => slice.title)).toEqual(["second-1", "second-2"]);
    expect(tasks.flatMap((task) => task.slices.map((slice) => slice.title))).not.toContain("foreign-1");
  });
});

describe("board.js laneTitle (client-side, via DOM shim)", () => {
  it("appends the non-cancelled task count to a backlog ('no release') lane, excluding the cancelled one", () => {
    const { laneTitle } = loadBoardScript();
    const lane = {
      release_id: null,
      release_version: null,
      release_name: null,
      release_status: null,
      release_notes: null,
      tasks: [{ status: "done" }, { status: "pending" }, { status: "cancelled" }],
    };

    expect(laneTitle(lane)).toBe("Backlog (2)");
  });

  it("appends the non-cancelled task count to a named release lane, excluding cancelled tasks", () => {
    const { laneTitle } = loadBoardScript();
    const lane = {
      release_id: "release-1",
      release_version: "0.6.0",
      release_name: "Name",
      release_status: "planned",
      release_notes: null,
      tasks: [
        { status: "done" },
        { status: "pending" },
        { status: "in_progress" },
        { status: "cancelled" },
        { status: "cancelled" },
      ],
    };

    expect(laneTitle(lane)).toBe("Release-0.6.0 - Name (3)");
  });
});

describe("board.js createLane for a cancelled release (client-side, via DOM shim)", () => {
  function laneStub(overrides: Record<string, unknown> = {}): any {
    return {
      release_id: "r1",
      release_version: "2.2.0",
      release_name: "",
      release_status: "planned",
      release_notes: null,
      release_cancellation_reason: null,
      tasks: [],
      ...overrides,
    };
  }

  // createLane returns the <section>, whose children are [headerRow, columns]
  // in that order (see board.js); headerRow's own children are the heading
  // followed by whichever of badge/notes/reason buttons apply.
  function partsOf(section: any) {
    const [headerRow, columns] = section.children;
    return { headerRow, columns };
  }

  it("tags the lane with its release status and badges a cancelled one, defaulting it to collapsed", () => {
    const { createLane } = loadBoardScript();
    const section = createLane(
      laneStub({ release_status: "cancelled", release_cancellation_reason: "bench gate said no" }),
      "DEM",
    );
    const { headerRow, columns } = partsOf(section);

    // The dataset attribute is the only hook style.css has for the red lane
    // header - CSS can't see release_status any other way.
    expect(section.dataset.releaseStatus).toBe("cancelled");
    expect(headerRow.children.map((child: any) => child.textContent)).toContain("Cancelled");
    // Same default a shipped release gets: finished work, out of the way.
    expect(columns.hidden).toBe(true);
  });

  it("offers the cancellation reason through the same dialog button release notes use", () => {
    const { createLane } = loadBoardScript();
    const { headerRow } = partsOf(
      createLane(
        laneStub({ release_status: "cancelled", release_cancellation_reason: "bench gate said no" }),
        "DEM",
      ),
    );

    const reasonButton = headerRow.children.find(
      (child: any) => child.textContent === "Cancellation reason",
    );
    expect(reasonButton).toBeDefined();
    expect(reasonButton.className).toBe("lane-notes-button");
  });

  it("leaves a planned lane unbadged, expanded, and with no cancellation button", () => {
    const { createLane } = loadBoardScript();
    const { headerRow, columns } = partsOf(createLane(laneStub(), "DEM"));

    expect(headerRow.children.map((child: any) => child.textContent)).not.toContain("Cancelled");
    expect(
      headerRow.children.some((child: any) => child.textContent === "Cancellation reason"),
    ).toBe(false);
    expect(columns.hidden).toBe(false);
  });

  it("leaves the Backlog lane's release-status dataset unset rather than the string 'null'", () => {
    const { createLane } = loadBoardScript();
    const section = createLane(
      laneStub({ release_id: null, release_version: null, release_status: null }),
      "DEM",
    );

    expect(section.dataset.releaseStatus).toBeUndefined();
  });
});

describe("board.js createLane Plan button and dialog (client-side, via DOM shim)", () => {
  function laneWithPlanStub(): any {
    return {
      release_id: "r1",
      release_version: "1.0",
      release_name: "Name",
      release_status: "planned",
      release_notes: null,
      release_cancellation_reason: null,
      tasks: [
        { id: "a", task_number: 1, title: "First", status: "done" },
        { id: "b", task_number: 2, title: "Second", status: "pending" },
      ],
      plan: {
        status: "draft",
        rationale: "",
        approved_by: null,
        approval_note: null,
        approved_at: null,
        drifted: false,
        unplanned_task_ids: [],
        items: [
          { task_id: "a", step: 1, note: "", new_since_approval: false },
          { task_id: "b", step: 2, note: "", new_since_approval: false },
        ],
      },
    };
  }

  function partsOf(section: any) {
    const [headerRow, columns] = section.children;
    return { headerRow, columns };
  }

  it("renders a Plan button only when the lane has a plan", () => {
    const { createLane } = loadBoardScript();
    const withPlan = partsOf(createLane(laneWithPlanStub(), "DEM"));
    const withoutPlan = partsOf(createLane({ ...laneWithPlanStub(), plan: null }, "DEM"));

    expect(withPlan.headerRow.children.some((c: any) => c.textContent === "Plan")).toBe(true);
    expect(withoutPlan.headerRow.children.some((c: any) => c.textContent === "Plan")).toBe(false);
  });

  it("clicking Plan opens the plan dialog without toggling the lane's collapse state", () => {
    const sandbox = loadBoardScript();
    const section = sandbox.createLane(laneWithPlanStub(), "DEM");
    const { headerRow, columns } = partsOf(section);
    const planButton = headerRow.children.find((c: any) => c.textContent === "Plan");

    expect(columns.hidden).toBe(false);
    fireClick(planButton);

    // Collapse toggling lives on the heading's own click listener, a
    // separate element from this button - same guarantee the Release notes
    // button already relies on - so firing the button's listener must leave
    // it untouched.
    expect(columns.hidden).toBe(false);
    expect(sandbox.document.getElementById("plan-dialog").showModalCalls).toBe(1);
  });

  it("lists plan items grouped by step, in order, struck through (by data-status) when the task is done or cancelled", () => {
    const sandbox = loadBoardScript();
    const lane = laneWithPlanStub();
    lane.tasks = [
      { id: "a", task_number: 1, title: "First", status: "done" },
      { id: "b", task_number: 2, title: "Second", status: "pending" },
      { id: "c", task_number: 3, title: "Third", status: "cancelled" },
    ];
    lane.plan.items = [
      { task_id: "a", step: 1, note: "", new_since_approval: false },
      { task_id: "b", step: 2, note: "", new_since_approval: false },
      { task_id: "c", step: 3, note: "", new_since_approval: false },
    ];
    const section = sandbox.createLane(lane, "DEM");
    fireClick(partsOf(section).headerRow.children.find((c: any) => c.textContent === "Plan"));

    const stepsList = sandbox.document.getElementById("plan-steps");
    expect(stepsList.children).toHaveLength(3);
    // Each step's <li> is [stepLabel, ...one .plan-item per row] - one row
    // here since each of these three items sits alone in its own step.
    const rows = stepsList.children.map((stepEl: any) => stepEl.children[1]);
    expect(rows.map((row: any) => row.dataset.status)).toEqual(["done", "pending", "cancelled"]);
    expect(rows.map((row: any) => row.textContent)).toEqual(["DEM-1 - First", "DEM-2 - Second", "DEM-3 - Third"]);
  });

  it("shows the drift warning naming the unplanned tasks when the plan has drifted, and hides it when it hasn't", () => {
    const sandbox = loadBoardScript();
    const lane = laneWithPlanStub();
    lane.tasks.push({ id: "c", task_number: 3, title: "Unplanned", status: "pending" });
    lane.plan.drifted = true;
    lane.plan.unplanned_task_ids = ["c"];
    const section = sandbox.createLane(lane, "DEM");
    fireClick(partsOf(section).headerRow.children.find((c: any) => c.textContent === "Plan"));

    const warning = sandbox.document.getElementById("plan-drift-warning");
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain("DEM-3");
  });

  it("hides the drift warning and shows the approver for an approved, non-drifted plan", () => {
    const sandbox = loadBoardScript();
    const lane = laneWithPlanStub();
    lane.plan.status = "approved";
    lane.plan.approved_by = "valentin";
    lane.plan.approval_note = "looks right";
    const section = sandbox.createLane(lane, "DEM");
    fireClick(partsOf(section).headerRow.children.find((c: any) => c.textContent === "Plan"));

    expect(sandbox.document.getElementById("plan-drift-warning").hidden).toBe(true);
    expect(sandbox.document.getElementById("plan-approval").textContent).toContain("valentin");
  });
});

describe("board.js groupSlicesByPhase (client-side, via DOM shim)", () => {
  // TTM-88: slices arrive from the board API in step/position order, which
  // doesn't necessarily follow SLICE_PHASES' fixed
  // design/implement/verify/measure order. Grouping must walk the given
  // order and only start a new group when the phase actually changes,
  // rather than bucketing by phase first (which silently re-sorts).
  it("keeps three phases in the order they were sliced, not SLICE_PHASES order", () => {
    const { groupSlicesByPhase } = loadBoardScript();
    const slices = [
      { id: "1", phase: "measure", step: 1, label: "S1" },
      { id: "2", phase: "implement", step: 2, label: "S2" },
      { id: "3", phase: "verify", step: 3, label: "S3" },
    ];

    const groups = groupSlicesByPhase(slices);

    expect(groups.map((g: any) => g.phase)).toEqual(["measure", "implement", "verify"]);
    expect(groups.flatMap((g: any) => g.steps.flatMap((s: any) => s.slices.map((sl: any) => sl.label)))).toEqual([
      "S1",
      "S2",
      "S3",
    ]);
  });

  it("gives a recurring phase its own second group instead of merging it with the first", () => {
    const { groupSlicesByPhase } = loadBoardScript();
    const slices = [
      { id: "1", phase: "measure", step: 1, label: "S1" },
      { id: "2", phase: "implement", step: 2, label: "S2" },
      { id: "3", phase: "measure", step: 3, label: "S3" },
    ];

    const groups = groupSlicesByPhase(slices);

    expect(groups).toHaveLength(3);
    expect(groups.map((g: any) => g.phase)).toEqual(["measure", "implement", "measure"]);
    expect(groups.map((g: any) => g.steps[0].slices[0].label)).toEqual(["S1", "S2", "S3"]);
  });

  it("keeps a shared-step parallel pair inside a phase as a single step group", () => {
    const { groupSlicesByPhase } = loadBoardScript();
    const slices = [
      { id: "1", phase: "implement", step: 1, label: "S1" },
      { id: "2", phase: "implement", step: 1, label: "S2" },
      { id: "3", phase: "verify", step: 2, label: "S3" },
    ];

    const groups = groupSlicesByPhase(slices);

    expect(groups).toHaveLength(2);
    expect(groups[0].phase).toBe("implement");
    expect(groups[0].steps).toHaveLength(1);
    expect(groups[0].steps[0].slices.map((sl: any) => sl.label)).toEqual(["S1", "S2"]);
    expect(groups[1].phase).toBe("verify");
  });
});
