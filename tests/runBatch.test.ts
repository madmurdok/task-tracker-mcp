import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpawnError, type AgentEntry } from "../src/cli/claudeBg.js";
import {
  assertSafeArgs,
  buildBgArgs,
  buildPrompt,
  capDetail,
  DEFAULTS,
  DETAIL_CAP,
  DENY_LIST,
  parseArgs,
  parseDuration,
  runBatch,
  type RunOptions,
  type RunnerDeps,
} from "../src/cli/runBatch.js";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import { addDependency } from "../src/domain/dependencies.js";
import { listHandoffNotes } from "../src/domain/handoffNotes.js";
import { cancelTask, claimTask } from "../src/domain/lifecycle.js";
import { approvePlan, upsertPlan } from "../src/domain/plans.js";
import { createProject, type Project } from "../src/domain/projects.js";
import { createRelease } from "../src/domain/releases.js";
import { setTaskSlices } from "../src/domain/slices.js";
import { getNextTask } from "../src/domain/status.js";
import { createTask, taskCode, type Task } from "../src/domain/tasks.js";

/**
 * TTM-95: the batch runner's loop (docs/design/TTM-95-runner.md, "Loop
 * shape", "Stop conditions", "Permissions", "Behaviours tests must pin").
 * `runBatch` runs against a temp-file DB seeded through the domain functions,
 * with every side effect injected: a fake `claude` whose `agents --json` rows
 * come from a per-test scenario, a fake git, and a fake clock that `sleep`
 * advances - no real waiting, no real session, no real notification.
 *
 * The scenario plays the session: it is called on every `listAgents`, may
 * act on the DB the way the session would (claim, complete), and returns the
 * session's row (null = missing from agents --json). The domain's lease
 * functions use the real clock; the fake clock starts at real now so the
 * runner's renewLease and the domain's leases compare sensibly.
 */

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };
const MIN = 60_000;
const POLL = 30_000;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `ttm95-${tag}-`));
  dirs.push(dir);
  return dir;
}

interface Seed {
  db: DatabaseInstance;
  dir: string;
  runsDir: string;
  project: Project;
  tasks: Task[];
  codes: string[];
}

interface SeedOptions {
  approve?: boolean;
  designDoc?: boolean;
  /** Runs after the tasks exist, before the plan is written. */
  beforePlan?: (db: DatabaseInstance, project: Project, tasks: Task[]) => void;
}

function seed(n: number, o: SeedOptions = {}): Seed {
  const dir = tempDir("db");
  if (o.designDoc) writeFileSync(path.join(dir, "design.md"), "# design v1\n");
  const db = openDatabase(path.join(dir, "tracker.db"));
  const project = createProject(db, {
    name: "Demo",
    root_path: dir,
    ...(o.designDoc ? { design_doc_path: "design.md" } : {}),
  });
  const release = createRelease(db, { project_id: project.id, version: "0.1" });
  const tasks = Array.from(
    { length: n },
    (_, i) =>
      createTask(db, noopEstimator, {
        project_id: project.id,
        release_id: release.id,
        title: `task ${i}`,
        complexity_hint: "normal",
      }).task,
  );
  o.beforePlan?.(db, project, tasks);
  upsertPlan(db, project.id, "0.1", { steps: tasks.map((t) => t.id), rationale: "test order" });
  for (const t of tasks) setTaskSlices(db, t.id, [{ phase: "implement", title: "do it" }]);
  if (o.approve !== false) approvePlan(db, project.id, "0.1", { approved_by: "owner" });
  return {
    db,
    dir,
    runsDir: tempDir("runs"),
    project,
    tasks,
    codes: tasks.map((t) => taskCode(project.code_prefix, t.task_number)),
  };
}

function opts(s: Seed, o: Partial<RunOptions> = {}): RunOptions {
  return {
    project: "Demo",
    release: "0.1",
    repo: s.dir,
    timeoutMs: 4 * 60 * MIN,
    pollMs: POLL,
    graceMs: 15 * MIN,
    dryRun: false,
    runsDir: s.runsDir,
    ...o,
  };
}

interface Ctx {
  db: DatabaseInstance;
  code: string;
  taskId: string;
  bgId: string;
  sid: string;
  /** listAgents calls since this spawn; 0 is the runner's post-spawn lookup. */
  call: number;
  /** Fake ms since this spawn. */
  elapsed: number;
  now: number;
  /** The session's claim_task under its own uuid, once. */
  claim(): void;
  /** complete_task, as far as the runner can see it. */
  done(): void;
}

type Scenario = (ctx: Ctx) => Partial<AgentEntry> | null;

interface HarnessOptions {
  /** Replaces the scenario-driven listAgents entirely (--resume cases). */
  agents?: (now: number) => AgentEntry[];
  /** Rows carry no sessionId (the runner never learns the uuid). */
  hideSessionId?: boolean;
  spawnThrows?: boolean;
  /** What spawnBg throws (TTM-104: the CLI's stderr in a SpawnError). */
  spawnError?: unknown;
  /** Appended to every scenario-driven listAgents answer; may throw. */
  extraAgents?: () => AgentEntry[];
  /** workspaceTrusted's answer; "throw" makes it throw. Default null. */
  trusted?: boolean | null | "throw";
  maxSleeps?: number;
}

function setDone(db: DatabaseInstance, taskId: string): void {
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
}

function taskRow(db: DatabaseInstance, taskId: string) {
  return db.prepare("SELECT status, owner_session_id, lock_expires_at FROM tasks WHERE id = ?").get(taskId) as {
    status: string;
    owner_session_id: string | null;
    lock_expires_at: string | null;
  };
}

