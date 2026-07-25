#!/usr/bin/env node
import { openDatabase } from "../db/connection.js";
import { getProject, listProjects, type Project } from "../domain/projects.js";
import { getProjectStatus, listTasks } from "../domain/status.js";
import type { DatabaseInstance } from "../db/connection.js";

function printProjectSummary(db: DatabaseInstance, project: Project): void {
  const status = getProjectStatus(db, project.id);
  console.log(`${project.name} (${project.id})`);
  console.log(`  root: ${project.root_path}`);
  console.log(
    `  total ${status.total} | done ${status.done} | in_progress ${status.in_progress} | ` +
      `blocked ${status.blocked} | pending ${status.pending} | ${status.percent}%`,
  );
}

function printTaskList(db: DatabaseInstance, projectId: string): void {
  const tasks = listTasks(db, projectId);
  if (tasks.length === 0) {
    console.log("  (no tasks)");
    return;
  }
  for (const task of tasks) {
    console.log(`  [${task.status.padEnd(11)}] ${task.id}  ${task.title}  (~${task.estimated_tokens} tok)`);
  }
}

function main(): void {
  const db = openDatabase();
  const [ref] = process.argv.slice(2);

  if (!ref) {
    const projects = listProjects(db);
    if (projects.length === 0) {
      console.log("No projects registered.");
      return;
    }
    projects.forEach((project, i) => {
      printProjectSummary(db, project);
      if (i < projects.length - 1) console.log();
    });
    return;
  }

  const project = getProject(db, ref);
  if (!project) {
    console.error(`Unknown project: ${ref}`);
    process.exitCode = 1;
    return;
  }

  printProjectSummary(db, project);
  console.log();
  printTaskList(db, project.id);
}

main();
