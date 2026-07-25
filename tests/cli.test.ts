import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };
const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const cliPath = path.join(process.cwd(), "src", "cli", "status.ts");

function runCli(dbPath: string, args: string[] = []): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(tsx, [cliPath, ...args], {
      env: { ...process.env, TASK_TRACKER_DB_PATH: dbPath },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("status CLI", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ttmcp-cli-"));
    dbPath = path.join(dir, "tracker.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints every registered project's status when run with no args", () => {
    const db = openDatabase(dbPath);
    createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    db.close();

    const { stdout, status } = runCli(dbPath);

    expect(status).toBe(0);
    expect(stdout).toMatch(/Demo/);
    expect(stdout).toMatch(/total 0/);
  });

  it("prints a project's task list when given its id", () => {
    const db = openDatabase(dbPath);
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    createTask(db, noopEstimator, { project_id: project.id, title: "Do the thing" });
    db.close();

    const { stdout, status } = runCli(dbPath, [project.id]);

    expect(status).toBe(0);
    expect(stdout).toMatch(/Demo/);
    expect(stdout).toMatch(/total 1 \| done 0 \| in_progress 0 \| blocked 0 \| pending 1 \| 0%/);
    expect(stdout).toMatch(/\[pending\s+\].*Do the thing/);
  });

  it("resolves a project by name as well as by id", () => {
    const db = openDatabase(dbPath);
    createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    db.close();

    const { stdout, status } = runCli(dbPath, ["Demo"]);

    expect(status).toBe(0);
    expect(stdout).toMatch(/Demo/);
  });

  it("exits non-zero with an error for an unknown project", () => {
    const db = openDatabase(dbPath);
    db.close();

    const { status } = runCli(dbPath, ["does-not-exist"]);

    expect(status).not.toBe(0);
  });
});