function harness(s: Seed, scenario: Scenario, h: HarnessOptions = {}) {
  const start = Date.now();
  let t = start;
  let sleeps = 0;
  let n = 0;
  let current: { code: string; taskId: string; bgId: string; sid: string; call: number; at: number } | null = null;
  const spawns: { code: string; args: string[]; cwd: string; at: number }[] = [];
  const stops: { id: string; at: number }[] = [];
  const notifies: { title: string; message: string; at: number }[] = [];
  const out: string[] = [];
  const git = { status: "", branch: "release-0.1" };
  const claimed = new Set<string>();
  const trustAsked: string[] = [];

  const deps: RunnerDeps = {
    claude: {
      version: () => "9.9.9 (Claude Code)",
      workspaceTrusted(dir) {
        trustAsked.push(dir);
        if (h.trusted === "throw") throw new Error("config exploded");
        return h.trusted ?? null;
      },
      spawnBg(args, cwd) {
        if (h.spawnError !== undefined) throw h.spawnError;
        if (h.spawnThrows) throw new Error("claude --bg exploded");
        n++;
        const code = args[args.indexOf("-n") + 1].replace(/ runner$/, "");
        const idx = s.codes.indexOf(code);
        current = { code, taskId: s.tasks[idx].id, bgId: `bg${n}`, sid: `sid-${n}`, call: 0, at: t };
        spawns.push({ code, args, cwd, at: t });
        return current.bgId;
      },
      listAgents() {
        if (h.agents) return h.agents(t);
        if (current === null) return [];
        const c = current;
        const row = scenario({
          db: s.db,
          code: c.code,
          taskId: c.taskId,
          bgId: c.bgId,
          sid: c.sid,
          call: c.call,
          elapsed: t - c.at,
          now: t,
          claim() {
            if (claimed.has(c.taskId)) return;
            claimTask(s.db, c.code, c.sid);
            claimed.add(c.taskId);
          },
          done: () => setDone(s.db, c.taskId),
        });
        c.call++;
        const extra = h.extraAgents?.() ?? [];
        if (row === null) return extra;
        return [
          {
            id: c.bgId,
            ...(h.hideSessionId ? {} : { sessionId: c.sid }),
            name: `${c.code} runner`,
            ...row,
          },
          ...extra,
        ];
      },
      stopBg(id) {
        stops.push({ id, at: t });
      },
    },
    git: { status: () => git.status, branch: () => git.branch },
    now: () => t,
    async sleep(ms) {
      t += ms;
      if (++sleeps > (h.maxSleeps ?? 3000)) throw new Error(`HANG: still polling after ${sleeps} sleeps`);
    },
    notify(title, message) {
      notifies.push({ title, message, at: t });
    },
    out(line) {
      out.push(line);
    },
    metrics: () => null,
  };
  return { deps, spawns, stops, notifies, out, git, start, trustAsked, now: () => t };
}

const working = { state: "working" } as const;
const idle = { state: "done", status: "idle" } as const;
const question = { state: "blocked", status: "waiting", waitingFor: "input needed" } as const;

// ------------------------------------------------- 1: stops with nothing spawned

describe("stops before anything is spawned (behaviour 1)", () => {
  it("all_done: exits 0, spawns nothing", async () => {
    const s = seed(1);
    setDone(s.db, s.tasks[0].id);
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.exitCode).toBe(0);
    expect(h.spawns).toHaveLength(0);
  });

  it("all_blocked: exits 1 with the blocked codes, spawns nothing", async () => {
    const s = seed(1, {
      beforePlan(db, project, tasks) {
        const other = createRelease(db, { project_id: project.id, version: "0.2" });
        const dep = createTask(db, noopEstimator, {
          project_id: project.id,
          release_id: other.id,
          title: "outside dependency",
          complexity_hint: "normal",
        }).task;
        addDependency(db, tasks[0].id, dep.id);
      },
    });
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_blocked");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toContain(s.codes[0]);
    expect(h.spawns).toHaveLength(0);
  });

  it("a draft plan is refused before the loop, nothing spawned", async () => {
    const s = seed(1, { approve: false });
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toMatch(/plan of 0\.1 is draft/);
    expect(h.spawns).toHaveLength(0);
  });

  it("a plan that drifts mid-batch stops with plan_not_approved, no next spawn", async () => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      if (c.call < 2) return working;
      // Someone adds an unplanned task to the batch while this one finishes.
      if (c.call === 2) {
        createTask(c.db, noopEstimator, {
          project_id: s.project.id,
          release_id: s.tasks[0].release_id!,
          title: "unplanned",
          complexity_hint: "normal",
        });
      }
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("plan_not_approved");
    // Adding a task reverts the plan to draft in the domain; either way the
    // runner reports the plan, not a hand-out.
    expect(res.detail).toMatch(/^plan (draft|drifted)$/);
    expect(h.spawns.map((x) => x.code)).toEqual([s.codes[0]]);
  });

  it("doc_drift on the hand-out releases the task back to pending, nothing spawned", async () => {
    const s = seed(1, { designDoc: true });
    writeFileSync(path.join(s.dir, "design.md"), "# design v2, changed\n");
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("doc_drift");
    expect(res.exitCode).toBe(1);
    expect(h.spawns).toHaveLength(0);
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "pending", owner_session_id: null });
  });

  it("spawn failure releases the task back to pending (spawn_failed)", async () => {
    const s = seed(1);
    const h = harness(s, () => working, { spawnThrows: true });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("spawn_failed");
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "pending", owner_session_id: null });
  });
});

// ------------------------------------------- 2: the session claims its own task

