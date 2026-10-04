import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";
import { appendTaskToPlan, removeTaskFromPlan } from "./planWrites.js";
import { requireProject } from "./projects.js";
import { resolveTaskId, runOne } from "./tasks.js";

/**
 * `cancelled` is the terminal status for a batch that was built but
 * deliberately never shipped (a gate said don't ship it, a branch that will
 * never be merged) - without it such a release sits at 100% done and
 * `planned` forever, misrepresenting the board. Set only via cancelRelease
 * (see lifecycle.ts), and one-shot like a cancelled task: there is no
 * un-cancel.
 */
export type ReleaseStatus = "planned" | "released" | "cancelled";

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
  cancellation_reason: string | null;
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
    cancellation_reason: null,
    created_at: new Date().toISOString(),
  };

  try {
    db.prepare(
      `INSERT INTO releases (id, project_id, version, name, description, status, sequence, release_notes, released_at, cancellation_reason, created_at)
       VALUES (@id, @project_id, @version, @name, @description, @status, @sequence, @release_notes, @released_at, @cancellation_reason, @created_at)`,
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
 *
 * A cancelled release is closed to *inbound* tasks for a different reason:
 * it's a terminal record of work that was abandoned, so adding fresh work to
 * it would say something untrue about that work. Note the asymmetry this
 * creates against setTaskRelease's outbound check, explained there.
 *
 * `action` names what the caller was trying to do, because this guard is no
 * longer only about task assignment: writing and approving a release plan
 * (plans.ts) go through it for the same "a finished batch is a frozen record"
 * reason. Defaulted rather than required so the task-assignment callers read
 * as they always did, and worth passing because "cannot assign new tasks to
 * it" is actively misleading in answer to an approve_plan call - it sends
 * someone looking for a task they never touched.
 */
export function requireAssignableRelease(
  db: DatabaseInstance,
  projectId: string,
  ref: string,
  action = "assign new tasks to it",
): Release {
  const release = requireRelease(db, projectId, ref);
  if (release.status === "released") {
    throw new Error(`Release ${ref} is already released; cannot ${action}`);
  }
  if (release.status === "cancelled") {
    throw new Error(`Release ${ref} is cancelled; cannot ${action}`);
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
  const row = db
    .prepare(`SELECT project_id, release_id FROM tasks WHERE id = ?`)
    .get(taskId) as
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
 *
 * The outbound check below is keyed on `released` only, deliberately: moving a
 * task *out of* a cancelled release is allowed, even though moving one *in* is
 * not. That asymmetry is the point, not an oversight - rescuing the
 * salvageable parts of an abandoned batch into a later release is a real
 * workflow, and unlike a released release there are no generated
 * release_notes for the membership to drift away from, which is the only
 * reason the outbound direction is frozen for shipped releases at all.
 *
 * TTM-68: this one function carries both directions of the plan-revert rule -
 * `currentReleaseId` is the outbound side (dropped from its old release's
 * plan, if any), `newReleaseId` the inbound side (appended to its new
 * release's plan, if any). Both run inside the same transaction as the
 * `tasks` write itself, and only when the release actually changes - calling
 * setTaskRelease with the release a task is already in is not membership
 * drift and must not shuffle it to the end of anyone's plan.
 */
export function setTaskRelease(db: DatabaseInstance, taskRef: string, releaseRef: string | null): void {
  // Resolved once, at the top, and used for both the lookup and the write.
  // Wrapping only the lookup is what made this silently do nothing when given
  // a task code: the UPDATE below still bound the caller's raw reference.
  const taskId = resolveTaskId(db, taskRef);
  const { projectId, releaseId: currentReleaseId } = requireTaskProjectAndRelease(db, taskId);

  if (currentReleaseId) {
    const currentRelease = requireRelease(db, projectId, currentReleaseId);
    if (currentRelease.status === "released") {
      throw new Error(`Task ${taskId}'s current release is already released; cannot move it out`);
    }
  }

  const newReleaseId = releaseRef ? requireAssignableRelease(db, projectId, releaseRef).id : null;

  const run = db.transaction((): void => {
    runOne(
      db.prepare(`UPDATE tasks SET release_id = ?, updated_at = ? WHERE id = ?`),
      `set_task_release ${taskRef}`,
      newReleaseId,
      new Date().toISOString(),
      taskId,
    );

    if (currentReleaseId && currentReleaseId !== newReleaseId) {
      removeTaskFromPlan(db, currentReleaseId, taskId);
    }
    if (newReleaseId && newReleaseId !== currentReleaseId) {
      appendTaskToPlan(db, newReleaseId, taskId);
    }
  });

  run();
}

/**
 * Manual reordering of a release's position in list_releases - not blocked
 * by `released` or `cancelled` status (unlike setTaskRelease's freeze rule),
 * since where a past release *shows up* in a list is unrelated to the
 * task-membership-drift problem that rule exists for.
 */
export function setReleaseSequence(
  db: DatabaseInstance,
  projectRef: string,
  releaseRef: string,
  sequence: number,
): void {
  // Resolve the project first, like every other project_id-taking function
  // here does (createRelease, cancelRelease, etc.) - passing the raw ref
  // straight into requireRelease's project-scoped lookup silently fails to
  // match anything when it's a name rather than a uuid, and the resulting
  // "Unknown release" error then blames the release for what was actually an
  // unresolved project.
  const project = requireProject(db, projectRef);
  const release = requireRelease(db, project.id, releaseRef);
  db.prepare(`UPDATE releases SET sequence = ? WHERE id = ?`).run(sequence, release.id);
}

export interface SetReleaseDetailsInput {
  project_id: string;
  release_id: string;
  /** Omitted leaves the name as is; null or "" clears it to "". */
  name?: string | null;
  /** Omitted leaves the description as is; null or "" clears it to "". */
  description?: string | null;
}

/**
 * Renames a release and/or rewrites its description - the only two release
 * fields createRelease writes that had no way to change afterwards, so a
 * placeholder name given at creation was permanent.
 *
 * One setter for both fields rather than one per field, and still not a
 * general "update_release". The set_task_priority precedent (its own
 * single-purpose tool rather than a general "update_task") and setDesignDoc
 * (projects.ts) both argue for a setter scoped to exactly the fields a
 * problem needs, excluding every field whose change carries a cost a general
 * setter would hide. Here the problem needs two fields, and they carry the
 * same (zero) cost: both are free-text labels that nothing resolves by,
 * nothing derives from and no invariant constrains. Two tools would be
 * identical twins differing only in a column name. Every other column stays
 * out, each for its own reason:
 * - `version` is an identifier: unique per project, accepted in place of the
 *   id by every release_id argument, and the name of a release branch and a
 *   bumped manifest outside this database.
 * - `status`, `released_at`, `release_notes` and `cancellation_reason` are
 *   owned by the lifecycle (releaseIt, cancelRelease), which set them once,
 *   together, behind their own gates.
 * - `sequence` has its own setter, setReleaseSequence.
 * The UPDATE below names its two columns literally rather than building a
 * column list from the input, so no input shape can reach any other column.
 *
 * Not blocked by `released` or `cancelled` status, unlike
 * requireAssignableRelease's freeze. That freeze protects task *membership*,
 * because release_notes were generated from exactly the tasks in the release
 * at release_it time; the notes are built from task titles and summaries
 * only, never from the release's name or description, so relabelling a past
 * release cannot drift them. And the motivating case - a placeholder name
 * that should have been a real one, or left empty - is no less wrong on a
 * release that has already shipped or been abandoned.
 *
 * Clearing is allowed: null and "" both store "" (the columns are NOT NULL
 * DEFAULT '', the same value createRelease stores for an omitted field),
 * since "a real name or none" makes "none" a legitimate target. Passing
 * neither field is refused rather than treated as a no-op, as it is almost
 * certainly a caller mistake.
 */
export function setReleaseDetails(db: DatabaseInstance, input: SetReleaseDetailsInput): Release {
  if (input.name === undefined && input.description === undefined) {
    throw new Error("set_release_details needs at least one of name or description");
  }
  const project = requireProject(db, input.project_id);
  const release = requireRelease(db, project.id, input.release_id);

  const name = input.name === undefined ? release.name : (input.name ?? "");
  const description =
    input.description === undefined ? release.description : (input.description ?? "");

  db.prepare(`UPDATE releases SET name = ?, description = ? WHERE id = ?`).run(
    name,
    description,
    release.id,
  );

  return { ...release, name, description };
}
