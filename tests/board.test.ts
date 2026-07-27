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
      { release_id: null, release_version: null, release_name: null, tasks: [] },
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
