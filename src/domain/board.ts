import type { DatabaseInstance } from "../db/connection.js";
import { listEpics } from "./epics.js";
import { isDocDrifted, requireProject } from "./projects.js";
import { listReleases } from "./releases.js";
import { displayStatus, type DisplayStatus } from "./status.js";
import type { Task } from "./tasks.js";

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  status: DisplayStatus;
  priority: number;
  epic_id: string | null;
  epic_name: string | null;
  owner_session_id: string | null;
  is_stale: boolean;
  task_number: number;
}

export interface BoardLane {
  release_id: string | null;
  release_version: string | null;
  release_name: string | null;
  release_status: "planned" | "released" | null;
  release_notes: string | null;
  tasks: BoardTask[];
}

export interface BoardData {
  project_id: string;
  project_name: string;
  project_code_prefix: string;
  doc_drift: boolean;
  lanes: BoardLane[];
}

/**
 * A task is "stale" once its lock has outlived the 30-minute lease
 * (LOCK_LEASE_MS in status.ts) but the session that held it never came back
 * to complete/split/release it - the same condition get_next_task's
 * reclaim logic checks, surfaced here as an early visual signal instead of
 * waiting for the next get_next_task call to silently reassign it.
 */
function isStale(task: Task, nowIso: string): boolean {
  return task.status === "in_progress" && task.lock_expires_at !== null && task.lock_expires_at < nowIso;
}

/**
 * Read-only aggregation for the dashboard (REQUIREMENTS.md Item 8): groups a
 * project's tasks into swimlanes by release (a "no release"/Backlog lane
 * always first, then one per release newest-sequence-first), and shapes each task with
 * exactly the fields the board needs - between TaskSummary (too little: no
 * priority/description/ownership) and TaskDetail (too much: drags in
 * file_paths/handoff_notes/acceptance_criteria, which are agent-facing detail
 * a human watching the board doesn't need).
 */
export function getBoardData(db: DatabaseInstance, projectRef: string): BoardData {
  const project = requireProject(db, projectRef);
  const nowIso = new Date().toISOString();

  const tasks = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC`)
    .all(project.id) as Task[];
  const releases = listReleases(db, project.id);
  const epicNameById = new Map(listEpics(db, project.id).map((epic) => [epic.id, epic.name]));

  const toBoardTask = (task: Task): BoardTask => ({
    id: task.id,
    title: task.title,
    description: task.description,
    status: displayStatus(db, task),
    priority: task.priority,
    epic_id: task.epic_id,
    epic_name: task.epic_id ? (epicNameById.get(task.epic_id) ?? null) : null,
    owner_session_id: task.owner_session_id,
    is_stale: isStale(task, nowIso),
    task_number: task.task_number,
  });

  const lanes: BoardLane[] = [];

  const unreleasedTasks = tasks.filter((task) => task.release_id === null).map(toBoardTask);
  // Always show the "no release" (Backlog) lane first, even when empty - it's
  // a fixed landmark at the top of the board, not something that should
  // appear/disappear as tasks get assigned to releases.
  lanes.push({
    release_id: null,
    release_version: null,
    release_name: null,
    release_status: null,
    release_notes: null,
    tasks: unreleasedTasks,
  });

  // listReleases orders oldest/lowest-sequence first (needed as-is for
  // list_releases and status aggregation); the board instead wants the most
  // recent release directly under Backlog, so reverse a local copy just for
  // lane ordering.
  for (const release of [...releases].reverse()) {
    lanes.push({
      release_id: release.id,
      release_version: release.version,
      release_name: release.name,
      release_status: release.status,
      release_notes: release.release_notes,
      tasks: tasks.filter((task) => task.release_id === release.id).map(toBoardTask),
    });
  }

  return {
    project_id: project.id,
    project_name: project.name,
    project_code_prefix: project.code_prefix,
    doc_drift: isDocDrifted(project),
    lanes,
  };
}
