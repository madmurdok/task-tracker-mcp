import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { checkDocSync, createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import { addDependency } from "../src/domain/dependencies.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

/**
 * C3: the full story auto re-sync exists for - Claude builds a task graph
 * from a design doc, the doc changes later, and check_doc_sync is how a
 * fresh session finds out its graph might be stale (see "Auto re-sync when
 * the design doc changes" in the doc's Non-goals - v2). C1/C2 already have
 * focused unit coverage in projects.test.ts; this exercises the realistic
 * end-to-end sequence against a real file on disk.
 */
describe("design doc re-sync end to end", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ttmcp-docsync-e2e-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays in sync while the graph is built from an unchanged doc", () => {
    writeFileSync(
      path.join(dir, "design.md"),
      "# Design\n\n## Tasks\n\n- Build schema\n- Build domain layer\n",
    );
    const db = openDatabase(":memory:");
    const project = createProject(db, {
      name: "Demo",
      root_path: dir,
      design_doc_path: "design.md",
    });

    const { task: schema } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
    });
    const { task: domain } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build domain layer",
    });
    addDependency(db, domain.id, schema.id);

    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: true, in_sync: true });
  });

  it("flags the graph as stale once the doc changes after it was built, until re-registered", () => {
    writeFileSync(
      path.join(dir, "design.md"),
      "# Design\n\n## Tasks\n\n- Build schema\n- Build domain layer\n",
    );
    const db = openDatabase(":memory:");
    const project = createProject(db, {
      name: "Demo",
      root_path: dir,
      design_doc_path: "design.md",
    });
    createTask(db, noopEstimator, { project_id: project.id, title: "Build schema" });

    // The doc grows a new section after the graph was already generated from it.
    writeFileSync(
      path.join(dir, "design.md"),
      "# Design\n\n## Tasks\n\n- Build schema\n- Build domain layer\n- Build a CLI\n",
    );

    const stale = checkDocSync(db, project.id);
    expect(stale.tracked).toBe(true);
    expect(stale.in_sync).toBe(false);
    expect(stale.current_hash).not.toBe(stale.stored_hash);

    // Re-registering the project against the doc's new content re-establishes sync.
    const resynced = createProject(db, {
      name: "Demo (resynced)",
      root_path: dir,
      design_doc_path: "design.md",
    });
    expect(checkDocSync(db, resynced.id)).toMatchObject({ tracked: true, in_sync: true });
  });
});
