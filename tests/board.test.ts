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
import { createRelease } from "../src/domain/releases.js";
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
    addEventListener() {},
    setAttribute() {},
    showModal() {},
    close() {},
  };
  return el;
}

// Resolved relative to this test file (not process.cwd()) so it always reads
// the board.js sitting next to it in this checkout/worktree, regardless of
// what directory the test runner itself was launched from.
const BOARD_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/dashboard/public/board.js");

function loadBoardScript(): any {
  const src = readFileSync(BOARD_JS_PATH, "utf8");
  const sandbox: any = {
    document: {
      title: "",
      createElement: () => domElementStub(),
      getElementById: () => domElementStub(),
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
  it("puts unreleased tasks in a 'no release' lane and released ones in their own release lane, in sequence order", () => {
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
    expect(board.lanes).toHaveLength(3);
    expect(board.lanes[0]).toMatchObject({ release_id: null });
    expect(board.lanes[0].tasks.map((t) => t.title)).toEqual(["Backlog item"]);
    expect(board.lanes[1]).toMatchObject({ release_id: v1.id, release_version: "0.1" });
    expect(board.lanes[1].tasks.map((t) => t.title)).toEqual(["For v0.1"]);
    expect(board.lanes[2]).toMatchObject({ release_id: v2.id, release_version: "0.2" });
    expect(board.lanes[2].tasks.map((t) => t.title)).toEqual(["For v0.2"]);
  });

  it("surfaces a release's status and release_notes on its lane; both are null for a planned release and for the no-release lane", () => {
    const { db, project } = setup();
    const planned = createRelease(db, { project_id: project.id, version: "0.2" });
    const released = createRelease(db, { project_id: project.id, version: "0.1" });
    db.prepare(`UPDATE releases SET status = 'released', release_notes = ? WHERE id = ?`).run(
      "- Task A\n- Task B",
      released.id,
    );
    createTask(db, noopEstimator, { project_id: project.id, title: "Backlog item", complexity_hint: "normal" });

    const board = getBoardData(db, project.id);
    const byReleaseId = new Map(board.lanes.map((lane) => [lane.release_id, lane]));

    expect(byReleaseId.get(null)).toMatchObject({ release_status: null, release_notes: null });
    expect(byReleaseId.get(planned.id)).toMatchObject({ release_status: "planned", release_notes: null });
    expect(byReleaseId.get(released.id)).toMatchObject({
      release_status: "released",
      release_notes: "- Task A\n- Task B",
    });
  });

  it("omits the 'no release' lane once every task has a release, but keeps it when there are no releases yet", () => {
    const { db, project } = setup();
    const v1 = createRelease(db, { project_id: project.id, version: "0.1" });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Only task",
      complexity_hint: "normal",
      release_id: v1.id,
    });

    expect(getBoardData(db, project.id).lanes.map((l) => l.release_id)).toEqual([v1.id]);

    const { db: db2, project: project2 } = setup();
    expect(getBoardData(db2, project2.id).lanes).toEqual([
      {
        release_id: null,
        release_version: null,
        release_name: null,
        release_status: null,
        release_notes: null,
        tasks: [],
      },
    ]);
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