describe("the session claims its own task (behaviour 2)", () => {
  it("the hand-out leaves owner NULL and the session's claim under its uuid succeeds", async () => {
    const s = seed(1);
    const seen: { before?: ReturnType<typeof taskRow>; claimError?: unknown; after?: ReturnType<typeof taskRow> } = {};
    const h = harness(s, (c) => {
      if (c.call === 0) {
        seen.before = taskRow(c.db, c.taskId);
        try {
          c.claim();
        } catch (error) {
          seen.claimError = error;
        }
        seen.after = taskRow(c.db, c.taskId);
        return working;
      }
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(seen.before).toMatchObject({ status: "in_progress", owner_session_id: null });
    expect(seen.claimError).toBeUndefined();
    expect(seen.after).toMatchObject({ status: "in_progress", owner_session_id: "sid-1" });
    expect(res.cause).toBe("all_done");
    expect(h.spawns[0].args[0]).toContain(`claim_task(${s.codes[0]}, session_id = $CLAUDE_CODE_SESSION_ID)`);
    expect(h.spawns[0].cwd).toBe(s.dir);
  });
});

// ------------------------------------------------- 3: an owner question waits

describe("an owner question is not a stop (behaviour 3)", () => {
  it("notifies once, renews the lease every poll, and blocked time never reaches the timeout", async () => {
    const s = seed(1);
    const leases: { claim?: string; lastBlocked?: string } = {};
    const h = harness(s, (c) => {
      c.claim();
      if (c.call === 0) leases.claim = taskRow(c.db, c.taskId).lock_expires_at!;
      if (c.elapsed < 10 * MIN) return working;
      if (c.elapsed < 190 * MIN) {
        leases.lastBlocked = taskRow(c.db, c.taskId).lock_expires_at!;
        return question;
      }
      c.done();
      return idle;
    });
    // 3 h blocked against a 1 h working-time cap.
    const res = await runBatch(s.db, opts(s, { timeoutMs: 60 * MIN }), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual([s.codes[0]]);
    const asks = h.notifies.filter((x) => x.title === `${s.codes[0]} needs you`);
    expect(asks).toHaveLength(1);
    expect(asks[0].message).toContain("claude attach bg1");
    // Read just before the poll that renews it: the previous poll's renewal,
    // ~3 h after the claim's 30-minute lease would have lapsed.
    expect(Date.parse(leases.lastBlocked!) - Date.parse(leases.claim!)).toBeGreaterThan(150 * MIN);
    expect(h.stops.map((x) => x.id)).toEqual(["bg1"]);
  });

  it("a permission prompt (status waiting, no waitingFor) is treated as a question", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      if (c.elapsed < 120 * MIN) return { state: "blocked", status: "waiting" };
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s, { timeoutMs: 30 * MIN, graceMs: 15 * MIN }), h.deps);
    expect(res.cause).toBe("all_done");
    expect(h.notifies.filter((x) => /needs you/.test(x.title))).toHaveLength(1);
    expect(h.notifies.filter((x) => /without finishing/.test(x.title))).toHaveLength(0);
  });

  it("notifies once per blocked episode", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      const m = c.elapsed / MIN;
      if (m < 5) return working;
      if (m < 10) return question;
      if (m < 15) return working;
      if (m < 20) return question;
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(h.notifies.filter((x) => /needs you/.test(x.title))).toHaveLength(2);
  });

  it("working time around a block still counts toward the timeout", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      if (c.elapsed >= 20 * MIN && c.elapsed < 140 * MIN) return question;
      return working;
    });
    const res = await runBatch(s.db, opts(s, { timeoutMs: 30 * MIN }), h.deps);
    expect(res.cause).toBe("timeout");
    // 20 min working + 120 min blocked + >10 min working.
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].at - h.spawns[0].at).toBeGreaterThan(150 * MIN);
  });
});

// ------------------------------------------------ 4: done advances to the next

describe("a done task advances (behaviour 4)", () => {
  it("done + idle session: stopBg, next task spawned, batch done; logs written", async () => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      if (c.call < 3) return working;
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual(s.codes);
    expect(h.spawns.map((x) => x.code)).toEqual(s.codes);
    expect(h.stops.map((x) => x.id)).toEqual(["bg1", "bg2"]);
    // Logs: <runsDir>/<PREFIX>-<version>-<stamp>/runner.log + summary.md.
    expect(path.dirname(res.logDir!)).toBe(s.runsDir);
    expect(path.basename(res.logDir!)).toMatch(new RegExp(`^${s.project.code_prefix}-0\\.1-`));
    expect(readdirSync(res.logDir!).sort()).toEqual(["runner.log", "summary.md"]);
    const summary = readFileSync(path.join(res.logDir!, "summary.md"), "utf8");
    expect(summary).toContain(`## ${s.codes[0]}: done`);
    expect(summary).toContain(`## ${s.codes[1]}: done`);
  });

  it("done + session already gone: no stopBg for it, next task spawned", async () => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      if (c.call < 3) return working;
      c.done();
      return c.bgId === "bg1" ? null : { state: "failed" };
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual(s.codes);
    expect(h.stops).toHaveLength(0);
  });
});

// -------------------------------------- 5 / 20: ended without finishing

describe("idle with the task not done (behaviours 5, 20)", () => {
  it("stops after the grace with a note under the session uuid, notifies once, leaves the session alive", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      return c.elapsed < 5 * MIN ? working : idle;
    });
    const before = h.now();
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("ended_without_finishing");
    expect(res.exitCode).toBe(1);
    expect(res.sessionId).toBe("sid-1");
    expect(h.now() - before).toBeGreaterThanOrEqual(5 * MIN + 15 * MIN);
    const ended = h.notifies.filter((x) => /stopped without finishing/.test(x.title));
    expect(ended).toHaveLength(1);
    expect(h.notifies).toHaveLength(1);
    expect(h.stops).toHaveLength(0);
    const notes = listHandoffNotes(s.db, s.tasks[0].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].session_id).toBe("sid-1");
    expect(notes[0].remaining_work).toContain("ended_without_finishing");
    // Claimed by the session: stays with it for --resume.
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "in_progress", owner_session_id: "sid-1" });
  });

  it("a bare state blocked with the task not done ends after the grace, not an endless wait", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      return c.call < 2 ? working : { state: "blocked" };
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("ended_without_finishing");
    expect(h.notifies.filter((x) => /stopped without finishing/.test(x.title))).toHaveLength(1);
    expect(h.notifies.filter((x) => /needs you/.test(x.title))).toHaveLength(0);
  });

  it("without a known session uuid the note falls back to task-tracker-run:<bgId>", async () => {
    const s = seed(1);
    const h = harness(
      s,
      (c) => {
        if (c.call === 0) claimTask(c.db, c.code, "uuid-the-runner-never-saw");
        return c.call < 2 ? working : idle;
      },
      { hideSessionId: true },
    );
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("ended_without_finishing");
    const notes = listHandoffNotes(s.db, s.tasks[0].id);
    expect(notes.map((x) => x.session_id)).toEqual(["task-tracker-run:bg1"]);
  });
});

// -------------------------------------------------- 6: crash / missing session

