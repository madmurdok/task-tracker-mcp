import { randomUUID } from "node:crypto";
import type { DatabaseInstance } from "../db/connection.js";

export interface Project {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

export function createProject(
  db: DatabaseInstance,
  input: { name: string; root_path: string },
): Project {
  const project: Project = {
    id: randomUUID(),
    name: input.name,
    root_path: input.root_path,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO projects (id, name, root_path, created_at) VALUES (@id, @name, @root_path, @created_at)`,
  ).run(project);

  return project;
}
