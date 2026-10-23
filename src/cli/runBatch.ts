#!/usr/bin/env node
// Batch runner (TTM-95, docs/design/TTM-95-runner.md): works one release batch
// task by task, each task in its own `claude --bg` session that claims the task
// itself. The runner hands out (getNextTask), spawns, then watches
// `claude agents --json` and the DB until the task is done, the session needs
// the owner (notify, keep the lease, pause the clock), or a stop condition
// from the note's table fires.
//
// Everything with a side effect outside the DB - the clock, sleeping, the
// `claude` and `git` processes, the notifier, stdout - comes in through
// `RunnerDeps`, so tests drive the loop without real waiting or real sessions.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDbPath, openDatabase, type DatabaseInstance } from "../db/connection.js";
import { addHandoffNote } from "../domain/handoffNotes.js";
import { releaseTask } from "../domain/lifecycle.js";
import { getPlan } from "../domain/plans.js";
import { requireProject, type Project } from "../domain/projects.js";
import { requireRelease, type Release } from "../domain/releases.js";
import {
  getNextTask,
  getTaskDetail,
  listTasks,
  type GetNextTaskResult,
  type HeldTask,
  type ReclaimedFrom,
} from "../domain/status.js";
import { renewLease } from "../domain/taskStatus.js";
import {
  classifyAgent,
  createClaudeBg,
  SpawnError,
  type AgentEntry,
  type ClaudeBg,
  type SessionState,
} from "./claudeBg.js";

// ---------------------------------------------------------------- options

export interface RunOptions {
  project: string;
  release: string;
  /** Checkout the sessions work in; defaults to the project's root_path. */
  repo?: string;
  /** Re-attach the watch to the session named "<CODE> runner". */
  resume?: string;
  /** Working-time cap per task, blocked-on-owner time excluded. */
  timeoutMs: number;
  pollMs: number;
  /** How long an idle session with an unfinished task and no question may sit. */
  graceMs: number;
  dryRun: boolean;
  model?: string;
  /** Root of the run logs; defaults to `runsRoot()`. */
  runsDir?: string;
}

export const DEFAULTS = {
  timeoutMs: 4 * 60 * 60 * 1000,
  pollMs: 30 * 1000,
  graceMs: 15 * 60 * 1000,
} as const;

/** `<db dir>/runs`, i.e. ~/.task-tracker/runs; `TASK_TRACKER_RUNS_DIR` overrides. */
export function runsRoot(): string {
  return process.env.TASK_TRACKER_RUNS_DIR ?? path.join(path.dirname(defaultDbPath()), "runs");
}

// ------------------------------------------------------------------- deps

export interface GitOps {
  /** `git status --porcelain`; empty means clean. */
  status(repo: string): string;
  /** Current branch name (`git rev-parse --abbrev-ref HEAD`). */
  branch(repo: string): string;
}

export interface RunnerDeps {
  claude: ClaudeBg;
  git: GitOps;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Owner alert; the default fires a macOS notification. */
  notify(title: string, message: string): void;
  out(line: string): void;
  /** `slice_metrics.py --json` over the transcripts; null when unavailable. */
  metrics(transcripts: string[]): string | null;
}

/**
 * The default notifier. `TTM_RUNNER_NOTIFY=off` silences it; any other value
 * is run as a command with (title, message) as its two arguments - tests point
 * it at a recorder so no real notification ever fires.
 */
