# TTM-114: test gate fails with `[vitest-worker]: Timeout calling "onTaskUpdate"`

Status: diagnosis (S1). No production code involved.

## Summary

The gate is not the cause. `npm test` fails the same way from a shell; the
gate's `execSync(..., { stdio: "pipe" })` path, the MCP server's environment and
`maxBuffer` make no difference.

The cause is in the test suite. `tests/verification.test.ts` has 39 tests, and
every test and hook in it is synchronous (no `async`/`await`; they run `git`
through `execSync`). Under the `forks` pool the worker therefore never
returns to its event loop during the file. The runner sends an `onTaskUpdate`
RPC when the first test starts. The main process answers quickly, but the worker
cannot read the answer until the file ends. When the loop finally turns, the
**timers phase runs before the poll phase**. If the file took longer than 60 s,
birpc's timer for that call has already expired, so it fires and throws before
the waiting reply is read. vitest 3.2.7 hard-codes this timeout
(`DEFAULT_TIMEOUT = 6e4` in `node_modules/vitest/dist/chunks/index.B521nVV-.js`).
`createForksRpcOptions` does not override it, and no config option reaches it.

Load only matters because it slows the file down. In every run, the file's own
duration predicts the result: under 60 s the run passes, over 60 s it fails.

## Facts measured

Machine: 8 CPUs, 32 GB. Ambient load during the session came from other agents'
`rustc`/nextest builds plus memory pressure (143 MB free, 4.1 GB swap used). It
ranged from 14 to 540, and the suite itself adds about 100-150. "burners" means
64 `yes > /dev/null` processes (8 x ncpu) started 20 s before the run and killed
by the script. Load is shown as the 1-min average at start → end. The shell arm
writes stdout and stderr to files. The probe arm is
`execSync("npm test", { cwd, stdio: "pipe" })` from a node process,
the same call as `runTestCommand`. Every failure below is the
`Timeout calling "onTaskUpdate"` unhandled error. "ver.ts" is how long
`tests/verification.test.ts` took, as vitest reports it.

| arm | burners | load start→end | exit | RPC errors | failed tests | ver.ts | real / user / sys (s) |
|---|---|---|---|---|---|---|---|
| probe:low:0 (dry run) | 0 | 208→436 | 1 | 4 | 4 (cli.test.ts, 5 s timeout) | 86.2 s | 102.8 / 99.5 / 43.1 |
| probe:amb:1 | 0 | 366→448 | 1 | 1 | 0 | 66.5 s | 76.5 / 101.4 / 44.3 |
| shell:amb:1 | 0 | 455→498 | 1 | 2 | 0 | 69.2 s | 78.3 / 103.4 / 44.8 |
| probe:amb:2 | 0 | 506→419 | 1 | 1 | 0 | 60.4 s | 70.8 / 99.3 / 42.3 |
| shell:amb:2 | 0 | 369→257 | 1 | 1 | 1 (mcp-smoke, 5 s timeout) | 71.9 s | 82.7 / 95.1 / 40.6 |
| nocli:amb:1 (`--exclude tests/cli.test.ts`) | 0 | 204→146 | **0** | **0** | 0 | **57.0 s** | 63.5 / 92.1 / 41.7 |
| nocli:amb:2 | 0 | 143→244 | 1 | 1 | 0 | 64.0 s | 73.2 / 96.4 / 43.2 |
| clionly:amb:0 (`tests/cli.test.ts` only) | 0 | 318→329 | 0 | 0 | 0 | n/a | 16.7 / 9.4 / 2.0 |
| clionly:high:1 | 64 | 236→354 | 1 | 0 | 4 (5 s timeout) | n/a | 73.0 / 7.9 / 1.6 |
| shell:high:1 | 64 | 368→537 | 1 | 4 | 12 (5 s timeout) | 222.1 s | 256.2 / 84.3 / 34.6 |
| probe:high:1 | 64 | 386→495 | 1 | 4 | 12 (5 s timeout) | 226.6 s | 269.6 / 87.9 / 36.6 |
| mw2:amb:1 (`--maxWorkers=2`) | 0 | 132→93 | 1 | 1 | 0 | 64.4 s | 87.6 / 92.8 / 41.1 |
| shell:amb:3 | 0 | 81→162 | 1 | 1 | 0 | 60.6 s | 67.6 / 99.2 / 42.7 |
| mw2:amb:2 | 0 | 139→301 | 1 | 1 | 0 | 61.3 s | 96.4 / 96.3 / 42.0 |
| probe:amb:3 | 0 | 260→282 | 1 | 1 | 0 | 61.2 s | 69.8 / 100.8 / 43.2 |
| mw2:amb:3 | 0 | 250→256 | 1 | 1 | 0 | 65.5 s | 103.9 / 98.1 / 42.1 |
| shell:low:1 | 0 | **22**→155 | 1 | 1 | 0 | 64.6 s | 72.7 / 101.0 / 44.7 |
| probe:low:1 | 0 | 141→221 | 1 | 1 | 0 | 66.6 s | 74.0 / 104.1 / 45.9 |

What this rules out:

