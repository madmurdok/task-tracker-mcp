# TTM-104: runner hardening (reclaim, notify order, spawn stderr)

Follow-up to `docs/design/TTM-95-runner.md`. Three defects found by TTM-95's
verify and smoke run; one section each.

## 1. A hand-out carrying `reclaimed_from`

### Problem

`runBatch` (`src/cli/runBatch.ts`, the `getNextTask` branch of the loop)
reads only `next.task`, `doc_drift` and `plan_status`. A reclaimed task (lapsed
lease, TTM-78) is spawned like a fresh one, although the tool's own contract
says a lapsed lease may be a paused session that will come back.

### What `claude agents --json` gives (CLI 2.1.309, run read-only)

One row per session, background and interactive:
`{ id?, pid?, cwd, kind: "background"|"interactive", startedAt, sessionId, name, state?|status? }`.
`sessionId` is the full uuid, the same value as `$CLAUDE_CODE_SESSION_ID`
(this session's row matched its own scratchpad uuid), so a task's
`owner_session_id` can be matched against `sessionId`. Background rows carry
`state` (`blocked`, `stopped`, `done`, ...); interactive rows carry `pid` and
`status` (`busy`, `idle`). Only this machine's sessions are listed.

### Options

**A. Stop the runner.** On `reclaimed_from`, release the task, write a note,
stop with a new cause.
- Benefit: never two workers on one task, whatever the previous holder is.
  No guess about which CLI states mean "gone". Small change, easy to pin.
- Risk: a lease that lapsed because its session really died still stops the
  batch; the owner has to look and re-run. Lapses are rare (2 h with no slice
  activity), so the cost is one manual restart per lapse.

**B. Check the previous holder in `claude agents --json`.** Spawn only if
the row for `owner_session_id` is missing or dead.
- Benefit: a dead holder no longer stops an unattended batch.
- Risk: a missing row does not prove the session is gone: a session on
  another machine, an interactive session that was closed and will be
  `claude --resume`d, or a subagent claiming under its parent's id all look
  "absent". `state: "done"` on a background row can still be attached and
  continued. `owner_session_id` may also be null (an unclaimed hand-out of a
  previous runner), which matches nothing. Every one of these is a false
  "gone", i.e. exactly the double-worker bug this task fixes.

### Recommendation: A, with the agents lookup as information only

Stop. Before stopping, look the previous owner up in `listAgents()` (one call,
errors ignored) and put what was found in the note, so the owner can decide in
one glance: `previous holder <uuid>: <kind> <state|status> in <cwd>` or
`not listed on this machine` or `no owner (unclaimed hand-out)`.

- Stop cause: `task_reclaimed` (new `StopCause` member), exit code 1.
- Release: `releaseTask(db, { task_id, session_id: RUNNER_SESSION })`, no
  `force`. The hand-out set `owner_session_id = NULL`, so the release cannot
  conflict.
- Note: `addHandoffNote` with `session_id: RUNNER_SESSION`,
  `remaining_work`: `Batch runner stopped: task_reclaimed. <CODE> was handed
  out again after a lapsed lease (previous owner <uuid|none>, lease until
  <lock_expires_at>, last activity <last_activity_at>). <lookup line>. Released
  back to pending; confirm the previous holder is gone, then re-run.`
  `discoveries`: `runner log: <dir>`. `finish()` writes the same detail to the
  run log and the summary.
- Order: checked right after `next.task === null`, before the plan/drift
  check, so a reclaimed task always gets the note.
- `--dry-run`: the peek line also prints `reclaimed from <owner|none>` when
  `peek.reclaimed_from` is set (nothing is released there).

Caveat (see "Open for the owner"): released to pending, the task loses the
reclaim marker, so the next run hands it out as a plain pending task and spawns.
The note is the only guard after the first stop.

## 2. Owner notification order in `watch`

Today the "blocked episode" block (sets `blockedSince`, `deps.out`,
`deps.notify("<CODE> needs you")`) runs before the `task.status ===
"cancelled"` / `state === "dead"` checks. A cancelled task whose session is
waiting therefore pings the owner, then stops.

Move the whole blocked-episode block (both branches: notify on entry, the
"answered" log line on exit) to just after the cancelled/dead `if/else if`,
next to the `renewLease` call it belongs with. The idle notification is already
after those checks; it stays where it is. The done path above stays first and
still never notifies. Resulting order per poll: done -> cancelled -> dead ->
blocked (notify once, renew lease) -> idle (notify once, grace) -> timeout.

## 3. Full stderr in `spawn_failed`; untrusted workspace

### Where the line is lost

`message()` (`runBatch.ts`) returns `error.message.split("\n")[0]`. For an
`execFileSync` failure that first line is `Command failed: claude --bg ...`;
the CLI's stderr ("Workspace not trusted. Run `claude` in <dir> once ...")
follows on later lines and is dropped. `message()` has six callers
(g-mesh `find_callers message`: `preflight`, `gitFailures`, `watch`,
`stopQuietly`, `runBatch`, `main`); only the spawn path changes, the rest keep
one-line messages.

### Change

- `createClaudeBg().spawnBg` (`claudeBg.ts`) catches the `execFileSync` error
  and throws a `SpawnError` (exported) with `stderr` (trimmed, ANSI stripped),
  `stdout`, `status`, and a message built from them. The existing "printed no
  session id" error becomes a `SpawnError` too.
- `runBatch`'s spawn `catch` builds the detail with a new
  `spawnFailureDetail(error)`: `exit <status>: <full stderr>` (stdout when
  stderr is empty), falling back to `message(error)` for a non-`SpawnError`.
  Prefixed with `workspace not trusted: <repo>; run claude there once and
  accept the trust prompt.` when the stderr matches
  `/workspace not trusted/i`.
- Cap: none on stderr for the run log and summary. The console line and the
  handoff note get the first 4000 characters plus `... (<n> more chars, see
  run log)`; the CLI's stderr is a few lines, the cap only guards a runaway.

### Preflight detection

Claude Code records trust in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`
when set) as `projects[<abs path>].hasTrustDialogAccepted`. Trust is
inherited from an ancestor: `task-tracker-mcp-wt-ttm95` has no entry, yet
TTM-95's probe sessions ran there under trusted `ClaudeProjects`, while the
scratch dir under `/private/tmp` (no trusted ancestor) failed.

Check: walk from `realpath(repo)` up to `/`, trusted if any entry on the way
has `hasTrustDialogAccepted: true`. Exposed as
`ClaudeBg.workspaceTrusted(dir): boolean | null`, `null` when the file is
missing, unreadable or has no `projects` object (then preflight says nothing).
`false` adds the preflight failure `workspace not trusted: <repo> (run claude
there once and accept the trust prompt)`.

Reliability: cheap (one file read) and matches every observation, but the file
is internal and undocumented, so the stderr naming above is the guaranteed
path; the preflight check is the early, best-effort one. If the owner prefers,
`false` can be a warning line instead of a failure (open question 3).

## Edit map

Line numbers are the branch head's.

| File | Symbol | Lines | Change |
|---|---|---|---|
| `src/cli/claudeBg.ts` | `ClaudeBg` | 29-38 | add `workspaceTrusted(dir)` |
| `src/cli/claudeBg.ts` | `createClaudeBg` | 67-89 | `spawnBg` wraps errors in `SpawnError`; implement `workspaceTrusted` |
| `src/cli/claudeBg.ts` | new `SpawnError`, `findTrust` | after 56 | error class; ancestor walk over the config's `projects` |
| `src/cli/runBatch.ts` | `StopCause` | 261-274 | add `task_reclaimed` |
| `src/cli/runBatch.ts` | `preflight` | 299-345 | call `deps.claude.workspaceTrusted(repo)` |
| `src/cli/runBatch.ts` | new `spawnFailureDetail` | next to `message` 361-363 | full stderr, cap, trust prefix |
| `src/cli/runBatch.ts` | `watch` | 398-505 | move blocked-episode block (450-459) after cancelled/dead (461-467) |
| `src/cli/runBatch.ts` | `runBatch` | 627-744 | reclaim stop after `next.task === null` (696-698); spawn `catch` (707-712) uses `spawnFailureDetail`; dry-run peek line (637-645) |
| `tests/runBatch.test.ts`, `tests/claudeBg.test.ts` | fakes of `ClaudeBg` | - | fakes gain `workspaceTrusted` |

Read for context: `getNextTask`/`handOut`/`ReclaimedFrom`
(`src/domain/status.ts`), `releaseTask`/`claimTask`
(`src/domain/lifecycle.ts`), `releaseIfUnclaimed`, `findAgent`,
`classifyAgent`, `noTaskStop`, `finish` (inside `runBatch`).

Cross-file facts (g-mesh, main checkout index; these symbols are unchanged on
the branch): `find_callers message` -> 6 callers, all in `runBatch.ts`;
`find_references ClaudeBg#spawnBg` -> `claudeBg.ts`, `runBatch.ts`,
`tests/claudeBg.test.ts`; `find_references preflight` -> `runBatch.ts` only.

## Behaviours the tests must pin

1. A hand-out with `reclaimed_from` spawns nothing and stops with `task_reclaimed`, exit 1.
2. That task is back to `pending`, owner NULL, after the stop.
3. Its handoff note names the previous owner, lease end, last activity and the agents lookup line.
4. Lookup states: owner listed (kind + state in the note), not listed, owner null; a `listAgents` throw still stops cleanly.
5. A plain pending hand-out (no `reclaimed_from`) still spawns.
6. `--dry-run` prints the reclaim marker and leaves the DB unchanged.
7. Cancelled task + blocked session: no `notify` call, stop `task_cancelled`.
8. Dead session on a poll where `waitingFor` would have been set: no `notify`, stop `session_failed`.
9. Blocked, not cancelled, alive: exactly one `notify` per episode (regression).
10. Spawn failure with multi-line stderr: the full stderr is in `RunResult.detail`, the run log and the note.
11. Stderr containing "Workspace not trusted": detail starts with `workspace not trusted: <repo>`.
12. Stderr over the cap: note and console truncated with the marker, run log full.
13. `workspaceTrusted`: trusted via an ancestor entry; `false` with no trusted ancestor; `null` on missing or malformed config.
14. Preflight fails with the trust line on `false` and says nothing on `null`.

Candidate controls: drop the reclaim check (1, 2, 3); move the blocked block
back above cancelled/dead (7, 8); restore `split("\n")[0]` in the spawn detail
(10); drop the trust prefix (11); make the ancestor walk check only the exact
path (13).

## Open for the owner

1. Releasing to pending drops the reclaim marker: the next run spawns on that
   task without a check. Accept (the note is the guard), or leave it
   `in_progress` so preflight blocks the next run until the owner acts?
2. If the previous holder is alive and resumes after the release, it works a
   `pending` task with no owner. Acceptable for now, or should the note also be
   echoed to the console with `claude attach <id>` when the holder is listed?
3. Untrusted workspace in preflight: hard failure (recommended) or a warning
   line, given `~/.claude.json` is an undocumented format?
4. Stop cause name `task_reclaimed` and the 4000-char cap: OK?