describe("a dead or missing session stops the batch (behaviour 6)", () => {
  it.each([
    ["failed", { state: "failed" }, /session failed/],
    ["stopped", { state: "stopped" }, /session stopped/],
    ["missing", null, /session missing/],
  ] as const)("%s: session_failed with a note naming the cause", async (_label, row, cause) => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      return c.call < 2 ? working : row;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("session_failed");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toMatch(cause);
    expect(h.spawns).toHaveLength(1);
    const notes = listHandoffNotes(s.db, s.tasks[0].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].session_id).toBe("sid-1");
    expect(notes[0].remaining_work).toMatch(cause);
    // Claimed: not released (behaviour 21's other half).
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "in_progress", owner_session_id: "sid-1" });
    expect(notes[0].remaining_work).toContain(`--resume ${s.codes[0]}`);
  });
});

// ------------------------------------------------------------- 7: timeout

describe("working-time timeout (behaviour 7)", () => {
  it("stops the session once working time passes the cap, with a note", async () => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      return working;
    });
    const res = await runBatch(s.db, opts(s, { timeoutMs: 20 * MIN }), h.deps);
    expect(res.cause).toBe("timeout");
    expect(res.exitCode).toBe(1);
    expect(h.stops.map((x) => x.id)).toEqual(["bg1"]);
    expect(h.stops[0].at - h.spawns[0].at).toBeGreaterThan(20 * MIN);
    expect(h.spawns).toHaveLength(1);
    expect(listHandoffNotes(s.db, s.tasks[0].id)[0].remaining_work).toContain("timeout");
  });
});

// ------------------------------------------------- 8: git state after done

describe("git state after a done task (behaviour 8)", () => {
  it.each([
    ["dirty tree", (g: { status: string; branch: string }): void => {
      g.status = " M src/x.ts";
    }, /not clean/],
    ["wrong branch", (g: { status: string; branch: string }): void => {
      g.branch = "feat/TTM-1";
    }, /on feat\/TTM-1, not release-0\.1/],
  ] as const)("%s: git_state, no next spawn", async (_label, spoil, detail) => {
    const s = seed(2);
    let h: ReturnType<typeof harness>;
    h = harness(s, (c): Partial<AgentEntry> | null => {
      c.claim();
      if (c.call < 2) return working;
      c.done();
      spoil(h.git);
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("git_state");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toMatch(detail);
    expect(res.completed).toEqual([s.codes[0]]);
    expect(h.spawns).toHaveLength(1);
  });
});

// ----------------------------------------------- 9 / 23: preflight and --resume

describe("preflight (behaviours 9, 23)", () => {
  it("refuses an in_progress batch task without --resume", async () => {
    const s = seed(2);
    claimTask(s.db, s.codes[0], "someone-else");
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.detail).toContain(`in_progress in the batch: ${s.codes[0]}`);
    expect(res.detail).toContain("--resume");
    expect(h.spawns).toHaveLength(0);
  });

  it("with --resume CODE only that task may be in_progress", async () => {
    const s = seed(2);
    claimTask(s.db, s.codes[0], "sid-old");
    claimTask(s.db, s.codes[1], "someone-else");
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { resume: s.codes[0] }), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.detail).toMatch(new RegExp(`in_progress in the batch: ${s.codes[1]}$`));
  });

  it("--resume accepts a lowercase code and re-attaches to the newest '<CODE> runner' session", async () => {
    const s = seed(1);
    claimTask(s.db, s.codes[0], "sid-old");
    let calls = 0;
    const h = harness(s, () => working, {
      agents: () => {
        calls++;
        if (calls > 3) setDone(s.db, s.tasks[0].id);
        return [
          { id: "old00001", sessionId: "sid-older", name: `${s.codes[0]} runner`, startedAt: 1, state: "failed" },
          {
            id: "new00002",
            sessionId: "sid-old",
            name: `${s.codes[0]} runner`,
            startedAt: 2,
            ...(calls > 3 ? idle : working),
          },
          { id: "zzz00003", sessionId: "sid-x", name: "TTM-999 runner", startedAt: 3, state: "working" },
        ];
      },
    });
    const res = await runBatch(s.db, opts(s, { resume: s.codes[0].toLowerCase() }), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual([s.codes[0]]);
    expect(h.spawns).toHaveLength(0);
    expect(h.stops.map((x) => x.id)).toEqual(["new00002"]);
  });

  it("--resume refuses a task of another release", async () => {
    const s = seed(1);
    const r2 = createRelease(s.db, { project_id: s.project.id, version: "0.2" });
    const other = createTask(s.db, noopEstimator, {
      project_id: s.project.id,
      release_id: r2.id,
      title: "elsewhere",
      complexity_hint: "normal",
    }).task;
    const oc = taskCode(s.project.code_prefix, other.task_number);
    claimTask(s.db, oc, "sid-x");
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { resume: oc }), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.detail).toContain(`--resume ${oc}: ${oc} is not in release 0.1`);
    expect(h.spawns).toHaveLength(0);
    expect(h.stops).toHaveLength(0);
  });

  it("--resume refuses a task that is not in_progress", async () => {
    const s = seed(1);
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { resume: s.codes[0] }), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.detail).toContain(`--resume ${s.codes[0]}: ${s.codes[0]} is pending, not in_progress`);
  });

  it("--resume refuses an unknown task", async () => {
    const s = seed(1);
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { resume: "NOPE-999" }), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.detail).toContain("--resume NOPE-999: ");
  });
});

// ------------------------------------------------------ 10: permissions

