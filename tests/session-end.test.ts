import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { claimTask, expireSessionLeases } from "../src/domain/lifecycle.js";
import { createProject } from "../src/domain/projects.js";
import { setTaskSlices, startSlice } from "../src/domain/slices.js";
import { getNextTask } from "../src/domain/status.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";

/**
 * TTM-100: the SessionEnd hook CLI (docs/design/TTM-100-session-end.md,
 * "Tests"). The CLI cases drive src/cli/session-end.ts through tsx with a JSON
 * payload on stdin, the way Claude Code runs the hook, against a DB in a temp
 * dir; they use real time. Only the same-millisecond case fakes the clock,
 * and it calls the domain function directly.
 */

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

const here = path.dirname(fileURLToPath(import.meta.url));

/** Same resolution as tests/cli.test.ts (see the comment there). */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("tsx/package.json");
  const bin = (JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: string }).bin;
  return path.resolve(path.dirname(manifestPath), bin);
}

const tsxCli = resolveTsxCli();
const cliPath = path.join(here, "..", "src", "cli", "session-end.ts");

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSessionEnd(dbPath: string, stdin: string): CliRun {
  const result = spawnSync(process.execPath, [tsxCli, cliPath], {
    env: { ...process.env, TASK_TRACKER_DB_PATH: dbPath },
    input: stdin,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function payload(sessionId: string, reason = "other"): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    hook_event_name: "SessionEnd",
    reason,
  });
}

/** Every line of every session-end log in `dir`, with the file it came from. */
function logLines(dir: string): Array<{ file: string; fields: string[] }> {
  return readdirSync(dir)
    .filter((name) => name.startsWith("session-end-"))
    .flatMap((file) =>
      readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => ({ file, fields: line.split("\t") })),
    );
}

type Db = ReturnType<typeof openDatabase>;

function leaseRow(db: Db, taskId: string) {
  return db
    .prepare(`SELECT status, owner_session_id, lock_expires_at, updated_at FROM tasks WHERE id = ?`)
    .get(taskId) as {
    status: string;
    owner_session_id: string | null;
    lock_expires_at: string | null;
    updated_at: string;
  };
}

function seed(db: Db, titles: string[]) {
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const tasks = titles.map(
    (title) =>
      createTask(db, noopEstimator, { project_id: project.id, title, complexity_hint: "normal" }).task,
  );
  return { project, tasks };
}

