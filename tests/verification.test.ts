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

function initBareTempRepo(prefix = "ttmcp-verify-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  return dir;
}

function initTempRepo(): string {
  const dir = initBareTempRepo();
  writeFileSync(path.join(dir, "README.md"), "init\n");
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

/**
 * Commits whatever is in the tree. `date` (an ISO string) backdates both the
 * author and committer date, which is how the "commit predates the task" case
 * is tested without sleeping.
 */
function commitAll(dir: string, message: string, date?: string): void {
  execSync(`git add -A && git commit -q -m ${JSON.stringify(message)}`, {
    cwd: dir,
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : { ...process.env },
  });
}

/** A bound comfortably before "now", so a commit made right after it counts. */
function justBefore(): string {
  return new Date(Date.now() - 60_000).toISOString();
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
 * The committed-work half of the check (the bug this suite was extended for:
 * a task whose work is committed - the normal end state under the branch
 * workflow - used to read as "no changes" and had to be forced through).
 * Both directions matter: committed work passes, untouched files still fail.
 */
describe("GitDiffCompletionVerifier + committed work", () => {
  const verifier = new GitDiffCompletionVerifier();
  let dir: string;

  beforeEach(() => {
    dir = initTempRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when the declared file's change is committed on the current (base) branch", () => {
    const since = justBefore();
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "work");

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], changesSinceIso: since });
    expect(result.passed).toBe(true);
  });

  it("passes when the work is committed on a task branch off the base branch", () => {
    const since = justBefore();
    execSync("git checkout -q -b fix/some-task", { cwd: dir });
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "work");

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], changesSinceIso: since });
    expect(result.passed).toBe(true);
  });

  it("still fails when the declared file was never touched, even though the branch has commits", () => {
    const since = justBefore();
    writeFileSync(path.join(dir, "b.txt"), "unrelated\n");
    commitAll(dir, "unrelated work");

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], changesSinceIso: since });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/no changes detected/);
  });

  it("does not count a commit that predates the task", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "old work", "2020-01-01T00:00:00Z");

    const result = verifier.verify({
      rootPath: dir,
      filePaths: ["a.txt"],
      changesSinceIso: new Date().toISOString(),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/no changes detected/);
  });

  it("counts a commit made in the same second the task was created", () => {
    // git records commit times at second precision, created_at at millisecond
    // precision - the bound is floored to the second so this doesn't read as
    // "committed before its own task".
    const since = new Date().toISOString();
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "work", since.replace(/\.\d+Z$/, "Z"));

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], changesSinceIso: since });
    expect(result.passed).toBe(true);
  });

  it("passes when the declared file was deleted and the deletion is committed", () => {
    const since = justBefore();
    execSync("git rm -q README.md", { cwd: dir });
    commitAll(dir, "drop the file");

    const result = verifier.verify({
      rootPath: dir,
      filePaths: ["README.md"],
      changesSinceIso: since,
    });
    expect(result.passed).toBe(true);
  });

  it("passes on a detached HEAD", () => {
    const since = justBefore();
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "work");
    execSync("git checkout -q --detach", { cwd: dir });

    const result = verifier.verify({ rootPath: dir, filePaths: ["a.txt"], changesSinceIso: since });
    expect(result.passed).toBe(true);
  });

  it("returns a verdict in a linked worktree, in both directions", () => {
    const since = justBefore();
    const worktree = `${dir}-wt`;
    try {
      execSync(`git worktree add -q -b wt-branch ${JSON.stringify(worktree)}`, { cwd: dir });

      const untouched = verifier.verify({
        rootPath: worktree,
        filePaths: ["a.txt"],
        changesSinceIso: since,
      });
      expect(untouched.passed).toBe(false);

      writeFileSync(path.join(worktree, "a.txt"), "changed\n");
      commitAll(worktree, "work in the worktree");

      const touched = verifier.verify({
        rootPath: worktree,
        filePaths: ["a.txt"],
        changesSinceIso: since,
      });
      expect(touched.passed).toBe(true);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("returns a verdict in a repo with no commits at all", () => {
    const empty = initBareTempRepo("ttmcp-empty-");
    try {
      const untouched = verifier.verify({
        rootPath: empty,
        filePaths: ["a.txt"],
        changesSinceIso: justBefore(),
      });
      expect(untouched.passed).toBe(false);
      expect(untouched.reason).toMatch(/no changes detected/);

      writeFileSync(path.join(empty, "a.txt"), "new\n");
      const touched = verifier.verify({
        rootPath: empty,
        filePaths: ["a.txt"],
        changesSinceIso: justBefore(),
      });
      expect(touched.passed).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("returns a verdict (never throws) when rootPath is not a git repository", () => {
    const nonGitDir = mkdtempSync(path.join(tmpdir(), "ttmcp-nogit-"));
    try {
      const result = verifier.verify({
        rootPath: nonGitDir,
        filePaths: ["a.txt"],
        changesSinceIso: justBefore(),
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/could not check git status/);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("returns a verdict on an unparseable timestamp instead of throwing", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "work");

    const result = verifier.verify({
      rootPath: dir,
      filePaths: ["a.txt"],
      changesSinceIso: "not-a-timestamp",
    });
    expect(result.passed).toBe(false);
  });

  it("falls back to the working-tree-only check when no timestamp is supplied", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    commitAll(dir, "work");

    expect(verifier.verify({ rootPath: dir, filePaths: ["a.txt"] }).passed).toBe(false);
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
      complexity_hint: "normal",
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

  it("accepts a completion whose declared file was changed and committed, without force", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Add a config file",
      file_paths: ["config.json"],
      complexity_hint: "normal",
    });

    writeFileSync(path.join(dir, "config.json"), "{}\n");
    commitAll(dir, "feat: add config");
    // Clean tree, work done - the case that used to force every completion.
    expect(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }).trim()).toBe("");

    expect(completeTask(db, verifier, { task_id: task.id })).toEqual({ unblocked_task_ids: [] });
    expect(db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id)).toMatchObject({
      status: "done",
    });
  });

  it("still rejects a completion when the commits touched some other file", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Add a config file",
      file_paths: ["config.json"],
      complexity_hint: "normal",
    });

    writeFileSync(path.join(dir, "somewhere-else.txt"), "unrelated\n");
    commitAll(dir, "chore: unrelated");

    expect(() => completeTask(db, verifier, { task_id: task.id })).toThrow(
      CompletionVerificationError,
    );
    // ...and the force escape hatch still gets past it.
    expect(() => completeTask(db, verifier, { task_id: task.id, force: true })).not.toThrow();
  });

  it("also requires the test_command to pass when one is given", () => {
    const db = openDatabase(":memory:");
    const project = createProject(db, { name: "Demo", root_path: dir });
    const { task } = createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Add a config file",
      file_paths: ["config.json"],
      complexity_hint: "normal",
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