describe("--bg arguments (behaviour 10)", () => {
  const prompt = buildPrompt("TTM-1", "a task", "0.1", "TTM");

  it("never carry --permission-prompts or skip-permissions, always the whole deny list, prompt first", () => {
    for (const model of [undefined, "opus"]) {
      const args = buildBgArgs(prompt, "TTM-1", model);
      expect(args[0]).toBe(prompt);
      expect(args.some((a) => /^--(permission-prompts|dangerously-skip-permissions|allow-dangerously-skip-permissions)/.test(a))).toBe(false);
      const at = args.indexOf("--disallowedTools");
      expect(at).toBeGreaterThan(0);
      expect(args.slice(at + 1)).toEqual([...DENY_LIST]);
      expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
        "--permission-mode",
        "auto",
      ]);
      expect(args[args.indexOf("-n") + 1]).toBe("TTM-1 runner");
    }
    expect(DENY_LIST).toContain("Bash(git push*)");
    expect(DENY_LIST).toContain("mcp__task-tracker__delete_task");
  });

  it.each([
    ["--permission-prompts none", ["--permission-prompts", "none"]],
    ["--permission-prompts=none", ["--permission-prompts=none"]],
    ["--dangerously-skip-permissions", ["--dangerously-skip-permissions"]],
  ])("assertSafeArgs refuses %s", (_label, extra) => {
    const args = [...buildBgArgs(prompt, "TTM-1")];
    args.splice(1, 0, ...extra);
    expect(() => assertSafeArgs(args)).toThrow(/refusing/);
  });

  it("assertSafeArgs refuses an incomplete deny list", () => {
    const args = buildBgArgs(prompt, "TTM-1").filter((a) => a !== "Bash(git push*)");
    expect(() => assertSafeArgs(args)).toThrow(/deny list incomplete/);
  });

  it("the args a run actually spawns with pass the same checks", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      c.done();
      return idle;
    });
    await runBatch(s.db, opts(s), h.deps);
    const args = h.spawns[0].args;
    expect(args.some((a) => a.startsWith("--permission-prompts") || a.includes("skip-permissions"))).toBe(false);
    expect(args.slice(args.indexOf("--disallowedTools") + 1)).toEqual([...DENY_LIST]);
  });
});

// ------------------------------------------------------- 18: all_held

describe("all_held and the no-task details (behaviour 18)", () => {
  it("another session holding the rest of the batch stops with all_held, listing code, owner, lease end", async () => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      if (c.call < 2) return working;
      c.done();
      claimTask(c.db, s.codes[1], "other-worker");
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_held");
    expect(res.exitCode).toBe(1);
    const lease = taskRow(s.db, s.tasks[1].id).lock_expires_at!;
    expect(res.detail).toContain(`${s.codes[1]} (owner other-worker, lease until ${lease})`);
    expect(res.completed).toEqual([s.codes[0]]);
    expect(h.spawns).toHaveLength(1);
  });

  it("--dry-run reports the same all_held detail", async () => {
    const s = seed(1);
    claimTask(s.db, s.codes[0], "other-worker");
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { dryRun: true }), h.deps);
    expect(res.cause).toBe("dry_run");
    const lease = taskRow(s.db, s.tasks[0].id).lock_expires_at!;
    expect(h.out).toContain(
      `next: none (all_held: held by other sessions: ${s.codes[0]} (owner other-worker, lease until ${lease}))`,
    );
  });

  it("all_blocked lists the blocked codes and appends the held ones", async () => {
    const s = seed(2, {
      beforePlan(db, project, tasks) {
        const other = createRelease(db, { project_id: project.id, version: "0.2" });
        const dep = createTask(db, noopEstimator, {
          project_id: project.id,
          release_id: other.id,
          title: "outside dependency",
          complexity_hint: "normal",
        }).task;
        addDependency(db, tasks[1].id, dep.id);
      },
    });
    claimTask(s.db, s.codes[0], "other-worker");
    const h = harness(s, () => working);
    await runBatch(s.db, opts(s, { dryRun: true }), h.deps);
    const next = h.out.find((l) => l.startsWith("next: "));
    expect(next).toMatch(new RegExp(`^next: none \\(all_blocked: blocked: ${s.codes[1]}; held: ${s.codes[0]} \\(owner other-worker`));
  });

  it("--dry-run spawns nothing and writes nothing", async () => {
    const s = seed(2);
    const before = s.tasks.map((t) => taskRow(s.db, t.id));
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { dryRun: true }), h.deps);
    expect(res.cause).toBe("dry_run");
    expect(h.spawns).toHaveLength(0);
    expect(s.tasks.map((t) => taskRow(s.db, t.id))).toEqual(before);
    expect(readdirSync(s.runsDir)).toEqual([]);
    expect(h.out.some((l) => l.startsWith(`next: ${s.codes[0]} `))).toBe(true);
  });
});

// ----------------------------------------------------- 19 / 22: DB-first done

describe("the DB decides done, before the session state (behaviours 19, 22)", () => {
  it.each([
    ["bare blocked", { state: "blocked" }],
    ["explicit question", question],
    ["permission prompt", { state: "blocked", waitingFor: "permission prompt" }],
  ] as const)("done + %s: done on that poll, stopBg, no notification", async (_label, row) => {
    const s = seed(1);
    let doneAt = 0;
    const h = harness(s, (c) => {
      c.claim();
      if (c.call < 2) return working;
      if (doneAt === 0) doneAt = c.now;
      c.done();
      return row;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual([s.codes[0]]);
    expect(h.notifies).toHaveLength(0);
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].at).toBe(doneAt);
  });

  it("done + still working: waits up to the grace, then stopBg and done, never timeout", async () => {
    const s = seed(1);
    let doneAt = 0;
    const h = harness(s, (c) => {
      c.claim();
      if (c.elapsed < 5 * MIN) return working;
      if (doneAt === 0) doneAt = c.now;
      c.done();
      return working;
    });
    // The grace runs past the working-time cap: done still wins.
    const res = await runBatch(s.db, opts(s, { timeoutMs: 10 * MIN, graceMs: 15 * MIN }), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual([s.codes[0]]);
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].at - doneAt).toBeGreaterThanOrEqual(15 * MIN);
    expect(h.notifies).toHaveLength(0);
  });

  it("done + working that then goes idle inside the grace advances at that poll", async () => {
    const s = seed(1);
    let doneAt = 0;
    const h = harness(s, (c) => {
      c.claim();
      if (c.elapsed < 5 * MIN) return working;
      if (doneAt === 0) doneAt = c.now;
      c.done();
      return c.elapsed < 8 * MIN ? working : idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].at - doneAt).toBeGreaterThanOrEqual(3 * MIN);
    expect(h.stops[0].at - doneAt).toBeLessThan(15 * MIN);
  });

  it("a task done on the poll where working time first passes the cap is done, not timeout", async () => {
    const s = seed(1);
    const timeoutMs = 10 * MIN;
    const h = harness(s, (c) => {
      c.claim();
      if (c.elapsed <= timeoutMs) return working;
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s, { timeoutMs }), h.deps);
    expect(res.cause).toBe("all_done");
    expect(res.completed).toEqual([s.codes[0]]);
  });
});

