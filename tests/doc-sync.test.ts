import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import {
  checkDocSync,
  createProject,
  getProject,
  hashDesignDoc,
  setDesignDoc,
} from "../src/domain/projects.js";
import { getNextTask, getProjectStatus } from "../src/domain/status.js";
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
      complexity_hint: "normal",
    });
    const { task: domain } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build domain layer",
      complexity_hint: "normal",
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
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });

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

  it("surfaces drift on get_next_task/get_project_status, and acknowledge clears it in place", () => {
    writeFileSync(
      path.join(dir, "design.md"),
      "# Design\n\n## Tasks\n\n- Build schema\n",
    );
    const db = openDatabase(":memory:");
    const project = createProject(db, {
      name: "Demo",
      root_path: dir,
      design_doc_path: "design.md",
    });
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Build schema",
      complexity_hint: "normal",
    });

    expect(getNextTask(db, project.id).doc_drift).toBe(false);
    expect(getProjectStatus(db, project.id).doc_drift).toBe(false);

    writeFileSync(
      path.join(dir, "design.md"),
      "# Design\n\n## Tasks\n\n- Build schema\n- Build a CLI\n",
    );

    expect(getNextTask(db, project.id).doc_drift).toBe(true);
    expect(getProjectStatus(db, project.id).doc_drift).toBe(true);

    // acknowledge:true persists the current hash as the new baseline in place -
    // no need to re-register the project under a new id/name.
    const acknowledged = checkDocSync(db, project.id, { acknowledge: true });
    expect(acknowledged).toMatchObject({ tracked: true, in_sync: true });

    expect(getNextTask(db, project.id).doc_drift).toBe(false);
    expect(getProjectStatus(db, project.id).doc_drift).toBe(false);
  });

  it("acknowledge is a no-op when there's nothing tracked or the doc can't be read", () => {
    const db = openDatabase(":memory:");
    const untracked = createProject(db, { name: "Untracked", root_path: dir });
    expect(checkDocSync(db, untracked.id, { acknowledge: true })).toMatchObject({
      tracked: false,
      in_sync: true,
    });

    const trackedButMissing = createProject(db, {
      name: "Missing doc",
      root_path: dir,
      design_doc_path: "does-not-exist.md",
    });
    const result = checkDocSync(db, trackedButMissing.id, { acknowledge: true });
    expect(result).toMatchObject({ tracked: true, in_sync: false, current_hash: null });
  });
});

/**
 * TTM-76: setDesignDoc gives a project registered without design_doc_path
 * drift detection after the fact (checkDocSync's acknowledge only re-baselines
 * a path that's already set). State is read back from the database via
 * getProject rather than trusted from the setter's return value.
 */
