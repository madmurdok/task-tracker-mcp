import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import {
  checkDocSync,
  createProject,
  derivePrefix,
  getProject,
  requireProject,
} from "../src/domain/projects.js";

describe("derivePrefix", () => {
  it("takes the initial of every word for a multi-word name", () => {
    expect(derivePrefix("task-tracker-mcp")).toBe("TTM");
    expect(derivePrefix("g-mesh")).toBe("GM");
  });

  it("treats any non-alphanumeric run as a word separator", () => {
    expect(derivePrefix("My Cool Project")).toBe("MCP");
    expect(derivePrefix("task_tracker.mcp")).toBe("TTM");
    expect(derivePrefix("  spaced   out  ")).toBe("SO");
  });

  it("truncates a single-word name to its first three letters", () => {
    expect(derivePrefix("Demo")).toBe("DEM");
    expect(derivePrefix("tracker")).toBe("TRA");
  });

  it("keeps a short single word as-is rather than padding it", () => {
    expect(derivePrefix("Hi")).toBe("HI");
  });

  it("keeps digits, which are as usable in a prefix as letters", () => {
    expect(derivePrefix("web3-api")).toBe("WA");
    expect(derivePrefix("2fa")).toBe("2FA");
  });

  it("falls back to PRJ for a name with nothing alphanumeric to derive from", () => {
    expect(derivePrefix("!!!")).toBe("PRJ");
    expect(derivePrefix("")).toBe("PRJ");
  });
});

describe("createProject", () => {
  it("assigns a prefix derived from the project name", () => {
    const db = openDatabase(":memory:");

    const project = createProject(db, { name: "task-tracker-mcp", root_path: "/tmp/ttm" });

    expect(project.code_prefix).toBe("TTM");
    expect(db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id)).toMatchObject({
      code_prefix: "TTM",
    });
  });

  it("de-duplicates a prefix already taken by another project", () => {
    const db = openDatabase(":memory:");

    expect(createProject(db, { name: "g-mesh", root_path: "/tmp/a" }).code_prefix).toBe("GM");
    expect(createProject(db, { name: "game-mode", root_path: "/tmp/b" }).code_prefix).toBe("GM2");
    expect(createProject(db, { name: "grand-machine", root_path: "/tmp/c" }).code_prefix).toBe("GM3");
  });

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

  it("rejects a duplicate project name", () => {
    const db = openDatabase(":memory:");
    createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    expect(() => createProject(db, { name: "Demo", root_path: "/tmp/other" })).toThrow(
      /Project name already in use: Demo/,
    );
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

describe("getProject / requireProject", () => {
  it("resolves a project by id", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    expect(getProject(db, project.id)).toEqual(project);
    expect(requireProject(db, project.id)).toEqual(project);
  });

  it("resolves a project by name", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    expect(getProject(db, "Demo")).toEqual(project);
    expect(requireProject(db, "Demo")).toEqual(project);
  });

  it("getProject returns undefined and requireProject throws for an unknown ref", () => {
    const db = openDatabase(":memory:");

    expect(getProject(db, "missing")).toBeUndefined();
    expect(() => requireProject(db, "missing")).toThrow(/Unknown project: missing/);
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
    expect(() => checkDocSync(db, "missing")).toThrow(/Unknown project: missing/);
  });

  it("resolves the project by name as well as by id", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });

    expect(checkDocSync(db, "Demo")).toEqual(checkDocSync(db, project.id));
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
