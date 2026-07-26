import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";

export interface HandoffNote {
  id: string;
  task_id: string;
  session_id: string;
  decisions: string;
  remaining_work: string;
  discoveries: string;
  created_at: string;
}

export interface AddHandoffNoteInput {
  task_id: string;
  session_id: string;
  decisions?: string;
  remaining_work?: string;
  discoveries?: string;
}

export function addHandoffNote(db: DatabaseInstance, input: AddHandoffNoteInput): HandoffNote {
  const note: HandoffNote = {
    id: randomUUID(),
    task_id: input.task_id,
    session_id: input.session_id,
    decisions: input.decisions ?? "",
    remaining_work: input.remaining_work ?? "",
    discoveries: input.discoveries ?? "",
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO handoff_notes (id, task_id, session_id, decisions, remaining_work, discoveries, created_at)
     VALUES (@id, @task_id, @session_id, @decisions, @remaining_work, @discoveries, @created_at)`,
  ).run(note);

  return note;
}

export function listHandoffNotes(db: DatabaseInstance, taskId: string): HandoffNote[] {
  return db
    .prepare(`SELECT * FROM handoff_notes WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as HandoffNote[];
}