export function defaultNotify(title: string, message: string): void {
  const override = process.env.TTM_RUNNER_NOTIFY;
  if (override === "off" || override === "none") return;
  try {
    if (override !== undefined && override !== "") {
      execFileSync(override, [title, message], { stdio: "ignore", timeout: 10_000 });
      return;
    }
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    execFileSync("osascript", ["-e", `display notification ${q(message)} with title ${q(title)}`], {
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // A missed notification must not stop the runner; the printed line remains.
  }
}

const SLICE_METRICS = path.join(os.homedir(), ".claude", "skills", "slice-task", "slice_metrics.py");

function defaultMetrics(transcripts: string[]): string | null {
  const present = transcripts.filter((p) => fs.existsSync(p));
  if (present.length === 0 || !fs.existsSync(SLICE_METRICS)) return null;
  try {
    return execFileSync("python3", ["-I", SLICE_METRICS, ...present, "--json"], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function defaultDeps(): RunnerDeps {
  const git = (repo: string, args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    claude: createClaudeBg(),
    git: {
      status: (repo) => git(repo, ["status", "--porcelain"]).trim(),
      branch: (repo) => git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    notify: defaultNotify,
    out: (line) => console.log(line),
    metrics: defaultMetrics,
  };
}

// ------------------------------------------------------- session command

/**
 * Tools the `--bg` session may never use (design note, "Permissions"): no
 * push, no task deletion, and nothing that moves HEAD onto or rewrites
 * main/master. Everything else goes through auto mode, whose asks become
 * permission prompts the owner answers in agent view.
 */
export const DENY_LIST: readonly string[] = [
  "Bash(git push*)",
  "mcp__task-tracker__delete_task",
  "Bash(git checkout main*)",
  "Bash(git checkout master*)",
  "Bash(git switch main*)",
  "Bash(git switch master*)",
  "Bash(git branch -f main*)",
  "Bash(git branch -f master*)",
  "Bash(git branch -D main*)",
  "Bash(git branch -D master*)",
  "Bash(git update-ref refs/heads/main*)",
  "Bash(git update-ref refs/heads/master*)",
];

/** Flags that would remove AskUserQuestion or every permission check. */
const FORBIDDEN_FLAGS = ["--permission-prompts", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"];

/** The session id the runner writes under when no task session exists. */
const RUNNER_SESSION = "task-tracker-run";

export function sessionName(code: string): string {
  return `${code} runner`;
}

export function buildPrompt(code: string, title: string, version: string, prefix: string): string {
  return [
    "Batch runner session: the owner is not watching live, but will answer",
    "AskUserQuestion forms when they come back; ask through the form as usual and",
    `wait. Work exactly one task: ${code} "${title}", release ${version} of project`,
    `${prefix}. First claim_task(${code}, session_id = $CLAUDE_CODE_SESSION_ID).`,
    "Follow ~/.claude/CLAUDE.md and the slice-task skill as the orchestrator: run its",
    `remaining slices with one fresh subagent each, task branch off release-${version},`,
    `merge into release-${version}, set_task_release, complete_task, and leave the`,
    `checkout clean on release-${version}. Do not call get_next_task and do not start`,
    "another task. Never push, never touch main. The approved plan covers commits on",
    "the task branch and the merge. When the task is complete, say DONE and stop.",
  ].join("\n");
}

/**
 * Arguments after `--bg`. The prompt goes first: `--disallowedTools` is
 * variadic and would swallow a positional placed after it.
 */
export function buildBgArgs(prompt: string, code: string, model?: string): string[] {
  const args = [
    prompt,
    "--permission-mode",
    "auto",
    "-n",
    sessionName(code),
    ...(model ? ["--model", model] : []),
    "--disallowedTools",
    ...DENY_LIST,
  ];
  assertSafeArgs(args);
  return args;
}

export function assertSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new Error(`refusing to start a session with ${arg}`);
    }
  }
  const at = args.indexOf("--disallowedTools");
  const denied = at < 0 ? [] : args.slice(at + 1);
  const missing = DENY_LIST.filter((rule) => !denied.includes(rule));
  if (missing.length > 0) throw new Error(`deny list incomplete: ${missing.join(", ")}`);
}

// ------------------------------------------------------------------- logs

export interface RunLog {
  dir: string;
  line(event: string): void;
  summary(markdown: string): void;
}

/** `<root>/<PREFIX>-<version>-<UTC stamp>/`, created on the first write. */
export function createRunLog(root: string, prefix: string, version: string, startMs: number, now: () => number): RunLog {
  const stamp = new Date(startMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dir = path.join(root, `${prefix}-${version}-${stamp}`);
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    line(event) {
      ensure();
      fs.appendFileSync(path.join(dir, "runner.log"), `${new Date(now()).toISOString()}\t${event}\n`);
    },
    summary(markdown) {
      ensure();
      fs.appendFileSync(path.join(dir, "summary.md"), `${markdown}\n`);
    },
  };
}

/** Claude Code's project slug: every non-alphanumeric character becomes `-`. */
export function transcriptPath(repo: string, sessionId: string): string {
  const slug = path.resolve(repo).replace(/[^A-Za-z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

function subagentTranscripts(mainTranscript: string): string[] {
  const dir = path.join(mainTranscript.replace(/\.jsonl$/, ""), "subagents");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- results

export type StopCause =
  | "all_done"
  | "all_blocked"
  | "all_held"
  | "plan_not_approved"
  | "doc_drift"
  | "preflight"
  | "spawn_failed"
  | "session_failed"
  | "ended_without_finishing"
  | "timeout"
  | "task_cancelled"
  | "task_reclaimed"
  | "git_state"
  | "dry_run";

export interface RunResult {
  cause: StopCause;
  exitCode: number;
  detail: string;
  task?: string;
  bgId?: string;
  sessionId?: string;
  logDir?: string;
  /** Codes of the tasks this run saw through to done, in order. */
  completed: string[];
}

// -------------------------------------------------------------- preflight

export interface PreflightContext {
  db: DatabaseInstance;
  project: Project;
  release: Release;
  repo: string;
  resume?: string;
}

/** Each failed check as one line; empty means the batch may start. */
export function preflight(ctx: PreflightContext, deps: RunnerDeps): string[] {
  const failures: string[] = [];
  const { db, project, release, repo } = ctx;
  try {
    deps.claude.version();
  } catch (error) {
    failures.push(`claude --version failed: ${message(error)}`);
  }
  // Best effort over Claude Code's internal config: null (unknown) says
  // nothing; the spawn failure's stderr still names an untrusted workspace.
  let trusted: boolean | null = null;
  try {
    trusted = deps.claude.workspaceTrusted(repo);
  } catch {
    trusted = null;
  }
  if (trusted === false) {
    failures.push(`workspace not trusted: ${repo} (run claude there once and accept the trust prompt)`);
  }
  failures.push(...gitFailures(repo, release, deps));

  const plan = getPlan(db, project.id, release.id);
  if (!plan) {
    failures.push(`release ${release.version} has no plan`);
  } else if (plan.status !== "approved") {
    failures.push(`plan of ${release.version} is ${plan.status}, not approved`);
  } else if (plan.unplanned_task_ids.length > 0 || plan.orphaned_task_ids.length > 0) {
    failures.push(`approved plan of ${release.version} has drifted`);
  }

  // --resume names a task by uuid or code (any case, as everywhere else in
  // the tracker); it must be an in_progress task of this very batch.
  let resumeId: string | undefined;
  if (ctx.resume !== undefined) {
    try {
      const t = getTaskDetail(db, ctx.resume);
      if (t.release_id !== release.id) {
        failures.push(`--resume ${ctx.resume}: ${t.code} is not in release ${release.version}`);
      } else if (t.status !== "in_progress") {
        failures.push(`--resume ${ctx.resume}: ${t.code} is ${t.status}, not in_progress`);
      } else {
        resumeId = t.id;
      }
    } catch (error) {
      failures.push(`--resume ${ctx.resume}: ${message(error)}`);
    }
  }

  const inProgress = listTasks(db, project.id, "in_progress", undefined, release.id);
  const others = inProgress.filter((t) => t.id !== resumeId);
  if (others.length > 0) {
    failures.push(
      `in_progress in the batch: ${others.map((t) => t.code).join(", ")}` +
        (ctx.resume ? "" : " (pass --resume <CODE> to re-attach)"),
    );
  }
  return failures;
}

function gitFailures(repo: string, release: Release, deps: RunnerDeps): string[] {
  const failures: string[] = [];
  const want = `release-${release.version}`;
  try {
    const status = deps.git.status(repo);
    if (status !== "") failures.push(`checkout ${repo} is not clean`);
    const branch = deps.git.branch(repo);
    if (branch !== want) failures.push(`checkout ${repo} is on ${branch}, not ${want}`);
  } catch (error) {
    failures.push(`git in ${repo} failed: ${message(error)}`);
  }
  return failures;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/** Longest detail the console line and a handoff note carry (TTM-104). */
export const DETAIL_CAP = 4000;

/** The first `DETAIL_CAP` chars plus a marker; the run log keeps it whole. */
export function capDetail(text: string, cap = DETAIL_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}... (${text.length - cap} more chars, see run log)`;
}

/**
 * A failed spawn in the CLI's own words: `exit <status>: <full stderr>`
 * (stdout when stderr is empty), named up front when the workspace is not
 * trusted. Uncapped; callers cap it for the console and the note.
 */
export function spawnFailureDetail(error: unknown, repo: string): string {
  if (!(error instanceof SpawnError)) return message(error);
  const said = error.stderr || error.stdout;
  const body = said ? `exit ${error.status ?? "-"}: ${said}` : error.message;
  return /workspace not trusted/i.test(error.stderr)
    ? `workspace not trusted: ${repo}; run claude there once and accept the trust prompt. ${body}`
    : body;
}

// ------------------------------------------------------------------- watch

type WatchOutcome =
  | { kind: "done" }
  | { kind: "stop"; cause: StopCause; detail: string };

interface WatchState {
  sessionId?: string;
  workingMs: number;
  blockedMs: number;
  startMs: number;
}

interface Running {
  db: DatabaseInstance;
  taskId: string;
  code: string;
  bgId: string;
  opts: RunOptions;
  deps: RunnerDeps;
  log: RunLog;
  ws: WatchState;
}

function findAgent(agents: AgentEntry[], bgId: string): AgentEntry | undefined {
  return agents.find((a) => a.id === bgId);
}

/**
 * One task's watch, polled every `pollMs` with no model cost. Each poll's
 * elapsed interval is charged to the state seen on the previous poll, so time
 * spent blocked on the owner never counts toward the timeout.
 */
async function watch(r: Running): Promise<WatchOutcome> {
  const { db, deps, opts, log, ws } = r;
  let last = deps.now();
  let prev: SessionState | null = null;
  let blockedSince: number | null = null;
  let idleSince: number | null = null;
  let idleNotified = false;
  let doneSince: number | null = null;

  for (;;) {
    let agents: AgentEntry[];
    try {
      agents = deps.claude.listAgents();
    } catch (error) {
      return { kind: "stop", cause: "session_failed", detail: `claude agents --json failed: ${message(error)}` };
    }
    const agent = findAgent(agents, r.bgId);
    ws.sessionId ??= agent?.sessionId;
    const state = classifyAgent(agent);
    const task = getTaskDetail(db, r.taskId);
    const now = deps.now();
    const elapsed = now - last;
    last = now;
    if (prev === "blocked") ws.blockedMs += elapsed;
    else if (prev !== null) ws.workingMs += elapsed;

    if (state !== prev) {
      const raw = agent ? ` [state ${agent.state ?? "-"}, status ${agent.status ?? "-"}]` : "";
      log.line(`${r.code} ${r.bgId} state ${prev ?? "-"} -> ${state}${agent?.waitingFor ? ` (${agent.waitingFor})` : ""}${raw}`);
    }

    // The DB is the truth and is read first: a done task always advances,
    // whatever the session reports. A session still writing its last turn
    // (cleanup after complete_task) gets up to the grace period, then is
    // stopped; the git check after done catches anything it left. No timeout
    // and no owner notification apply to a done task.
    if (task.status === "done") {
      if (state === "working") {
        doneSince ??= now;
        if (now - doneSince < opts.graceMs) {
          prev = state;
          await deps.sleep(opts.pollMs);
          continue;
        }
        log.line(`${r.code} done but still working after ${fmtMin(now - doneSince)}; stopping it`);
      } else if (state === "blocked") {
        log.line(`${r.code} done while waiting (${agent?.waitingFor ?? "waiting"}); stopping it`);
      }
      if (state !== "dead") stopQuietly(r);
      return { kind: "done" };
    }

    if (task.status === "cancelled") {
      if (state !== "dead") stopQuietly(r);
      return { kind: "stop", cause: "task_cancelled", detail: `${r.code} was cancelled` };
    } else if (state === "dead") {
      const cause = agent === undefined ? "session missing from claude agents" : `session ${agent.state ?? agent.status}`;
      return { kind: "stop", cause: "session_failed", detail: cause };
    }

    // Blocked-episode bookkeeping: one notification per episode. After the
    // cancelled/dead stops, so a run that is about to stop never pings the
    // owner (TTM-104).
    if (state === "blocked" && blockedSince === null) {
      blockedSince = now;
      const what = agent?.waitingFor ?? "input needed";
      deps.out(`[${r.code}] waiting on the owner (${what}): claude attach ${r.bgId}`);
      deps.notify(`${r.code} needs you`, `${what} - claude attach ${r.bgId}`);
    } else if (state !== "blocked" && blockedSince !== null) {
      log.line(`${r.code} blocked ${Math.round((now - blockedSince) / 1000)}s, answered`);
      blockedSince = null;
    }

    if (state === "blocked") {
      // The lease must not lapse while the owner is away.
      renewLease(db, r.taskId, new Date(now).toISOString());
    }

    if (state === "idle") {
      if (idleSince === null) idleSince = now;
      if (!idleNotified) {
        idleNotified = true;
        deps.out(`[${r.code}] session idle, task not done: claude attach ${r.bgId}`);
        deps.notify(`${r.code} stopped without finishing`, `claude attach ${r.bgId}`);
      }
      if (now - idleSince >= opts.graceMs) {
        return {
          kind: "stop",
          cause: "ended_without_finishing",
          detail: `idle ${Math.round((now - idleSince) / 60000)} min with ${r.code} ${task.status} (session state ${agent?.state ?? "-"})`,
        };
      }
    } else {
      idleSince = null;
      idleNotified = false;
    }

    if (ws.workingMs > opts.timeoutMs) {
      stopQuietly(r);
      return {
        kind: "stop",
        cause: "timeout",
        detail: `working time ${Math.round(ws.workingMs / 60000)} min > ${Math.round(opts.timeoutMs / 60000)} min`,
      };
    }

    prev = state;
    await deps.sleep(opts.pollMs);
  }
}

function stopQuietly(r: Running): void {
  try {
    r.deps.claude.stopBg(r.bgId);
    r.log.line(`${r.code} claude stop ${r.bgId}`);
  } catch (error) {
    r.log.line(`${r.code} claude stop ${r.bgId} failed: ${message(error)}`);
  }
}

/** Waits for the new session to show up in `agents --json` with its uuid. */
async function awaitSession(deps: RunnerDeps, bgId: string, tries = 10, stepMs = 3000): Promise<string | undefined> {
  for (let i = 0; i < tries; i++) {
    try {
      const agent = findAgent(deps.claude.listAgents(), bgId);
      if (agent?.sessionId) return agent.sessionId;
    } catch {
      // Retried; the watch reports a persistent failure.
    }
    await deps.sleep(stepMs);
  }
  return undefined;
}

/** `--resume`: the newest session named "<CODE> runner". */
function findRunnerSession(agents: AgentEntry[], code: string): AgentEntry | undefined {
  return agents
    .filter((a) => a.name === sessionName(code) && a.id !== undefined)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

// -------------------------------------------------------------------- run

/**
 * The read-only peek behind --dry-run: getNextTask marks the task in_progress,
 * so it runs against an in-memory copy of the DB (`serialize()`), never the
 * file. The real DB sees one read.
 */
export function peekNextTask(db: DatabaseInstance, projectId: string, releaseId: string): GetNextTaskResult {
  const image = db.serialize();
  // Header bytes 18/19 = 2 mark a WAL database, which SQLite refuses to open
  // from memory; 1/1 (rollback journal) makes the image openable as is.
  image[18] = 1;
  image[19] = 1;
  const copy = new Database(image);
  try {
    copy.pragma("foreign_keys = ON");
    return getNextTask(copy, projectId, releaseId);
  } finally {
    copy.close();
  }
}

/**
 * A stop before the session claimed its task leaves the runner's hand-out
 * behind: in_progress, owner NULL, a live lease. Nothing can resume that (no
 * session owns it) and preflight refuses the batch over it, so it goes back to
 * pending, as on spawn_failed. A task the session did claim stays with it for
 * --resume. Returns whether the task was released.
 */
function releaseIfUnclaimed(db: DatabaseInstance, taskId: string): boolean {
  const t = getTaskDetail(db, taskId);
  if (t.status !== "in_progress" || t.owner_session_id !== null) return false;
  releaseTask(db, { task_id: taskId, session_id: RUNNER_SESSION });
  return true;
}

function assertNever(value: never): never {
  throw new Error(`unhandled get_next_task answer: ${JSON.stringify(value)}`);
}

function fmtHeld(held: HeldTask[]): string {
  if (held.length === 0) return "-";
  return held
    .map((h) => `${h.code} (owner ${h.owner_session_id ?? "unclaimed hand-out"}, lease until ${h.lock_expires_at ?? "-"})`)
    .join(", ");
}

function codeOf(db: DatabaseInstance, taskId: string): string {
  try {
    return getTaskDetail(db, taskId).code;
  } catch {
    return taskId;
  }
}

type NoTask = Extract<GetNextTaskResult, { task: null }>;

/**
 * The stop for each "nothing to hand out" answer. Exhaustive over `reason`:
 * a reason get_next_task gains later is a compile error here, not a silent
 * fallthrough. `all_held` stops rather than waits: in a sequential runner it
 * means someone else is working the batch, and nothing here can tell a live
 * holder from a forgotten one - the owner decides.
 */
function noTaskStop(
  db: DatabaseInstance,
  next: NoTask,
  doneThisRun: number,
): { cause: StopCause; exitCode: number; detail: string } {
  switch (next.reason) {
    case "all_done":
      return { cause: "all_done", exitCode: 0, detail: `batch done (${doneThisRun} this run)` };
    case "all_blocked": {
      const on = next.blocked_on.map((id) => codeOf(db, id)).join(", ") || "-";
      const held = next.held.length > 0 ? `; held: ${fmtHeld(next.held)}` : "";
      return { cause: "all_blocked", exitCode: 1, detail: `blocked: ${on}${held}` };
    }
    case "all_held":
      return { cause: "all_held", exitCode: 1, detail: `held by other sessions: ${fmtHeld(next.held)}` };
    case "plan_not_approved":
      return { cause: "plan_not_approved", exitCode: 1, detail: `plan ${next.plan_status ?? "-"}` };
    default:
      return assertNever(next);
  }
}

function fmtMin(ms: number): string {
  return `${(ms / 60000).toFixed(1)} min`;
}

/**
 * What `claude agents --json` says about a reclaimed task's previous owner,
 * as one line for the note. Information only: nothing here decides whether
 * the holder is gone (design note TTM-104, option B's false "gone"s).
 */
function describePreviousHolder(deps: RunnerDeps, owner: string | null): { line: string; row?: AgentEntry } {
  if (owner === null) return { line: "no owner (unclaimed hand-out)" };
  let agents: AgentEntry[];
  try {
    agents = deps.claude.listAgents();
  } catch (error) {
    return { line: `previous holder ${owner}: claude agents lookup failed (${message(error)})` };
  }
  const row = agents.find((a) => a.sessionId === owner);
  if (row === undefined) return { line: `previous holder ${owner}: not listed on this machine` };
  return {
    line: `previous holder ${owner}: ${row.kind ?? "-"} ${row.state ?? row.status ?? "-"} in ${row.cwd ?? "-"}`,
    row,
  };
}

/**
 * A hand-out that reclaimed a lapsed lease (TTM-78) may belong to a paused
 * session that comes back: release it, leave a note, stop, so there are never
 * two workers on one task. Returns the stop detail.
 */
function reclaimStop(
  db: DatabaseInstance,
  deps: RunnerDeps,
  taskId: string,
  code: string,
  from: ReclaimedFrom,
  logDir: string,
): string {
  // Release before the agents lookup: the lookup may take up to a minute, and
  // an ownerless in_progress task can be claimed by anyone meanwhile.
  releaseTask(db, { task_id: taskId, session_id: RUNNER_SESSION });
  const holder = describePreviousHolder(deps, from.owner_session_id);
  const detail =
    `${code} was handed out again after a lapsed lease (previous owner ${from.owner_session_id ?? "none"}, ` +
    `lease until ${from.lock_expires_at}, last activity ${from.last_activity_at}). ${holder.line}. ` +
    "Released back to pending; confirm the previous holder is gone, then re-run.";
  addHandoffNote(db, {
    task_id: taskId,
    session_id: RUNNER_SESSION,
    remaining_work: `Batch runner stopped: task_reclaimed. ${capDetail(detail)}`,
    discoveries: `runner log: ${logDir}`,
  });
  if (holder.row?.id) {
    deps.out(`[${code}] previous holder is still listed: claude attach ${holder.row.id}`);
  }
  return detail;
}

export async function runBatch(db: DatabaseInstance, opts: RunOptions, deps: RunnerDeps): Promise<RunResult> {
  const project = requireProject(db, opts.project);
  const release = requireRelease(db, project.id, opts.release);
  const repo = opts.repo ?? project.root_path;
  const completed: string[] = [];
  const failures = preflight({ db, project, release, repo, resume: opts.resume }, deps);

  if (opts.dryRun) {
    for (const f of failures) deps.out(`preflight: ${f}`);
    if (failures.length === 0) deps.out("preflight: ok");
    const peek = peekNextTask(db, project.id, release.id);
    if (peek.task === null) {
      const stop = noTaskStop(db, peek, 0);
      deps.out(`next: none (${stop.cause}: ${stop.detail})`);
    } else {
      const t = peek.task;
      const reclaimed = peek.reclaimed_from ? `, reclaimed from ${peek.reclaimed_from.owner_session_id ?? "none"}` : "";
      deps.out(`next: ${t.code} "${t.title}" (plan ${peek.plan_status ?? "-"}, doc_drift ${peek.doc_drift}${reclaimed})`);
      const args = buildBgArgs(buildPrompt(t.code, t.title, release.version, project.code_prefix), t.code, opts.model);
      deps.out(`would run in ${repo}: ${["claude", "--bg", ...args.map(shellQuote)].join(" ")}`);
    }
    return { cause: "dry_run", exitCode: 0, detail: "dry run, nothing spawned or written", completed };
  }

  const log = createRunLog(opts.runsDir ?? runsRoot(), project.code_prefix, release.version, deps.now(), deps.now);
  const finish = (res: Omit<RunResult, "logDir" | "completed">): RunResult => {
    const full: RunResult = { ...res, logDir: log.dir, completed };
    log.line(`stop ${full.cause}: ${full.detail}`);
    deps.out(`stopped: ${full.cause} - ${capDetail(full.detail)}`);
    if (full.task) deps.out(`  task ${full.task}, session ${full.sessionId ?? "-"}`);
    if (full.bgId) deps.out(`  claude attach ${full.bgId}`);
    deps.out(`  log ${log.dir}`);
    log.summary(`## stop: ${full.cause}\n\n${full.detail}\n`);
    return full;
  };

  if (failures.length > 0) {
    return finish({ cause: "preflight", exitCode: 1, detail: failures.join("; ") });
  }
  log.line(`start ${project.code_prefix} ${release.version} repo ${repo}`);

  let resume = opts.resume;
  for (;;) {
    let taskId: string;
    let code: string;
    let bgId: string;
    const ws: WatchState = { workingMs: 0, blockedMs: 0, startMs: deps.now() };

    if (resume !== undefined) {
      const task = getTaskDetail(db, resume);
      resume = undefined;
      taskId = task.id;
      code = task.code;
      const agent = findRunnerSession(deps.claude.listAgents(), code);
      if (!agent?.id) {
        const detail = `no session named "${sessionName(code)}"`;
        if (releaseIfUnclaimed(db, taskId)) {
          addHandoffNote(db, {
            task_id: taskId,
            session_id: RUNNER_SESSION,
            remaining_work: `Batch runner --resume: ${detail} and no session ever claimed ${code}; released back to pending.`,
          });
        }
        return finish({ cause: "session_failed", exitCode: 1, task: code, detail });
      }
      bgId = agent.id;
      ws.sessionId = agent.sessionId;
      log.line(`${code} resume watch on ${bgId}`);
    } else {
      const next = getNextTask(db, project.id, release.id);
      if (next.task === null) {
        return finish(noTaskStop(db, next, completed.length));
      }
      taskId = next.task.id;
      code = next.task.code;
      if (next.reclaimed_from) {
        const stop = reclaimStop(db, deps, taskId, code, next.reclaimed_from, log.dir);
        return finish({ cause: "task_reclaimed", exitCode: 1, task: code, detail: stop });
      }
      if (next.doc_drift || next.plan_status !== "approved") {
        releaseTask(db, { task_id: taskId, session_id: RUNNER_SESSION });
        const cause: StopCause = next.doc_drift ? "doc_drift" : "plan_not_approved";
        return finish({ cause, exitCode: 1, task: code, detail: `${code} released back (plan ${next.plan_status ?? "-"}, doc_drift ${next.doc_drift})` });
      }
      const args = buildBgArgs(buildPrompt(code, next.task.title, release.version, project.code_prefix), code, opts.model);
      try {
        bgId = deps.claude.spawnBg(args, repo);
      } catch (error) {
        releaseTask(db, { task_id: taskId, session_id: RUNNER_SESSION });
        const detail = spawnFailureDetail(error, repo);
        addHandoffNote(db, {
          task_id: taskId,
          session_id: RUNNER_SESSION,
          remaining_work: `Batch runner stopped: spawn_failed. ${capDetail(detail)}. Released back to pending.`,
          discoveries: `runner log: ${log.dir}`,
        });
        return finish({ cause: "spawn_failed", exitCode: 1, task: code, detail });
      }
      log.line(`${code} spawned ${bgId}`);
      deps.out(`[${code}] started: claude attach ${bgId}`);
      ws.sessionId = await awaitSession(deps, bgId);
    }

    const outcome = await watch({ db, taskId, code, bgId, opts, deps, log, ws });
    const sid = ws.sessionId;
    writeTaskSummary(log, deps, repo, code, outcome, ws);

    if (outcome.kind === "stop") {
      const released = outcome.cause !== "task_cancelled" && releaseIfUnclaimed(db, taskId);
      const next = released
        ? `The session never claimed ${code}; the runner released it back to pending.`
        : `Resume with task-tracker-run --resume ${code}.`;
      addHandoffNote(db, {
        task_id: taskId,
        session_id: sid ?? `${RUNNER_SESSION}:${bgId}`,
        remaining_work: `Batch runner stopped: ${outcome.cause}. ${outcome.detail}. Session ${bgId} (claude attach ${bgId}). ${next}`,
        discoveries: `runner log: ${log.dir}`,
      });
      return finish({ cause: outcome.cause, exitCode: 1, task: code, bgId, sessionId: sid, detail: outcome.detail });
    }

    completed.push(code);
    log.line(`${code} done in ${fmtMin(deps.now() - ws.startMs)}, blocked ${fmtMin(ws.blockedMs)}`);
    deps.out(`[${code}] done`);
    const gitIssues = gitFailures(repo, release, deps);
    if (gitIssues.length > 0) {
      return finish({ cause: "git_state", exitCode: 1, task: code, bgId, sessionId: sid, detail: gitIssues.join("; ") });
    }
  }
}

function writeTaskSummary(
  log: RunLog,
  deps: RunnerDeps,
  repo: string,
  code: string,
  outcome: WatchOutcome,
  ws: WatchState,
): void {
  const transcript = ws.sessionId ? transcriptPath(repo, ws.sessionId) : null;
  const lines = [
    `## ${code}: ${outcome.kind === "done" ? "done" : `${outcome.cause} (${outcome.detail})`}`,
    "",
    `- wall time: ${fmtMin(deps.now() - ws.startMs)}`,
    `- working time: ${fmtMin(ws.workingMs)}`,
    `- blocked on the owner: ${fmtMin(ws.blockedMs)}`,
    `- session: ${ws.sessionId ?? "-"}`,
    `- transcript: ${transcript ?? "-"}`,
  ];
  if (transcript) {
    const orchestrator = deps.metrics([transcript]);
    const subagents = subagentTranscripts(transcript);
    const agents = subagents.length > 0 ? deps.metrics(subagents) : null;
    lines.push("", "orchestrator metrics:", "```json", orchestrator ?? "null", "```");
    lines.push("", "subagent metrics:", "```json", agents ?? "null", "```");
  }
  log.summary(lines.join("\n") + "\n");
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// -------------------------------------------------------------------- CLI

/** `4h`, `15m`, `30s`, `500ms`, or a bare number of seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`bad duration: ${text}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * factor);
}

const USAGE = `usage: task-tracker-run <project> <release> [options]
  --repo <path>      checkout the sessions work in (default: the project's root_path)
  --resume <CODE>    re-attach to the running session "<CODE> runner"
  --timeout <dur>    working time per task, blocked time excluded (default 4h)
  --poll <dur>       watch interval (default 30s)
  --grace <dur>      idle session with an unfinished task and no question (default 15m)
  --model <model>    model for the sessions
  --runs-dir <path>  log root (default ~/.task-tracker/runs, or TASK_TRACKER_RUNS_DIR)
  --dry-run          print preflight, the next hand-out and the command; spawn and write nothing
durations: 4h, 15m, 30s, 500ms, or bare seconds`;

export function parseArgs(argv: string[]): RunOptions {
  const positional: string[] = [];
  const opts: Partial<RunOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--repo": opts.repo = path.resolve(value()); break;
      case "--resume": opts.resume = value(); break;
      case "--timeout": opts.timeoutMs = parseDuration(value()); break;
      case "--poll": opts.pollMs = parseDuration(value()); break;
      case "--grace": opts.graceMs = parseDuration(value()); break;
      case "--model": opts.model = value(); break;
      case "--runs-dir": opts.runsDir = path.resolve(value()); break;
      case "--dry-run": opts.dryRun = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new Error("expected <project> <release>");
  return {
    project: positional[0],
    release: positional[1],
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
    pollMs: opts.pollMs ?? DEFAULTS.pollMs,
    graceMs: opts.graceMs ?? DEFAULTS.graceMs,
    dryRun: opts.dryRun ?? false,
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.runsDir ? { runsDir: opts.runsDir } : {}),
  };
}

/**
 * A dry run must not write the DB: no openDatabase (it would run migrations),
 * just the existing file, read once by `peekNextTask`'s serialize().
 */
function openForDryRun(): DatabaseInstance {
  const db = new Database(defaultDbPath(), { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

export async function main(argv: string[], deps: RunnerDeps = defaultDeps()): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    deps.out(USAGE);
    return 0;
  }
  let opts: RunOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`${message(error)}\n${USAGE}`);
    return 2;
  }
  const db = opts.dryRun ? openForDryRun() : openDatabase();
  try {
    return (await runBatch(db, opts, deps)).exitCode;
  } catch (error) {
    console.error(`task-tracker-run: ${message(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