// Each CLI run is a tsx cold start (~0.7 s); a busy machine must not time them out.
describe("session-end CLI (TTM-100)", { timeout: 30_000 }, () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ttmcp-session-end-"));
    dbPath = path.join(dir, "tracker.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("expires the ended session's task so the next get_next_task reclaims it with reclaimed_from", () => {
    let db = openDatabase(dbPath);
    const { project, tasks } = seed(db, ["Held by A"]);
    const task = tasks[0]!;
    claimTask(db, task.id, "session-A");
    const before = leaseRow(db, task.id);
    // A live lease: without the hook nothing would hand this task out.
    expect(getNextTask(db, project.id).task).toBeNull();
    db.close();

    const run = runSessionEnd(dbPath, payload("session-A"));
    expect(run).toEqual({ status: 0, stdout: "", stderr: "" });

    db = openDatabase(dbPath);
    const after = leaseRow(db, task.id);
    expect(after.status).toBe("in_progress");
    expect(after.owner_session_id).toBe("session-A");
    expect(after.lock_expires_at! < new Date().toISOString()).toBe(true);
    // Ending a session is not work on the task.
    expect(after.updated_at).toBe(before.updated_at);

    const next = getNextTask(db, project.id);
    expect(next.task?.id).toBe(task.id);
    expect(next).toMatchObject({ reclaimed_from: { owner_session_id: "session-A" } });
    db.close();
  });

  it("writes one tab-separated line to session-end-<UTC YYYY-MM>.log next to the DB", () => {
    let db = openDatabase(dbPath);
    const { project, tasks } = seed(db, ["First", "Second", "Not A's"]);
    claimTask(db, tasks[0]!.id, "session-A");
    claimTask(db, tasks[1]!.id, "session-A");
    claimTask(db, tasks[2]!.id, "session-B");
    db.close();

    const startedAt = new Date().toISOString();
    const run = runSessionEnd(dbPath, payload("session-A", "clear"));
    const endedAt = new Date().toISOString();
    expect(run).toEqual({ status: 0, stdout: "", stderr: "" });

    const lines = logLines(dir);
    expect(lines).toHaveLength(1);
    const { file, fields } = lines[0]!;
    const [at, sessionId, reason, outcome] = fields;
    expect(fields).toHaveLength(4);
    expect(at! >= startedAt && at! <= endedAt).toBe(true);
    // The month in the name is the UTC month of the line's own timestamp.
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(file).toBe(`session-end-${at!.slice(0, 7)}.log`);
    expect(sessionId).toBe("session-A");
    expect(reason).toBe("clear");
    const codes = [tasks[0]!, tasks[1]!].map((t) => `${project.code_prefix}-${t.task_number}`);
    expect(outcome!.startsWith("expired ")).toBe(true);
    expect(outcome!.slice("expired ".length).split(",").sort()).toEqual(codes.sort());

    // A second run appends; a session holding nothing logs "expired none".
    expect(runSessionEnd(dbPath, payload("session-nobody")).status).toBe(0);
    const again = logLines(dir);
    expect(again).toHaveLength(2);
    expect(again[1]!.fields.slice(1)).toEqual(["session-nobody", "other", "expired none"]);
  });

  it("leaves a task held by another session untouched", () => {
    let db = openDatabase(dbPath);
    const { project, tasks } = seed(db, ["Held by A", "Held by B"]);
    claimTask(db, tasks[0]!.id, "session-A");
    claimTask(db, tasks[1]!.id, "session-B");
    const bBefore = leaseRow(db, tasks[1]!.id);
    db.close();

    expect(runSessionEnd(dbPath, payload("session-A")).status).toBe(0);

    db = openDatabase(dbPath);
    expect(leaseRow(db, tasks[1]!.id)).toEqual(bBefore);
    // Only A's task comes back; B's live lease keeps it held.
    expect(getNextTask(db, project.id).task?.id).toBe(tasks[0]!.id);
    expect(getNextTask(db, project.id).task).toBeNull();
    db.close();
  });

  it("leaves done and cancelled tasks of the session with their lease value", () => {
    let db = openDatabase(dbPath);
    const { tasks } = seed(db, ["Done", "Cancelled"]);
    // complete_task and cancel_task clear the lease themselves, so a finished
    // row would be skipped by `lock_expires_at IS NOT NULL` alone. These rows
    // keep a lease on purpose: only the status filter can leave them alone.
    for (const [task, status] of [
      [tasks[0]!, "done"],
      [tasks[1]!, "cancelled"],
    ] as const) {
      claimTask(db, task.id, "session-A");
      db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, task.id);
    }
    const before = tasks.map((t) => leaseRow(db, t.id));
    expect(before.every((row) => row.lock_expires_at !== null)).toBe(true);
    db.close();

    expect(runSessionEnd(dbPath, payload("session-A")).status).toBe(0);

    db = openDatabase(dbPath);
    expect(tasks.map((t) => leaseRow(db, t.id))).toEqual(before);
    db.close();
    expect(logLines(dir)[0]!.fields[3]).toBe("expired none");
  });

  it("leaves a task that a newer session re-claimed after a reclaim", () => {
    let db = openDatabase(dbPath);
    const { project, tasks } = seed(db, ["Passed on"]);
    const task = tasks[0]!;
    claimTask(db, task.id, "session-A");
    db.close();

    // A ends; the task is reclaimed and claimed by B.
    expect(runSessionEnd(dbPath, payload("session-A")).status).toBe(0);
    db = openDatabase(dbPath);
    const next = getNextTask(db, project.id);
    expect(next).toMatchObject({ task: { id: task.id }, reclaimed_from: { owner_session_id: "session-A" } });
    claimTask(db, task.id, "session-B");
    const bHolds = leaseRow(db, task.id);
    expect(bHolds.owner_session_id).toBe("session-B");
    expect(bHolds.lock_expires_at! > new Date().toISOString()).toBe(true);
    db.close();

    // A late or repeated SessionEnd for A must not touch B's lease.
    expect(runSessionEnd(dbPath, payload("session-A")).status).toBe(0);
    db = openDatabase(dbPath);
    expect(leaseRow(db, task.id)).toEqual(bHolds);
    expect(getNextTask(db, project.id).task).toBeNull();
    db.close();
  });

  it("never moves an already-lapsed lease later", () => {
    let db = openDatabase(dbPath);
    const { project, tasks } = seed(db, ["Lapsed"]);
    const task = tasks[0]!;
    claimTask(db, task.id, "session-A");
    // Real time here: the lapsed lease is written directly, an hour back.
    const lapsedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE tasks SET lock_expires_at = ? WHERE id = ?`).run(lapsedAt, task.id);
    db.close();

    expect(runSessionEnd(dbPath, payload("session-A")).status).toBe(0);

    db = openDatabase(dbPath);
    expect(leaseRow(db, task.id).lock_expires_at).toBe(lapsedAt);
    expect(getNextTask(db, project.id)).toMatchObject({
      reclaimed_from: { owner_session_id: "session-A", lock_expires_at: lapsedAt },
    });
    db.close();
  });

  describe("never disturbs the exit when the DB is unavailable", () => {
    function expectQuietErrorLine(logDir: string) {
      const lines = logLines(logDir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.fields[1]).toBe("session-A");
      expect(lines[0]!.fields[3]).toMatch(/^error /);
    }

    it("a missing DB file: exit 0, silent, no DB created, error logged", () => {
      const run = runSessionEnd(dbPath, payload("session-A"));
      expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(existsSync(dbPath)).toBe(false);
      expect(readdirSync(dir).filter((name) => name.startsWith("tracker.db"))).toEqual([]);
      expectQuietErrorLine(dir);
    });

    it("a garbage DB file: exit 0, silent, file left as is, error logged", () => {
      writeFileSync(dbPath, "this is not a sqlite database, just text padding it out ".repeat(20));
      const before = readFileSync(dbPath);
      const run = runSessionEnd(dbPath, payload("session-A"));
      expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(readFileSync(dbPath)).toEqual(before);
      expectQuietErrorLine(dir);
    });

    it("a DB directory that does not exist: exit 0, silent, nothing created", () => {
      const missingDir = path.join(dir, "no-such-dir");
      const run = runSessionEnd(path.join(missingDir, "tracker.db"), payload("session-A"));
      expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
      // No mkdir: neither the DB nor the log gets a directory made for it.
      expect(existsSync(missingDir)).toBe(false);
    });
  });

  describe("bad stdin: exit 0, silent, one error line", () => {
    beforeEach(() => {
      const db = openDatabase(dbPath);
      seed(db, ["Untouched"]);
      db.close();
    });

    it.each([
      ["empty", ""],
      ["not JSON", "{not json"],
      ["JSON null", "null"],
      ["no session_id", JSON.stringify({ reason: "other" })],
      ["empty session_id", JSON.stringify({ session_id: "", reason: "other" })],
      ["non-string session_id", JSON.stringify({ session_id: 42 })],
    ])("%s", (_label, stdin) => {
      const run = runSessionEnd(dbPath, stdin);
      expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
      const lines = logLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.fields[1]).toBe("-");
      expect(lines[0]!.fields[3]).toMatch(/^error /);
    });
  });
});

describe("expireSessionLeases (TTM-100)", () => {
  function setup(titles: string[]) {
    const db = openDatabase(":memory:");
    return { db, ...seed(db, titles) };
  }

  it("returns the expired tasks' codes, not their uuids, and only the session's in_progress ones", () => {
    const { db, project, tasks } = setup(["A1", "A2", "B1", "Pending"]);
    claimTask(db, tasks[0]!.id, "session-A");
    claimTask(db, tasks[1]!.id, "session-A");
    claimTask(db, tasks[2]!.id, "session-B");

    const expired = expireSessionLeases(db, "session-A", new Date().toISOString());
    expect(expired.sort()).toEqual(
      [tasks[0]!, tasks[1]!].map((t) => `${project.code_prefix}-${t.task_number}`).sort(),
    );
    expect(expired).not.toContain(tasks[0]!.id);
    expect(expireSessionLeases(db, "session-nobody", new Date().toISOString())).toEqual([]);
  });

  it("a resumed session with the same id renews the expired lease with its next slice write", () => {
    const { db, project, tasks } = setup(["Resumed"]);
    const task = tasks[0]!;
    setTaskSlices(db, task.id, [{ phase: "implement", title: "slice 1" }]);
    claimTask(db, task.id, "session-A");

    expireSessionLeases(db, "session-A", new Date().toISOString());
    expect(leaseRow(db, task.id).lock_expires_at! < new Date().toISOString()).toBe(true);

    startSlice(db, `${task.id}/S1`);
    const row = leaseRow(db, task.id);
    expect(row.owner_session_id).toBe("session-A");
    expect(row.lock_expires_at! > new Date().toISOString()).toBe(true);
    expect(getNextTask(db, project.id).task).toBeNull();
  });

  describe("with a fake clock", () => {
    const T0 = Date.parse("2026-10-04T09:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("lets a get_next_task in the same millisecond as the session end reclaim the task", () => {
      const { db, project, tasks } = setup(["Same ms"]);
      const task = tasks[0]!;
      claimTask(db, task.id, "session-A");

      vi.setSystemTime(T0 + 5 * 60 * 1000);
      const nowIso = new Date().toISOString();
      expireSessionLeases(db, "session-A", nowIso);
      expect(leaseRow(db, task.id).lock_expires_at).toBe(new Date(Date.parse(nowIso) - 1).toISOString());

      // The clock has not moved: same millisecond as the expiry.
      expect(new Date().toISOString()).toBe(nowIso);
      const next = getNextTask(db, project.id);
      expect(next.task?.id).toBe(task.id);
      expect(next).toMatchObject({ reclaimed_from: { owner_session_id: "session-A" } });
    });
  });
});
