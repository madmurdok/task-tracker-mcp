import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeBin, classifyAgent, createClaudeBg, parseBgId } from "../src/cli/claudeBg.js";

/**
 * TTM-95: the `claude` CLI wrapper behind the batch runner
 * (docs/design/TTM-95-runner.md, "Loop shape", "Stop conditions").
 * Process-level cases run a script-driven fake `claude`
 * (tests/fixtures/fake-claude.sh), never the real CLI.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fixtures", "fake-claude.sh");

describe("parseBgId", () => {
  it("reads the id from `backgrounded · <id>`", () => {
    expect(parseBgId("backgrounded · 7f3a91c2\n")).toBe("7f3a91c2");
  });

  it("ignores colour codes around the line", () => {
    expect(parseBgId("\u001b[32mbackgrounded\u001b[0m · \u001b[1m7f3a91c2\u001b[0m\n")).toBe("7f3a91c2");
  });

  it("falls back to a bare 8-hex id when the line is worded differently", () => {
    expect(parseBgId("started session 0badcafe in background\n")).toBe("0badcafe");
  });

  it("returns null when no id is printed", () => {
    expect(parseBgId("error: not logged in\n")).toBeNull();
  });
});

describe("classifyAgent", () => {
  // Observed shapes (design note, "Stop conditions"; TTM-95/S20 probe).
  it.each([
    ["finished turn: state done, status idle", { state: "done", status: "idle" }, "idle"],
    ["after `claude stop`: state done, no status", { state: "done" }, "idle"],
    ["bare state blocked, no question", { state: "blocked" }, "idle"],
    ["owner question: waitingFor input needed", { state: "blocked", waitingFor: "input needed" }, "blocked"],
    ["permission prompt", { state: "blocked", waitingFor: "permission prompt" }, "blocked"],
    ["status waiting, no waitingFor", { state: "blocked", status: "waiting" }, "blocked"],
    ["status waiting while state says working", { state: "working", status: "waiting" }, "blocked"],
    ["failed", { state: "failed" }, "dead"],
    ["stopped", { state: "stopped" }, "dead"],
    ["working", { state: "working" }, "working"],
  ] as const)("%s", (_label, agent, want) => {
    expect(classifyAgent({ id: "abc12345", ...agent })).toBe(want);
  });

  it("a session missing from agents --json is dead", () => {
    expect(classifyAgent(undefined)).toBe("dead");
  });
});

describe("createClaudeBg over a fake claude binary", () => {
  let dir: string;
  let logFile: string;
  let agentsFile: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_BG_OUT", "FAKE_CLAUDE_AGENTS", "FAKE_CLAUDE_EXIT", "CLAUDE_BIN"];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ttm95-claude-")));
    logFile = path.join(dir, "calls.log");
    agentsFile = path.join(dir, "agents.json");
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.FAKE_CLAUDE_LOG = logFile;
    delete process.env.FAKE_CLAUDE_EXIT;
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Each invocation as {cwd, args}. */
  function calls(): { cwd: string; args: string[] }[] {
    return readFileSync(logFile, "utf8")
      .split("--\n")
      .filter((block) => block.trim() !== "")
      .map((block) => {
        const lines = block.split("\n").filter((l) => l !== "");
        return {
          cwd: lines[0].replace(/^cwd=/, ""),
          args: lines.slice(1).map((l) => l.replace(/^arg=/, "")),
        };
      });
  }

  it("CLAUDE_BIN picks the binary", () => {
    process.env.CLAUDE_BIN = fakeClaude;
    expect(claudeBin()).toBe(fakeClaude);
    expect(createClaudeBg().version()).toBe("9.9.9 (Claude Code)");
  });

  it("spawnBg runs `claude --bg <args>` in the repo and returns the printed id", () => {
    process.env.FAKE_CLAUDE_BG_OUT = "backgrounded · 1a2b3c4d";
    const id = createClaudeBg(fakeClaude).spawnBg(["do the task", "-n", "TTM-1 runner"], dir);
    expect(id).toBe("1a2b3c4d");
    const [call] = calls();
    expect(call.cwd).toBe(dir);
    expect(call.args).toEqual(["--bg", "do the task", "-n", "TTM-1 runner"]);
  });

  it("spawnBg throws when the CLI prints no id", () => {
    process.env.FAKE_CLAUDE_BG_OUT = "something went wrong";
    expect(() => createClaudeBg(fakeClaude).spawnBg(["p"], dir)).toThrow(/printed no session id/);
  });

  it("spawnBg throws when the CLI exits non-zero", () => {
    process.env.FAKE_CLAUDE_BG_OUT = "backgrounded · 1a2b3c4d";
    process.env.FAKE_CLAUDE_EXIT = "1";
    expect(() => createClaudeBg(fakeClaude).spawnBg(["p"], dir)).toThrow();
  });

  it("listAgents parses `agents --json --all`", () => {
    const rows = [
      { id: "1a2b3c4d", sessionId: "u-1", name: "TTM-1 runner", state: "blocked", status: "waiting", waitingFor: "input needed" },
      { id: "5e6f7a8b", sessionId: "u-2", name: "TTM-2 runner", state: "done", status: "idle" },
    ];
    writeFileSync(agentsFile, JSON.stringify(rows));
    process.env.FAKE_CLAUDE_AGENTS = agentsFile;
    expect(createClaudeBg(fakeClaude).listAgents()).toEqual(rows);
    expect(calls()[0].args).toEqual(["agents", "--json", "--all"]);
  });

  it("listAgents refuses output that is not an array", () => {
    writeFileSync(agentsFile, JSON.stringify({ agents: [] }));
    process.env.FAKE_CLAUDE_AGENTS = agentsFile;
    expect(() => createClaudeBg(fakeClaude).listAgents()).toThrow(/did not print an array/);
  });

  it("stopBg runs `claude stop <id>`", () => {
    createClaudeBg(fakeClaude).stopBg("1a2b3c4d");
    expect(calls()[0].args).toEqual(["stop", "1a2b3c4d"]);
  });
});
