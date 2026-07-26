import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { requireProject } from "./projects.js";

export type ReleaseStatus = "planned" | "released";

export interface Release {
  id: string;
  project_id: string;
  version: string;
  name: string;
  description: string;
  status: ReleaseStatus;
  sequence: number;
  release_notes: string | null;
  released_at: string | null;
  created_at: string;
}

export interface CreateReleaseInput {
  project_id: string;
  version: string;
  name?: string;
  description?: string;
}

/**
 * `sequence` is what listReleases actually orders by - a release has a real
 * order (its version number) that plain created_at can't be trusted to match
 * (e.g. a "0.1.1" hotfix created after "0.2" already exists). Auto-assigned in
 * gaps of 10, not 1, so a release can later be manually slotted between two
 * existing ones (via set_release_sequence) without renumbering anything else.
 */
function nextSequence(db: DatabaseInstance, projectId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) AS max FROM releases WHERE project_id = ?`)
    .get(projectId) as { max: number };
  return row.max + 10;
}

export function createRelease(db: DatabaseInstance, input: CreateReleaseInput): Release {
  const project = requireProject(db, input.project_id);

  const release: Release = {
    id: randomUUID(),
    project_id: project.id,
    version: input.version,
    name: input.name ?? "",
    description: input.description ?? "",
    status: "planned",
    sequence: nextSequence(db, project.id),
    release_notes: null,
    released_at: null,
    created_at: new Date().toISOString(),
  };

  try {
    db.prepare(
      `INSERT INTO releases (id, project_id, version, name, description, status, sequence, release_notes, released_at, created_at)
       VALUES (@id, @project_id, @version, @name, @description, @status, @sequence, @release_notes, @released_at, @created_at)`,
    ).run(release);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error(`Release version already in use in this project: ${input.version}`);
    }
    throw error;
  }

  return release;
}

export function listReleases(db: DatabaseInstance, projectId: string): Release[] {
  return db
    .prepare(`SELECT * FROM releases WHERE project_id = ? ORDER BY sequence ASC, created_at ASC`)
    .all(projectId) as Release[];
}

/**
 * Resolves a release by id or by version - like epics.name, releases.version
 * is only unique within a project (see schema), so the lookup must be scoped
 * by projectId to disambiguate the same version reused across projects.
 */
export function getRelease(db: DatabaseInstance, projectId: string, ref: string): Release | undefined {
  return (
    (db.prepare(`SELECT * FROM releases WHERE id = ? AND project_id = ?`).get(ref, projectId) as
      | Release
      | undefined) ??
    (db.prepare(`SELECT * FROM releases WHERE version = ? AND project_id = ?`).get(ref, projectId) as
      | Release
      | undefined)
  );
}

export function requireRelease(db: DatabaseInstance, projectId: string, ref: string): Release {
  const release = getRelease(db, projectId, ref);
  if (!release) {
    throw new Error(`Unknown release: ${ref}`);
  }
  return release;
}

/**
 * A released release's task membership is frozen - its release_notes were
 * generated once, at release_it time, from exactly the tasks in it then.
 * Assigning new tasks afterward would silently drift the notes away from
 * what's actually in the release, with nothing to detect it (unlike
 * check_doc_sync's drift detection for design docs). Used by createTask and
 * setTaskRelease (the latter also checks the release being moved *out of*).
 */
export function requireAssignableRelease(db: DatabaseInstance, projectId: string, ref: string): Release {
  const release = requireRelease(db, projectId, ref);
  if (release.status === "released") {
    throw new Error(`Release ${ref} is already released; cannot assign new tasks to it`);
  }
  return release;
}

/**
 * A raw lookup (not tasks.ts's requireTask) to avoid a circular import -
 * tasks.ts already imports requireAssignableRelease from here, so importing
 * requireTask back from tasks.ts would create a cycle between the two
 * modules. Same "Unknown task_id: ..." error shape as requireTask for
 * consistency.
 */
function requireTaskProjectAndRelease(
  db: DatabaseInstance,
  taskId: string,
): { projectId: string; releaseId: string | null } {
  const row = db.prepare(`SELECT project_id, release_id FROM tasks WHERE id = ?`).get(taskId) as
    | { project_id: string; release_id: string | null }
    | undefined;
  if (!row) {
    throw new Error(`Unknown task_id: ${taskId}`);
  }
  return { projectId: row.project_id, releaseId: row.release_id };
}

/**
 * Escape valve for a task that turns out not to belong in a release (or
 * belongs in a different one) - move it, or clear release_id with `null`.
 * Rejects if *either* the task's current release or its target release is
 * already released (see requireAssignableRelease) - moving a task out of a
 * released release is the same membership drift as moving one in, just
 * backwards.
 */
export function setTaskRelease(db: DatabaseInstance, taskId: string, releaseRef: string | null): void {
  const { projectId, releaseId: currentReleaseId } = requireTaskProjectAndRelease(db, taskId);

  if (currentReleaseId) {
    const currentRelease = requireRelease(db, projectId, currentReleaseId);
    if (currentRelease.status === "released") {
      throw new Error(`Task ${taskId}'s current release is already released; cannot move it out`);
    }
  }

  const newReleaseId = releaseRef ? requireAssignableRelease(db, projectId, releaseRef).id : null;

  db.prepare(`UPDATE tasks SET release_id = ?, updated_at = ? WHERE id = ?`).run(
    newReleaseId,
    new Date().toISOString(),
    taskId,
  );
}

/**
 * Manual reordering of a release's position in list_releases - not blocked
 * by `released` status (unlike setTaskRelease's freeze rule), since where a
 * past release *shows up* in a list is unrelated to the task-membership-drift
 * problem that rule exists for.
 */
export function setReleaseSequence(
  db: DatabaseInstance,
  projectId: string,
  releaseRef: string,
  sequence: number,
): void {
  const release = requireRelease(db, projectId, releaseRef);
  db.prepare(`UPDATE releases SET sequence = ? WHERE id = ?`).run(sequence, release.id);
}
