import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolved through Node's own module resolution, anchored on this file -
 * NOT built as `<process.cwd()>/node_modules/.bin/tsx`.
 *
 * The agent harness runs tasks in git worktrees under
 * .claude/worktrees/agent-<id>/, and a worktree has no `node_modules` of its
 * own. Every *import* in these tests still resolves, because Node walks up
 * the directory tree to the main checkout - but a path assembled from `cwd`
 * walks nowhere, so this one file failed 3 of its 4 cases there and nowhere
 * else. That is a phantom regression in front of every isolated agent, in a
 * file it is not editing, and the danger is not the noise itself but that a
 * real failure eventually gets waved away as "the known worktree thing".
 *
 * createRequire resolves exactly the way those imports do, so it finds the
 * same binary from a worktree and from the main checkout. `tsx/package.json`
 * rather than `tsx`, because the package's export map need not expose its
 * entry point, but package.json is always resolvable - and its own `bin`
 * field is what `node_modules/.bin/tsx` is a symlink to, so this reads the
 * declaration instead of trusting the shim's layout.
 */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("tsx/package.json");
  const bin = (JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: string }).bin;
  return path.resolve(path.dirname(manifestPath), bin);
}

const tsxCli = resolveTsxCli();
const cliPath = path.join(here, "..", "src", "cli", "status.ts");

function runCli(dbPath: string, args: string[] = []): { stdout: string; status: number } {
  try {
    // Invoked through process.execPath rather than executed directly: the
    // resolved file is a .mjs with a shebang, and relying on its exec bit
    // would make this depend on how the package was unpacked.
    const stdout = execFileSync(process.execPath, [tsxCli, cliPath, ...args], {
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
    createTask(db, noopEstimator, {
      project_id: project.id,
      title: "Do the thing",
      complexity_hint: "normal",
    });
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