- **Gate vs shell (execSync/pipe):** shell and probe arms fail the same way
  at similar load (rows amb:1-3, high:1, low:1).
- **MCP server environment:** the server is launched as
  `node .../dist/index.js` with `env: {}` (`~/.claude.json`). Its environment,
  read with `ps -E` on the running server, differs from the agent shell's only
  in `CLAUDE_*`/launchd keys. It has no `CI`, `NODE_OPTIONS`, `FORCE_COLOR` or
  `VITEST*`.
- **`maxBuffer`:** stdout was 15-44 KB and stderr under 10 KB, well below
  execSync's 1 MB default. A buffer overflow would also show up as `ENOBUFS`
  plus SIGTERM, not as an exit by vitest.
- **Main-process contention:** `--maxWorkers=2` still fails 3 of 3 times with
  exactly 1 RPC error.
- **`tests/cli.test.ts`:** excluding it does not stop the failure (nocli:amb:2).
  Run alone at high load, it times out its own tests but produces no RPC error.
- **The gate's transaction / DB lock:** already ruled out in the brief.
  complete_task and release_it reach the same `runTestCommand`, so the
  complete_task gate fails the same way.
- **Load as the cause:** shell:low:1 started at load 22 and failed anyway,
  because the file took 64.6 s. The 2026-10-24 passing shell run (66 s total)
  had a shorter `verification.test.ts`.

The one deciding variable is whether `verification.test.ts` ran longer than
60 s. That held in all 16 full-suite runs.

## Control (load-independent)

Harness:
`/private/tmp/claude-502/-Users-Valentin-Taiurskii-Projects-ClaudeProjects-task-tracker-mcp/03891995-86a2-4750-ac97-8d47748e1395/scratchpad/ttm114/ctl/`.
It is one test file of N synchronous tests, each `execSync("sleep 5")`. That
blocks the event loop without using CPU, so load does not affect it.
`testTimeout` is 30 s. The repo's own vitest binary runs it
(`--root ctl --config ctl/vitest.config.mjs`). The arms differ in just one thing:
whether a setup file adds `afterEach(() => new Promise(r => setImmediate(r)))`,
which lets the worker reach its poll phase between tests.

| N | yield | load at start | exit | RPC errors | tests | real / user / sys (s) |
|---|---|---|---|---|---|---|
| 13 (65 s sync) | no | 46 | 1 | 1 | 13 passed | 70.2 / 4.2 / 1.1 |
| 13 (65 s sync) | **yes** | 27 | **0** | **0** | 13 passed | 69.0 / 4.0 / 1.1 |
| 11 (55 s sync) | no | 20 | 0 | 0 | 11 passed | 59.2 / 4.3 / 1.1 |

The failure reproduces at low load with only 4 s of CPU, and the yield is the
only thing that makes it go away. (An earlier pass with the default 5 s
`testTimeout` gave the same RPC pattern: 1 / 0 / 0.)

## Proposed fix: test infrastructure only

Production code does not change. `runTestCommand` reports a real non-zero
exit correctly.

1. **New file `tests/setup/yield-event-loop.ts`:** register a global
   `afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))`
   (import `afterEach` from `vitest`), with a comment explaining the
   timers-before-poll mechanism and the 60 s hard-coded birpc timeout.
   This covers every current and future file of synchronous tests, not only
   `verification.test.ts`.
2. **`vitest.config.ts`, `test` block:** add
   `setupFiles: ["tests/setup/yield-event-loop.ts"]` next to `exclude`.
   Check that `tests/setup/` is not matched by the test `include` glob. The
   default `**/*.{test,spec}.?(c|m)[jt]s?(x)` does not match it.

Read for context: `vitest.config.ts` (whole file, about 30 lines), and
`tests/verification.test.ts` describe/hook outline (lines 49, 118, 298, 498,
594) to confirm everything there is synchronous.

Rejected alternatives:

- Split `verification.test.ts`: each piece would still fail once load
  pushes it past 60 s.
- Lower `maxWorkers`: measured, it does not help.
- Raise the RPC timeout: no option exists in vitest 3.2.7.
- Convert the tests to async `execFile`: large churn for the same effect.

Risks:

- About 766 extra `setImmediate` turns, which is negligible.
- A future vitest upgrade could add its own yield, which would make the setup
  file redundant but harmless.
- A single synchronous *test* longer than 60 s would still fail. None exists:
  the longest is about 16 s under burners.

## Behaviours to pin

There is no new test in the repo; a 65 s in-suite test would cost more than it
pins. The verify slice should instead:

1. **Control (revert must fail):** run the ctl harness with N=13, using the
   repo's `tests/setup/yield-event-loop.ts` as its setup file. Expect exit 0 and
   0 RPC errors. With the setup file removed, expect exit 1 and 1 RPC error.
   Load does not matter, because `sleep` uses no CPU.
2. **Suite:** run `npm test` once through the probe
   (`ttm114/probe.cjs <repo> <out>`, the same execSync call as the gate) at
   whatever load is current, and record how long `verification.test.ts` took.
   It must exit 0 even when that file runs over 60 s. On 2026-10-25 it was over
   60 s in 15 of 16 runs, so the old code fails almost every time.
