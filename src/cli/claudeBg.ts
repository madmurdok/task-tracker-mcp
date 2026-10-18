// Thin wrapper over the `claude` CLI's background sessions (TTM-95,
// docs/design/TTM-95-runner.md, "Loop shape"): start one with `--bg`, read
// `claude agents --json --all`, stop one by its short id. Every call goes
// through one binary path so tests can point `CLAUDE_BIN` at a fake `claude`
// and no test ever spends usage.
import { execFileSync } from "node:child_process";

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

function run(bin: string, args: string[], cwd?: string, timeoutMs = 60_000): string {
  return execFileSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function createClaudeBg(bin: string = claudeBin()): ClaudeBg {
  return {
    version() {
      return run(bin, ["--version"]).trim();
    },
    spawnBg(args, cwd) {
      const output = run(bin, ["--bg", ...args], cwd, 120_000);
      const id = parseBgId(output);
      if (id === null) {
        throw new Error(`claude --bg printed no session id: ${output.trim().slice(0, 200)}`);
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
