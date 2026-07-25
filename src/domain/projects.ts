import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseInstance } from "../db/connection.js";

export interface Project {
  id: string;
  name: string;
  root_path: string;
  design_doc_path: string | null;
  design_doc_hash: string | null;
  created_at: string;
}

export interface CreateProjectInput {
  name: string;
  root_path: string;
  design_doc_path?: string;
}

/**
 * Hashes the design doc's current content so a later check_doc_sync call can
 * detect whether it changed since the task graph was generated from it (see
 * "Auto re-sync when the design doc changes" in the doc's Non-goals - v2).
 * Returns null if the file can't be read (e.g. a typo'd path) rather than
 * throwing, so a bad path doesn't block creating the project - it just means
 * nothing is being tracked yet.
 */
export function hashDesignDoc(rootPath: string, designDocPath: string): string | null {
  try {
    const content = fs.readFileSync(path.resolve(rootPath, designDocPath), "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export function listProjects(db: DatabaseInstance): Project[] {
  return db.prepare(`SELECT * FROM projects ORDER BY created_at ASC`).all() as Project[];
}

export function getProject(db: DatabaseInstance, idOrName: string): Project | undefined {
  return (
    (db.prepare(`SELECT * FROM projects WHERE id = ?`).get(idOrName) as Project | undefined) ??
    (db.prepare(`SELECT * FROM projects WHERE name = ?`).get(idOrName) as Project | undefined)
  );
}

export function createProject(db: DatabaseInstance, input: CreateProjectInput): Project {
  const designDocHash = input.design_doc_path
    ? hashDesignDoc(input.root_path, input.design_doc_path)
    : null;

  const project: Project = {
    id: randomUUID(),
    name: input.name,
    root_path: input.root_path,
    design_doc_path: input.design_doc_path ?? null,
    design_doc_hash: designDocHash,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO projects (id, name, root_path, design_doc_path, design_doc_hash, created_at)
     VALUES (@id, @name, @root_path, @design_doc_path, @design_doc_hash, @created_at)`,
  ).run(project);

  return project;
}

export interface DocSyncResult {
  tracked: boolean;
  in_sync: boolean;
  design_doc_path: string | null;
  stored_hash: string | null;
  current_hash: string | null;
}

/**
 * Compares a project's design doc against the hash captured when it was last
 * tracked (create_project's design_doc_path). `tracked: false` means no doc
 * was ever registered - there's nothing to compare, so nothing to flag.
 * A missing/unreadable doc (current_hash null) always counts as *not*
 * in sync rather than silently passing, matching the "fail closed" approach
 * CompletionVerifier already takes for a similar problem (see verification.ts).
 */
export function checkDocSync(db: DatabaseInstance, projectId: string): DocSyncResult {
  const project = db
    .prepare(`SELECT root_path, design_doc_path, design_doc_hash FROM projects WHERE id = ?`)
    .get(projectId) as
    | { root_path: string; design_doc_path: string | null; design_doc_hash: string | null }
    | undefined;

  if (!project) {
    throw new Error(`Unknown project_id: ${projectId}`);
  }

  if (!project.design_doc_path) {
    return {
      tracked: false,
      in_sync: true,
      design_doc_path: null,
      stored_hash: null,
      current_hash: null,
    };
  }

  const currentHash = hashDesignDoc(project.root_path, project.design_doc_path);

  return {
    tracked: true,
    in_sync: currentHash !== null && currentHash === project.design_doc_hash,
    design_doc_path: project.design_doc_path,
    stored_hash: project.design_doc_hash,
    current_hash: currentHash,
  };
}