describe("setDesignDoc", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ttmcp-setdoc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stored(db: ReturnType<typeof openDatabase>, id: string) {
    const project = getProject(db, id)!;
    return { path: project.design_doc_path, hash: project.design_doc_hash };
  }

  it("tracks a doc on a project created without one, hashed against root_path", () => {
    writeFileSync(path.join(dir, "design.md"), "# Design\n\n- Build schema\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Late doc", root_path: dir });
    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: false });

    const expectedHash = hashDesignDoc(dir, "design.md");
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);

    const returned = setDesignDoc(db, project.id, "design.md");
    expect(returned).toMatchObject({ design_doc_path: "design.md", design_doc_hash: expectedHash });
    expect(stored(db, project.id)).toEqual({ path: "design.md", hash: expectedHash });

    expect(checkDocSync(db, project.id)).toEqual({
      tracked: true,
      in_sync: true,
      design_doc_path: "design.md",
      stored_hash: expectedHash,
      current_hash: expectedHash,
    });
    expect(getNextTask(db, project.id).doc_drift).toBe(false);

    // Tracking is real: an edit after the set is now reported as drift.
    writeFileSync(path.join(dir, "design.md"), "# Design\n\n- Build schema\n- Build a CLI\n");
    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: true, in_sync: false });
    expect(getNextTask(db, project.id).doc_drift).toBe(true);
  });

  it("resolves a nested relative path against root_path, not the process cwd", () => {
    const docsDir = path.join(dir, "docs");
    mkdirSync(docsDir);
    writeFileSync(path.join(docsDir, "arch.md"), "# Arch\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Nested", root_path: dir });

    setDesignDoc(db, project.id, "docs/arch.md");
    expect(stored(db, project.id)).toEqual({
      path: "docs/arch.md",
      hash: hashDesignDoc(dir, "docs/arch.md"),
    });
    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: true, in_sync: true });
  });

  it("re-setting to a different doc replaces the path and re-baselines, clearing existing drift", () => {
    writeFileSync(path.join(dir, "old.md"), "# Old\n");
    writeFileSync(path.join(dir, "new.md"), "# New\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Swap", root_path: dir, design_doc_path: "old.md" });

    writeFileSync(path.join(dir, "old.md"), "# Old, edited\n");
    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: true, in_sync: false });
    expect(getNextTask(db, project.id).doc_drift).toBe(true);

    setDesignDoc(db, project.id, "new.md");
    const newHash = hashDesignDoc(dir, "new.md");
    expect(newHash).not.toBe(hashDesignDoc(dir, "old.md"));
    expect(stored(db, project.id)).toEqual({ path: "new.md", hash: newHash });
    expect(checkDocSync(db, project.id)).toEqual({
      tracked: true,
      in_sync: true,
      design_doc_path: "new.md",
      stored_hash: newHash,
      current_hash: newHash,
    });
    expect(getNextTask(db, project.id).doc_drift).toBe(false);
  });

  it("re-setting the same drifted doc re-baselines it to the current content", () => {
    writeFileSync(path.join(dir, "design.md"), "# v1\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Same", root_path: dir, design_doc_path: "design.md" });
    writeFileSync(path.join(dir, "design.md"), "# v2\n");
    expect(getNextTask(db, project.id).doc_drift).toBe(true);

    setDesignDoc(db, project.id, "design.md");
    expect(stored(db, project.id).hash).toBe(hashDesignDoc(dir, "design.md"));
    expect(getNextTask(db, project.id).doc_drift).toBe(false);
  });

  it("null clears both path and hash, after which check_doc_sync reports tracked:false", () => {
    writeFileSync(path.join(dir, "design.md"), "# Design\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Clear", root_path: dir, design_doc_path: "design.md" });
    // Drift first, so a clear that left the path behind would still show drift.
    writeFileSync(path.join(dir, "design.md"), "# Design, edited\n");
    expect(getNextTask(db, project.id).doc_drift).toBe(true);

    const returned = setDesignDoc(db, project.id, null);
    expect(returned).toMatchObject({ design_doc_path: null, design_doc_hash: null });
    expect(stored(db, project.id)).toEqual({ path: null, hash: null });
    expect(checkDocSync(db, project.id)).toEqual({
      tracked: false,
      in_sync: true,
      design_doc_path: null,
      stored_hash: null,
      current_hash: null,
    });
    expect(getNextTask(db, project.id).doc_drift).toBe(false);
  });

  it("refuses an unreadable path on an untracked project, naming the resolved path, and stores nothing", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Untracked", root_path: dir });

    expect(() => setDesignDoc(db, project.id, "missing.md")).toThrow(
      `Design doc not readable: ${path.resolve(dir, "missing.md")}`,
    );
    expect(stored(db, project.id)).toEqual({ path: null, hash: null });
    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: false });
  });

  it("refuses an unreadable path on a tracked project and keeps the existing path and hash", () => {
    writeFileSync(path.join(dir, "design.md"), "# Design\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Tracked", root_path: dir, design_doc_path: "design.md" });
    const before = stored(db, project.id);
    expect(before.hash).toBe(hashDesignDoc(dir, "design.md"));

    // A directory exists but cannot be read as a file - also refused.
    mkdirSync(path.join(dir, "adir"));
    for (const bad of ["nope/missing.md", "adir"]) {
      expect(() => setDesignDoc(db, project.id, bad)).toThrow(
        `Design doc not readable: ${path.resolve(dir, bad)}`,
      );
      expect(stored(db, project.id)).toEqual(before);
    }
    expect(checkDocSync(db, project.id)).toMatchObject({ tracked: true, in_sync: true });
  });

  it("accepts the project by id or unique name, and rejects an unknown ref", () => {
    writeFileSync(path.join(dir, "design.md"), "# Design\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "By name", root_path: dir });

    setDesignDoc(db, "By name", "design.md");
    expect(stored(db, project.id).path).toBe("design.md");
    setDesignDoc(db, project.id, null);
    expect(stored(db, project.id).path).toBeNull();

    expect(() => setDesignDoc(db, "no-such-project", "design.md")).toThrow(
      "Unknown project: no-such-project",
    );
  });
});