// ----------------------------------------------- 21: release when never claimed

describe("a stop before the session claimed releases the task (behaviour 21)", () => {
  function expectReleased(s: Seed): void {
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "pending", owner_session_id: null });
    const notes = listHandoffNotes(s.db, s.tasks[0].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].remaining_work).toMatch(/never claimed/);
    expect(notes[0].remaining_work).toMatch(/released it back to pending/);
  }

  it("session missing from the start: session_failed, task back to pending with a note", async () => {
    const s = seed(1);
    const h = harness(s, () => null);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("session_failed");
    expectReleased(s);
  });

  it("idle without ever claiming: ended_without_finishing, task back to pending", async () => {
    const s = seed(1);
    const h = harness(s, () => idle);
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("ended_without_finishing");
    expectReleased(s);
  });

  it("timeout without ever claiming: task back to pending", async () => {
    const s = seed(1);
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { timeoutMs: 10 * MIN }), h.deps);
    expect(res.cause).toBe("timeout");
    expectReleased(s);
  });

  it("a task cancelled while watched stays cancelled (task_cancelled), session stopped", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      if (c.call === 2) cancelTask(c.db, { task_id: c.taskId, reason: "owner changed their mind" });
      return working;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("task_cancelled");
    expect(taskRow(s.db, s.tasks[0].id).status).toBe("cancelled");
    expect(h.stops.map((x) => x.id)).toEqual(["bg1"]);
  });

  it("--resume with no session and an unclaimed hand-out releases it with a note", async () => {
    const s = seed(1);
    const handed = getNextTask(s.db, s.project.id, s.tasks[0].release_id!);
    expect(handed.task?.id).toBe(s.tasks[0].id);
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "in_progress", owner_session_id: null });
    const h = harness(s, () => working, { agents: () => [] });
    const res = await runBatch(s.db, opts(s, { resume: s.codes[0] }), h.deps);
    expect(res.cause).toBe("session_failed");
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "pending", owner_session_id: null });
    const notes = listHandoffNotes(s.db, s.tasks[0].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].remaining_work).toMatch(/no session ever claimed .*released back to pending/);
  });
});

// ------------------------------------------------------------ 16: options

describe("parseDuration / parseArgs (behaviour 16)", () => {
  it.each([
    ["4h", 4 * 60 * MIN],
    ["15m", 15 * MIN],
    ["30s", 30_000],
    ["500ms", 500],
    ["45", 45_000],
  ])("parseDuration(%s)", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it("parseDuration rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow(/bad duration/);
  });

  it("defaults: 4 h timeout, 30 s poll, 15 min grace", () => {
    const o = parseArgs(["Demo", "0.1"]);
    expect(o).toMatchObject({ project: "Demo", release: "0.1", dryRun: false });
    expect([o.timeoutMs, o.pollMs, o.graceMs]).toEqual([DEFAULTS.timeoutMs, DEFAULTS.pollMs, DEFAULTS.graceMs]);
    expect(DEFAULTS).toEqual({ timeoutMs: 4 * 60 * MIN, pollMs: 30_000, graceMs: 15 * MIN });
  });

  it("parses --resume, --timeout, --dry-run", () => {
    const o = parseArgs(["Demo", "0.1", "--resume", "ttm-7", "--timeout", "2h", "--dry-run"]);
    expect(o).toMatchObject({ resume: "ttm-7", timeoutMs: 2 * 60 * MIN, dryRun: true });
  });
});

// ------------------------------------------- TTM-104: a reclaimed hand-out

/**
 * TTM-104 (docs/design/TTM-104-runner-hardening.md, "Behaviours the tests
 * must pin" 1-6, owner decisions 1-2). A reclaim needs an in_progress task
 * under a lapsed lease and no pending work, and preflight refuses an
 * in_progress batch task, so the lease lapses mid-batch: while the first
 * task runs, the second is held under a lease already in the past.
 */
