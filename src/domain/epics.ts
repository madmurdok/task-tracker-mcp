import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { requireProject } from "./projects.js";

export interface Epic {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_at: string;
}

export interface CreateEpicInput {
  project_id: string;
  name: string;
  description?: string;
}

export function createEpic(db: DatabaseInstance, input: CreateEpicInput): Epic {
  const project = requireProject(db, input.project_id);

  const epic: Epic = {
    id: randomUUID(),
    project_id: project.id,
    name: input.name,
    description: input.description ?? "",
    created_at: new Date().toISOString(),
  };

  try {
    db.prepare(
      `INSERT INTO epics (id, project_id, name, description, created_at)
       VALUES (@id, @project_id, @name, @description, @created_at)`,
    ).run(epic);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error(`Epic name already in use in this project: ${input.name}`);
    }
    throw error;
  }

  return epic;
}

export function listEpics(db: DatabaseInstance, projectId: string): Epic[] {
  return db
    .prepare(`SELECT * FROM epics WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId) as Epic[];
}

/**
 * Resolves an epic by id or by name - unlike projects.name (globally unique),
 * epics.name is only unique within a project (see schema), so the lookup must
 * be scoped by projectId to disambiguate the same name reused across projects.
 */
export function getEpic(db: DatabaseInstance, projectId: string, ref: string): Epic | undefined {
  return (
    (db.prepare(`SELECT * FROM epics WHERE id = ? AND project_id = ?`).get(ref, projectId) as
      | Epic
      | undefined) ??
    (db.prepare(`SELECT * FROM epics WHERE name = ? AND project_id = ?`).get(ref, projectId) as
      | Epic
      | undefined)
  );
}

export function requireEpic(db: DatabaseInstance, projectId: string, ref: string): Epic {
  const epic = getEpic(db, projectId, ref);
  if (!epic) {
    throw new Error(`Unknown epic: ${ref}`);
  }
  return epic;
}
