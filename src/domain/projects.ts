import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseInstance } from "../db/connection.js";

export interface Project {
  id: string;
  name: string;
  root_path: string;
  code_prefix: string;
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
 * Short human-facing project code that fronts every task's display number
 * (`TTM-42`) - a stable handle a person can say out loud, unlike the uuid.
 * Derived from the name rather than asked for as an input so every existing
 * project can be backfilled without anyone having to pick one (see
 * backfillProjectPrefixes in db/schema.ts).
 *
 * Multi-word names become their initials (`task-tracker-mcp` -> `TTM`,
 * `g-mesh` -> `GM`); a single word is truncated to 3 letters (`Demo` ->
 * `DEM`), since a one-letter code reads as noise. Any non-alphanumeric run
 * counts as a word separator, so spaces, dots and underscores work the same
 * as hyphens. A name with no alphanumerics at all has no initials to take -
 * it falls back to `PRJ` rather than returning an empty prefix that would
 * render as a bare `-7`.
 */
export function derivePrefix(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter((word) => word.length > 0);
  if (words.length === 0) return "PRJ";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join("").toUpperCase();
}

/**
 * Makes a derived prefix unique by suffixing 2, 3, ... on collision
 * (`g-mesh` and `game-mode` both derive to `GM`, so the second becomes
 * `GM2`). Shared by createProject and the startup backfill so a prefix
 * assigned at either point plays by the same rules; `taken` is the caller's
 * view of the prefixes already in use, which the backfill grows as it walks
 * projects so two freshly-derived collisions don't both win.
 */
export function dedupePrefix(prefix: string, taken: ReadonlySet<string>): string {
  if (!taken.has(prefix)) return prefix;
  let suffix = 2;
  while (taken.has(`${prefix}${suffix}`)) {
    suffix += 1;
  }
  return `${prefix}${suffix}`;
}

export function takenPrefixes(db: DatabaseInstance): Set<string> {
  const rows = db
    .prepare(`SELECT code_prefix FROM projects WHERE code_prefix IS NOT NULL`)
    .all() as Array<{ code_prefix: string }>;
  return new Set(rows.map((row) => row.code_prefix));
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

/**
 * Resolves a project reference (id or unique name) or throws - the single
 * point every project-scoped domain function routes through so `project_id`
 * inputs can be either without duplicating the id-then-name lookup.
 */
export function requireProject(db: DatabaseInstance, ref: string): Project {
  const project = getProject(db, ref);
  if (!project) {
    throw new Error(`Unknown project: ${ref}`);
  }
  return project;
}

export function createProject(db: DatabaseInstance, input: CreateProjectInput): Project {
  const designDocHash = input.design_doc_path
    ? hashDesignDoc(input.root_path, input.design_doc_path)
    : null;

  const project: Project = {
    id: randomUUID(),
    name: input.name,
    root_path: input.root_path,
    code_prefix: dedupePrefix(derivePrefix(input.name), takenPrefixes(db)),
    design_doc_path: input.design_doc_path ?? null,
    design_doc_hash: designDocHash,
    created_at: new Date().toISOString(),
  };

  try {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, code_prefix, design_doc_path, design_doc_hash, created_at)
       VALUES (@id, @name, @root_path, @code_prefix, @design_doc_path, @design_doc_hash, @created_at)`,
    ).run(project);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error(`Project name already in use: ${input.name}`);
    }
    throw error;
  }

  return project;
}

/**
 * Sets or clears the design doc tracked for an existing project, hashing it
 * now exactly as createProject does, so a project registered without a doc
 * can still get drift detection (checkDocSync's `acknowledge` only re-baselines
 * a path that is already set).
 *
 * A focused setter rather than a general `update_project`, following the
 * set_task_priority precedent (its own single-purpose tool rather than a
 * general "update_task", since priority was the only mutable field that
 * problem needed). The same holds here: the doc is the only project field
 * that needs to change after creation, and the others would each carry a
 * cost a general setter hides - `name` is an identifier every tool accepts in
 * place of the id, `code_prefix` is baked into every task code already
 * handed out, and changing `root_path` would silently re-resolve the doc
 * against a different directory under an old hash.
 *
 * Unlike createProject, an unreadable path is refused rather than stored
 * with a null hash: here the caller is explicitly asking for tracking, and a
 * stored path that never hashed would just report drift forever. The error
 * names the resolved path, since a path relative to the wrong root is the
 * usual cause. Passing null clears both columns, after which checkDocSync
 * reports `tracked: false`.
 */
export function setDesignDoc(
  db: DatabaseInstance,
  projectRef: string,
  designDocPath: string | null,
): Project {
  const project = requireProject(db, projectRef);

  let designDocHash: string | null = null;
  if (designDocPath !== null) {
    designDocHash = hashDesignDoc(project.root_path, designDocPath);
    if (designDocHash === null) {
      throw new Error(
        `Design doc not readable: ${path.resolve(project.root_path, designDocPath)}`,
      );
    }
  }

  db.prepare(`UPDATE projects SET design_doc_path = ?, design_doc_hash = ? WHERE id = ?`).run(
    designDocPath,
    designDocHash,
    project.id,
  );

  return { ...project, design_doc_path: designDocPath, design_doc_hash: designDocHash };
}

export interface DocSyncResult {
  tracked: boolean;
  in_sync: boolean;
  design_doc_path: string | null;
  stored_hash: string | null;
  current_hash: string | null;
}

/**
 * Cheap, allocation-free drift check reused by getNextTask/getProjectStatus
 * (status.ts) so drift surfaces on every routine status check instead of only
 * when Claude remembers to call check_doc_sync directly (see Item 5 in
 * REQUIREMENTS.md). An unreadable doc (current_hash null) counts as drifted,
 * same "fail closed" call checkDocSync already makes below.
 */
export function isDocDrifted(project: Project): boolean {
  if (!project.design_doc_path) return false;
  const currentHash = hashDesignDoc(project.root_path, project.design_doc_path);
  return currentHash === null || currentHash !== project.design_doc_hash;
}

/**
 * Compares a project's design doc against the hash captured when it was last
 * tracked (create_project's design_doc_path, or the last `acknowledge: true`
 * call). `tracked: false` means no doc was ever registered - there's nothing
 * to compare, so nothing to flag. A missing/unreadable doc (current_hash null)
 * always counts as *not* in sync rather than silently passing, matching the
 * "fail closed" approach CompletionVerifier already takes for a similar
 * problem (see verification.ts).
 *
 * `acknowledge: true` persists the current hash as the new baseline once
 * Claude has manually reconciled the task graph with the doc's new content -
 * the only way to do that before this option existed was to re-run
 * create_project, which created a whole new project rather than updating the
 * existing one in place.
 */
export function checkDocSync(
  db: DatabaseInstance,
  projectRef: string,
  options?: { acknowledge?: boolean },
): DocSyncResult {
  const project = requireProject(db, projectRef);

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

  if (options?.acknowledge && currentHash !== null) {
    db.prepare(`UPDATE projects SET design_doc_hash = ? WHERE id = ?`).run(currentHash, project.id);
    return {
      tracked: true,
      in_sync: true,
      design_doc_path: project.design_doc_path,
      stored_hash: currentHash,
      current_hash: currentHash,
    };
  }

  return {
    tracked: true,
    in_sync: currentHash !== null && currentHash === project.design_doc_hash,
    design_doc_path: project.design_doc_path,
    stored_hash: project.design_doc_hash,
    current_hash: currentHash,
  };
}