describe("a reclaimed hand-out stops the runner (TTM-104 behaviours 1-6)", () => {
  const LAPSED = "2000-01-01T00:00:00.000Z";

  /** Task 1 in_progress under `owner` with a lapsed lease, set on the first poll of task 0. */
  function reclaimScenario(s: Seed, owner: string | null): Scenario {
    return (c) => {
      c.claim();
      if (c.call === 0) {
        if (owner !== null) claimTask(c.db, s.codes[1], owner);
        c.db
          .prepare("UPDATE tasks SET status = 'in_progress', owner_session_id = ?, lock_expires_at = ? WHERE id = ?")
          .run(owner, LAPSED, s.tasks[1].id);
        return working;
      }
      c.done();
      return idle;
    };
  }

  function lastActivity(detail: string): string {
    const m = /last activity (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\)/.exec(detail);
    expect(m).not.toBeNull();
    return m![1];
  }

  function expectReleasedWithNote(s: Seed, res: Awaited<ReturnType<typeof runBatch>>): void {
    expect(taskRow(s.db, s.tasks[1].id)).toMatchObject({ status: "pending", owner_session_id: null });
    const notes = listHandoffNotes(s.db, s.tasks[1].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].session_id).toBe("task-tracker-run");
    expect(notes[0].remaining_work).toBe(`Batch runner stopped: task_reclaimed. ${res.detail}`);
    expect(notes[0].discoveries).toBe(`runner log: ${res.logDir}`);
  }

  it("previous holder listed: no spawn, task_reclaimed exit 1, released with a note naming owner, lease, activity and the holder; claude attach printed", async () => {
    const s = seed(2);
    const holder: AgentEntry = {
      id: "abcd1234",
      sessionId: "other-worker",
      kind: "background",
      state: "working",
      cwd: "/work/elsewhere",
    };
    const h = harness(s, reclaimScenario(s, "other-worker"), { extraAgents: () => [holder] });
    const res = await runBatch(s.db, opts(s), h.deps);

    expect(res.cause).toBe("task_reclaimed");
    expect(res.exitCode).toBe(1);
    expect(res.task).toBe(s.codes[1]);
    expect(res.completed).toEqual([s.codes[0]]);
    expect(h.spawns.map((x) => x.code)).toEqual([s.codes[0]]);
    expect(res.detail).toBe(
      `${s.codes[1]} was handed out again after a lapsed lease (previous owner other-worker, ` +
        `lease until ${LAPSED}, last activity ${lastActivity(res.detail)}). ` +
        "previous holder other-worker: background working in /work/elsewhere. " +
        "Released back to pending; confirm the previous holder is gone, then re-run.",
    );
    expectReleasedWithNote(s, res);
    expect(h.out).toContain(`[${s.codes[1]}] previous holder is still listed: claude attach abcd1234`);
    expect(readFileSync(path.join(res.logDir!, "runner.log"), "utf8")).toContain(`stop task_reclaimed: ${res.detail}`);
    expect(readFileSync(path.join(res.logDir!, "summary.md"), "utf8")).toContain(res.detail);
  });

  it("the holder's state falls back to its status when state is absent", async () => {
    const s = seed(2);
    const holder: AgentEntry = { id: "abcd1234", sessionId: "other-worker", kind: "interactive", status: "idle", cwd: "/w" };
    const h = harness(s, reclaimScenario(s, "other-worker"), { extraAgents: () => [holder] });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.detail).toContain("previous holder other-worker: interactive idle in /w.");
  });

  it("previous holder not listed: the note says so, no claude attach line", async () => {
    const s = seed(2);
    const h = harness(s, reclaimScenario(s, "other-worker"));
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("task_reclaimed");
    expect(res.detail).toContain("previous holder other-worker: not listed on this machine.");
    expectReleasedWithNote(s, res);
    expect(h.out.some((l) => l.includes("previous holder is still listed"))).toBe(false);
  });

  it("a listed holder row without an id (interactive) prints no claude attach line", async () => {
    const s = seed(2);
    const holder: AgentEntry = { sessionId: "other-worker", kind: "interactive", state: "working", cwd: "/w" };
    const h = harness(s, reclaimScenario(s, "other-worker"), { extraAgents: () => [holder] });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.detail).toContain("previous holder other-worker: interactive working in /w.");
    expect(h.out.some((l) => l.includes("previous holder is still listed"))).toBe(false);
  });

  it("no previous owner: 'no owner (unclaimed hand-out)', and claude agents is not asked", async () => {
    const s = seed(2);
    let lookups = 0;
    const h = harness(s, reclaimScenario(s, null), {
      extraAgents: () => {
        // Task 0's session is stopped once it is done; any call after that is the reclaim lookup.
        if (h.stops.length > 0) lookups++;
        return [];
      },
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("task_reclaimed");
    expect(res.detail).toContain("(previous owner none, ");
    expect(res.detail).toContain("no owner (unclaimed hand-out).");
    expect(lookups).toBe(0);
    expectReleasedWithNote(s, res);
  });

  it("a claude agents failure still stops cleanly; the task is already released while the lookup runs", async () => {
    const s = seed(2);
    let duringLookup: ReturnType<typeof taskRow> | undefined;
    const h = harness(s, reclaimScenario(s, "other-worker"), {
      extraAgents: () => {
        if (h.stops.length === 0) return [];
        duringLookup = taskRow(s.db, s.tasks[1].id);
        throw new Error("agents exploded\nsecond line of the error");
      },
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("task_reclaimed");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toContain("previous holder other-worker: claude agents lookup failed (agents exploded).");
    expect(duringLookup).toMatchObject({ status: "pending", owner_session_id: null });
    expect(h.spawns).toHaveLength(1);
    expectReleasedWithNote(s, res);
  });

  it("a plain pending hand-out (no reclaimed_from) still spawns", async () => {
    const s = seed(2);
    const h = harness(s, (c) => {
      c.claim();
      if (c.call === 0) return working;
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(h.spawns.map((x) => x.code)).toEqual(s.codes);
    expect(s.tasks.flatMap((t) => listHandoffNotes(s.db, t.id))).toEqual([]);
  });

  it("--dry-run prints the reclaim marker and leaves the DB unchanged", async () => {
    const s = seed(1);
    claimTask(s.db, s.codes[0], "other-worker");
    s.db.prepare("UPDATE tasks SET lock_expires_at = ? WHERE id = ?").run(LAPSED, s.tasks[0].id);
    const before = taskRow(s.db, s.tasks[0].id);
    const h = harness(s, () => working);
    const res = await runBatch(s.db, opts(s, { dryRun: true }), h.deps);
    expect(res.cause).toBe("dry_run");
    expect(h.spawns).toHaveLength(0);
    const next = h.out.find((l) => l.startsWith("next: "));
    expect(next).toMatch(new RegExp(`^next: ${s.codes[0]} "task 0" \\(plan \\S+, doc_drift false, reclaimed from other-worker\\)$`));
    expect(taskRow(s.db, s.tasks[0].id)).toEqual(before);
    expect(listHandoffNotes(s.db, s.tasks[0].id)).toEqual([]);
    expect(readdirSync(s.runsDir)).toEqual([]);
  });
});

// ------------------------------- TTM-104: no owner ping on a run about to stop

describe("the owner is notified only after the cancelled/dead checks (TTM-104 behaviours 7-9)", () => {
  it("cancelled task + blocked session on the same poll: no notify, task_cancelled", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      if (c.call < 2) return working;
      if (c.call === 2) cancelTask(c.db, { task_id: c.taskId, reason: "owner changed their mind" });
      return question;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("task_cancelled");
    expect(h.notifies).toEqual([]);
    expect(h.out.some((l) => l.includes("waiting on the owner"))).toBe(false);
  });

  it("dead session whose row still carries waitingFor: no notify, session_failed", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      return c.call < 2 ? working : { state: "failed", waitingFor: "input needed" };
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("session_failed");
    expect(h.notifies).toEqual([]);
  });

  it("blocked, alive, not cancelled: exactly one notify for the episode", async () => {
    const s = seed(1);
    const h = harness(s, (c) => {
      c.claim();
      if (c.elapsed < 30 * MIN) return question;
      c.done();
      return idle;
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(h.notifies.map((x) => x.title)).toEqual([`${s.codes[0]} needs you`]);
  });
});

// ----------------------------------------- TTM-104: the CLI's words on spawn

describe("spawn_failed carries the CLI's full stderr (TTM-104 behaviours 10-12)", () => {
  function runLog(res: Awaited<ReturnType<typeof runBatch>>): string {
    return readFileSync(path.join(res.logDir!, "runner.log"), "utf8");
  }

  it("multi-line stderr: whole in RunResult.detail, the run log, the summary and the note; task released", async () => {
    const s = seed(1);
    const stderr = "Error: could not start\n  at step one\n  at step two";
    const h = harness(s, () => working, {
      spawnError: new SpawnError(`claude --bg failed (exit 2): ${stderr}`, stderr, "", 2),
    });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("spawn_failed");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toBe(`exit 2: ${stderr}`);
    expect(runLog(res)).toContain(`stop spawn_failed: exit 2: ${stderr}`);
    expect(readFileSync(path.join(res.logDir!, "summary.md"), "utf8")).toContain(stderr);
    expect(h.out).toContain(`stopped: spawn_failed - exit 2: ${stderr}`);
    expect(taskRow(s.db, s.tasks[0].id)).toMatchObject({ status: "pending", owner_session_id: null });
    const notes = listHandoffNotes(s.db, s.tasks[0].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].session_id).toBe("task-tracker-run");
    expect(notes[0].remaining_work).toBe(`Batch runner stopped: spawn_failed. exit 2: ${stderr}. Released back to pending.`);
    expect(notes[0].discoveries).toBe(`runner log: ${res.logDir}`);
  });

  it.each([
    ["empty stderr falls back to stdout", new SpawnError("m", "", "only on stdout", 1), "exit 1: only on stdout"],
    ["no exit status prints '-'", new SpawnError("m", "killed\nby signal", "", null), "exit -: killed\nby signal"],
    ["both empty: the SpawnError's own message", new SpawnError("claude --bg failed (exit 3): boom", "", "", 3), "claude --bg failed (exit 3): boom"],
    ["a plain Error: its first line", new Error("first line\nsecond line"), "first line"],
  ] as const)("%s", async (_label, error, detail) => {
    const s = seed(1);
    const h = harness(s, () => working, { spawnError: error });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("spawn_failed");
    expect(res.detail).toBe(detail);
  });

  it("stderr naming an untrusted workspace: the detail leads with the repo and the fix", async () => {
    const s = seed(1);
    const stderr = "Starting session...\nError: Workspace not trusted. Run claude in this directory first.";
    const h = harness(s, () => working, { spawnError: new SpawnError("m", stderr, "", 1) });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.detail).toBe(
      `workspace not trusted: ${s.dir}; run claude there once and accept the trust prompt. exit 1: ${stderr}`,
    );
    expect(listHandoffNotes(s.db, s.tasks[0].id)[0].remaining_work).toContain(`workspace not trusted: ${s.dir};`);
  });

  it("stderr over the cap: console line and note truncated with the marker, detail and run log whole", async () => {
    const s = seed(1);
    const stderr = `${"x".repeat(DETAIL_CAP)}TAIL-${"y".repeat(500)}`;
    const h = harness(s, () => working, { spawnError: new SpawnError("m", stderr, "", 1) });
    const res = await runBatch(s.db, opts(s), h.deps);
    const full = `exit 1: ${stderr}`;
    const capped = `${full.slice(0, DETAIL_CAP)}... (${full.length - DETAIL_CAP} more chars, see run log)`;
    expect(res.detail).toBe(full);
    expect(runLog(res)).toContain(`stop spawn_failed: ${full}`);
    expect(h.out).toContain(`stopped: spawn_failed - ${capped}`);
    expect(h.out.some((l) => l.includes("TAIL-"))).toBe(false);
    expect(listHandoffNotes(s.db, s.tasks[0].id)[0].remaining_work).toBe(
      `Batch runner stopped: spawn_failed. ${capped}. Released back to pending.`,
    );
  });

  it("capDetail keeps text up to the cap and marks what it drops", () => {
    expect(DETAIL_CAP).toBe(4000);
    const at = "a".repeat(DETAIL_CAP);
    expect(capDetail(at)).toBe(at);
    expect(capDetail(`${at}bc`)).toBe(`${at}... (2 more chars, see run log)`);
    expect(capDetail("abcdef", 4)).toBe("abcd... (2 more chars, see run log)");
  });
});

// --------------------------------------- TTM-104: untrusted workspace preflight

describe("preflight checks workspace trust (TTM-104 behaviour 14)", () => {
  it("workspaceTrusted false: preflight fails with the trust line, nothing spawned", async () => {
    const s = seed(1);
    const h = harness(s, () => working, { trusted: false });
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("preflight");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toContain(
      `workspace not trusted: ${s.dir} (run claude there once and accept the trust prompt)`,
    );
    expect(h.trustAsked).toEqual([s.dir]);
    expect(h.spawns).toHaveLength(0);
  });

  it.each([
    ["null (unknown)", null],
    ["true", true],
    ["a throw", "throw"],
  ] as const)("workspaceTrusted %s: no preflight line, the batch runs", async (_label, trusted) => {
    const s = seed(1);
    const h = harness(
      s,
      (c) => {
        c.claim();
        c.done();
        return idle;
      },
      { trusted },
    );
    const res = await runBatch(s.db, opts(s), h.deps);
    expect(res.cause).toBe("all_done");
    expect(h.spawns).toHaveLength(1);
    expect(h.out.some((l) => /trust/i.test(l))).toBe(false);
  });

  it("--dry-run lists the trust failure as a preflight line", async () => {
    const s = seed(1);
    const h = harness(s, () => working, { trusted: false });
    await runBatch(s.db, opts(s, { dryRun: true }), h.deps);
    expect(h.out).toContain(
      `preflight: workspace not trusted: ${s.dir} (run claude there once and accept the trust prompt)`,
    );
  });
});
