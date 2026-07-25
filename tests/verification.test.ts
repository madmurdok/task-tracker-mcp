import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import { completeTask, CompletionVerificationError } from "../src/domain/lifecycle.js";
import { GitDiffCompletionVerifier } from "../src/domain/verification.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function initTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-verify-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "init\n");
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

describe("GitDiffCompletionVerifier", () => {
  const verifier = new GitDiffCompletionVerifier();
  let dir: string;

  beforeEach(() => {
    dir = initTempRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when a declared file has an uncommitted change", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"] });
    expect(result.passed).toBe(true);
  });

  it("fails when none of the declared files changed", () => {
    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"] });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/no changes detected/);
  });

  it("passes trivially when there are no declared files and no test command", () => {
    const result = verifier.verify({ rootPath: dir, filePaths: [] });
    expect(result.passed).toBe(true);
  });

  it("fails gracefully when rootPath is not a git repository", () => {
    const nonGitDir = mkdtempSync(path.join(tmpdir(), "ttmcp-nogit-"));
    try {
      const result = verifier.verify({ rootPath: nonGitDir, filePaths: ["a.txt"] });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/could not check git status/);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("passes when a test command is given and exits zero", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], testCommand: "true" });
    expect(result.passed).toBe(true);
  });

  it("fails when the test command exits non-zero, even if files changed", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], testCommand: "false" });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/test command failed/);
  });

  it("fails on the file check before ever running the test command", () => {
    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], testCommand: "true" });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/no changes detected/);
  });
});

/**
 * B3: the real GitDiffCompletionVerifier wired through the real DB/domain
 * layer, not the mock verifiers B2's tests use for control - proves the
 * pieces actually work together against a real git-backed project.
 */
describe("completeTask against a real project + a real git repo", () => {
  const verifier = new GitDiffCompletionVerifier();
  let dir: string;

  beforeEach(() => {
    dir = initTempRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects completion until the declared file is actually touched, then accepts it", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Add a config file",
      file_paths: ["config.json"],
    });

    expect(() => completeTask(db, verifier, { task_id: task.id })).toThrow(
      CompletionVerificationError,
    );

    writeFileSync(path.join(dir, "config.json"), "{}\n");

    const result = completeTask(db, verifier, { task_id: task.id });
    expect(result).toEqual({ unblocked_task_ids: [] });

    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "done" });
  });

  it("also requires the test_command to pass when one is given", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Add a config file",
      file_paths: ["config.json"],
    });
    writeFileSync(path.join(dir, "config.json"), "{}\n");

    expect(() =>
      completeTask(db, verifier, { task_id: task.id, test_command: "node -e 'process.exit(1)'" }),
    ).toThrow(CompletionVerificationError);

    expect(() =>
      completeTask(db, verifier, { task_id: task.id, test_command: "node -e 'process.exit(0)'" }),
    ).not.toThrow();
  });
});
