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
function hashDesignDoc(rootPath: string, designDocPath: string): string | null {
  try {
    const content = fs.readFileSync(path.resolve(rootPath, designDocPath), "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
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
