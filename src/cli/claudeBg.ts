// Thin wrapper over the `claude` CLI's background sessions (TTM-95,
// docs/design/TTM-95-runner.md, "Loop shape"): start one with `--bg`, read
// `claude agents --json --all`, stop one by its short id. Every call goes
// through one binary path so tests can point `CLAUDE_BIN` at a fake `claude`
// and no test ever spends usage.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One row of `claude agents --json`. Only the fields the runner reads are
 * typed; the CLI reports more. Observed shapes (design note, experiment d):
 * a background session carries `id`, `sessionId`, `name`, `kind`, `state`
 * (`blocked`, `stopped`, ...) and, while it waits, `status: "waiting"` with
 * `waitingFor: "input needed" | "permission prompt"`. A session that finished
 * its turn reports `state: "done", status: "idle"` (TTM-95/S20 probe), and
 * `state: "done"` with no status after `claude stop`.
 */
export interface AgentEntry {
  id?: string;
  sessionId?: string;
  name?: string;
  kind?: string;
  cwd?: string;
  state?: string;
  status?: string;
  waitingFor?: string;
  startedAt?: number;
}

export interface ClaudeBg {
  /** `claude --version`; throws when the binary is missing or fails. */
  version(): string;
  /** Starts `claude --bg <args>` in `cwd`, returns the printed short id. */
  spawnBg(args: string[], cwd: string): string;
  /** `claude agents --json --all`: active and completed sessions. */
  listAgents(): AgentEntry[];
  /** `claude stop <id>`. */
  stopBg(id: string): void;
  /**
   * Whether Claude Code has accepted the trust dialog for `dir` or one of its
   * ancestors (TTM-104). `null` when the config file is missing, unreadable
   * or has no `projects` object: the format is internal, so unknown is not
   * "untrusted".
   */
  workspaceTrusted(dir: string): boolean | null;
}

export function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * The short id from `--bg`'s output. The CLI prints `backgrounded · <id>`;
 * the bare-hex fallback keeps a cosmetic change to that line (another
 * separator, colour codes) from breaking the runner.
 */
export function parseBgId(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const tagged = /backgrounded\s*\S?\s*([0-9a-f]{6,})/i.exec(plain);
  if (tagged) return tagged[1];
  const bare = /\b([0-9a-f]{8})\b/.exec(plain);
  return bare ? bare[1] : null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function plainText(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  return text.replace(ANSI, "").trim();
}

/**
 * A failed `claude --bg`: the CLI's own words (stderr, ANSI stripped) are
 * kept whole, because the reason ("Workspace not trusted ...") is never on
 * the first line of an execFileSync error (TTM-104).
 */
export class SpawnError extends Error {
  readonly stderr: string;
  readonly stdout: string;
  /** Exit status; null when the process was killed or never started. */
  readonly status: number | null;

  constructor(message: string, stderr: string, stdout: string, status: number | null) {
    super(message);
    this.name = "SpawnError";
    this.stderr = stderr;
    this.stdout = stdout;
    this.status = status;
  }

  static from(error: unknown): SpawnError {
    if (error instanceof SpawnError) return error;
    const e = (error ?? {}) as { stderr?: unknown; stdout?: unknown; status?: unknown; message?: unknown };
    const status = typeof e.status === "number" ? e.status : null;
    const stderr = plainText(e.stderr);
    const stdout = plainText(e.stdout);
    const said = stderr || stdout || (error instanceof Error ? error.message : String(error));
    return new SpawnError(`claude --bg failed (exit ${status ?? "-"}): ${said}`, stderr, stdout, status);
  }
}

/** Claude Code's global config: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/**
 * Walks from `dir` up to the root: trusted when any entry on the way has
 * `hasTrustDialogAccepted: true` (trust is inherited from an ancestor).
 * `null` when `config` has no `projects` object.
 */
export function findTrust(config: unknown, dir: string): boolean | null {
  if (typeof config !== "object" || config === null) return null;
  const projects = (config as { projects?: unknown }).projects;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return null;
  const table = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  const starts = new Set([path.resolve(dir)]);
  try {
    starts.add(fs.realpathSync(dir));
  } catch {
    // A missing dir still has its ancestors checked by the resolved path.
  }
  for (const start of starts) {
    for (let at = start; ; at = path.dirname(at)) {
      if (table[at]?.hasTrustDialogAccepted === true) return true;
      if (path.dirname(at) === at) break;
    }
  }
  return false;
}

function run(bin: string, args: string[], cwd?: string, timeoutMs = 60_000): string {
  return execFileSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function createClaudeBg(bin: string = claudeBin(), configPath: () => string = claudeConfigPath): ClaudeBg {
  return {
    version() {
      return run(bin, ["--version"]).trim();
    },
    spawnBg(args, cwd) {
      let output: string;
      try {
        output = run(bin, ["--bg", ...args], cwd, 120_000);
      } catch (error) {
        throw SpawnError.from(error);
      }
      const id = parseBgId(output);
      if (id === null) {
        const stdout = plainText(output);
        throw new SpawnError(`claude --bg printed no session id: ${stdout.slice(0, 200)}`, "", stdout, 0);
      }
      return id;
    },
    listAgents() {
      const parsed = JSON.parse(run(bin, ["agents", "--json", "--all"])) as unknown;
      if (!Array.isArray(parsed)) throw new Error("claude agents --json did not print an array");
      return parsed as AgentEntry[];
    },
    stopBg(id) {
      run(bin, ["stop", id]);
    },
    workspaceTrusted(dir) {
      let config: unknown;
      try {
        config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      } catch {
        return null;
      }
      return findTrust(config, dir);
    },
  };
}

const defaultClaude = (): ClaudeBg => createClaudeBg();

export function spawnBg(args: string[], cwd: string = process.cwd()): string {
  return defaultClaude().spawnBg(args, cwd);
}

export function listAgents(): AgentEntry[] {
  return defaultClaude().listAgents();
}

export function stopBg(id: string): void {
  defaultClaude().stopBg(id);
}

/** The watch's view of a session, derived from one `agents --json` row. */
export type SessionState = "working" | "blocked" | "idle" | "dead";

const DEAD_STATES = new Set(["failed", "stopped", "killed", "error", "crashed", "exited"]);
const IDLE_MARKERS = new Set(["idle", "done", "completed", "finished", "waiting-for-prompt"]);

/**
 * Collapses the CLI's `state`/`status`/`waitingFor` into the four cases the
 * stop table needs. A missing row is `dead` (the stop table's "session
 * missing"). `blocked` means a question for the owner, and only an explicit
 * one counts: `waitingFor` set or `status: "waiting"`. It is checked before
 * `idle` so that a session waiting on a form or a permission prompt is never
 * mistaken for one that ended. A bare `state: "blocked"` with neither (seen on
 * a pid-less row, meaning unknown) is `idle`: it then gets the bounded
 * "ended without finishing" path (notify, stop the loop after grace, session
 * left alive) rather than an unbounded wait with the clock paused.
 */
export function classifyAgent(agent: AgentEntry | undefined): SessionState {
  if (agent === undefined) return "dead";
  const state = agent.state?.toLowerCase();
  const status = agent.status?.toLowerCase();
  if (state !== undefined && DEAD_STATES.has(state)) return "dead";
  if (status === "waiting" || (agent.waitingFor ?? "") !== "") return "blocked";
  if (
    state === "blocked" ||
    (state !== undefined && IDLE_MARKERS.has(state)) ||
    (status !== undefined && IDLE_MARKERS.has(status))
  ) {
    return "idle";
  }
  return "working";
}
