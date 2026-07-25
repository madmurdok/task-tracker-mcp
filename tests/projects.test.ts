import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { checkDocSync, createProject } from "../src/domain/projects.js";

describe("createProject", () => {
  it("inserts and returns a project with a generated id", () => {
    const db = openDatabase(":memory:");

    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    expect(project.id).toBeTruthy();
    expect(project.name).toBe("Demo");
    expect(project.design_doc_path).toBeNull();
    expect(project.design_doc_hash).toBeNull();

    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);
    expect(row).toMatchObject({ name: "Demo", root_path: "/tmp/demo" });
  });

  describe("design_doc_path", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "ttmcp-project-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("hashes the design doc's content when a path is given", () => {
      writeFileSync(path.join(dir, "design.md"), "# Design\n\nsome content\n");
      const db = openDatabase(":memory:");

      const project = createProject(db, {
        name: "Demo",
        root_path: dir,
        design_doc_path: "design.md",
      });

      expect(project.design_doc_path).toBe("design.md");
      expect(project.design_doc_hash).toMatch(/^[0-9a-f]{64}$/);

      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);
      expect(row).toMatchObject({
        design_doc_path: "design.md",
        design_doc_hash: project.design_doc_hash,
      });
    });

    it("stores a null hash when the design doc doesn't exist yet", () => {
      const db = openDatabase(":memory:");

      const project = createProject(db, {
        name: "Demo",
        root_path: dir,
        design_doc_path: "missing.md",
      });

      expect(project.design_doc_path).toBe("missing.md");
      expect(project.design_doc_hash).toBeNull();
    });
  });
});

describe("checkDocSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ttmcp-docsync-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unknown project", () => {
    const db = openDatabase(":memory:");
    expect(() => checkDocSync(db, "missing")).toThrow(/Unknown project_id/);
  });

  it("reports tracked:false when no design_doc_path was ever set", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });

    expect(checkDocSync(db, project.id)).toEqual({
      tracked: false,
      in_sync: true,
      design_doc_path: null,
      stored_hash: null,
      current_hash: null,
    });
  });

  it("reports in_sync while the doc's content is unchanged", () => {
    writeFileSync(path.join(dir, "design.md"), "v1\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir, design_doc_path: "design.md" });

    const result = checkDocSync(db, project.id);
    expect(result.tracked).toBe(true);
    expect(result.in_sync).toBe(true);
    expect(result.current_hash).toBe(result.stored_hash);
  });

  it("reports out of sync once the doc's content changes", () => {
    writeFileSync(path.join(dir, "design.md"), "v1\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir, design_doc_path: "design.md" });

    writeFileSync(path.join(dir, "design.md"), "v2 - completely different\n");

    const result = checkDocSync(db, project.id);
    expect(result.tracked).toBe(true);
    expect(result.in_sync).toBe(false);
    expect(result.current_hash).not.toBe(result.stored_hash);
  });

  it("reports out of sync (not a false pass) if the tracked doc goes missing", () => {
    writeFileSync(path.join(dir, "design.md"), "v1\n");
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir, design_doc_path: "design.md" });

    rmSync(path.join(dir, "design.md"));

    const result = checkDocSync(db, project.id);
    expect(result.in_sync).toBe(false);
    expect(result.current_hash).toBeNull();
  });
});
