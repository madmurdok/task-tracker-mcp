# TTM-100: a SessionEnd hook expires the ending session's leases

Status: approved by the owner, 2026-10-04: expire-now, every `reason`, the
hook script and settings snippet as in section 5 - with one change: the log is
split by month, `session-end-YYYY-MM.log` ("логи лучше наверное дробить по
месяцам хотя бы"). On top of TTM-78 (2 h lease,
`renewLease`, `reclaimed_from`; TTM-78-lease.md "Owner decision" point 4).
Problem: every "session gone" signal is time-based; paused and dead look alike.

## 1. SessionEnd facts (Claude Code 2.1.289, `claude --version`)

Source for every row: https://code.claude.com/docs/en/hooks (fetched 2026-10-04).

| Fact | Docs say |
| :- | :- |
| Fires | "When a session terminates". Not for subagents: "subagents use SubagentStop instead". |
| Payload (stdin JSON) | `session_id`, `transcript_path`, `cwd`, `hook_event_name: "SessionEnd"`, `reason` |
| `reason` / matcher | `clear` (after `/clear`), `resume` (switching conversations with `/resume` in a session), `logout`, `prompt_input_exit` (end of input in `-p` mode), `other` (everything else) |
| Blocking | Cannot block. Exit-2 table: "SessionEnd - No - Shows stderr to user only". JSON output discarded. |
| Timeout | "SessionEnd hooks share a 1.5-second budget; if your settings set a longer per-hook `timeout`, Claude Code raises the budget to match, up to 60 seconds." |
| Parallelism | "All matching hooks run in parallel"; each command hook gets the JSON on stdin. |
| `--resume` / `/clear` session id | SessionStart's `source` has `resume` and `clear`; whether `session_id` changes is **not stated**. |
| Crash, SIGTERM, SIGKILL, Ctrl+C/Ctrl+D | **Not stated.** SIGKILL cannot run anything; the rest is to observe. |

To observe in S5 (real sessions, hook logging only): (a) fires on normal exit
(`/exit`, Ctrl+D) with `reason: other`; (b) `/clear` fires with `clear`, and
whether the post-clear `$CLAUDE_CODE_SESSION_ID` (what `claim_task` gets) is a
new id; (c) `claude -p` fires with `prompt_input_exit`; (d) closing the terminal
(SIGHUP) and `kill -TERM`; (e) `claude --resume <id>` reuses the old id or not;
(f) the payload `session_id` equals `$CLAUDE_CODE_SESSION_ID` (the Stop hook
already relies on this for Stop events).

## 2. Release vs expire-now: **expire-now**

| | release (`releaseTask`) | expire-now (recommended) |
| :- | :- | :- |
| Row after | `pending`, owner NULL, lease NULL | `in_progress`, owner kept, lease = end time |
| Next get_next_task | fresh hand-out, **no** `reclaimed_from` | reclaim with `reclaimed_from` (TTM-78 decision 1) |
| `/clear`, `--resume` continuing the work | owner lost; the agent must re-claim; another session may take it as fresh work | same-id resume: any slice write renews it (`renewLease` renews a lapsed lease); new id: `claim_task` succeeds (lock not active) |
| Plan walker order | pending wins over reclaim inside a step, so it jumps ahead | unchanged reclaim order |

Release erases exactly the `owner_session_id` that `reclaimed_from` reports, and
contradicts the AC ("treats them per TTM-78 (reported reclaim)"). Expire only
moves the lease end, so everything TTM-78 built keeps working; it is "the lease
lapsed now instead of in 2 h". All `reason` values are treated the same (no
matcher): even `clear`/`resume` end the context that held the task, and the
reversibility above covers the continuing case.

Update (one statement, one transaction):
```sql
UPDATE tasks SET lock_expires_at = MIN(lock_expires_at, :endedAt)
WHERE owner_session_id = :sid AND status = 'in_progress'
  AND lock_expires_at IS NOT NULL
RETURNING project_id, task_number   -- returned as task codes (TTM-NN) for the log
```

- `:endedAt` = now minus 1 ms, so a `get_next_task` in the same millisecond
  (tests) still sees `lock_expires_at < now`.
- `MIN` never extends a lease that already lapsed (keeps
  `reclaimed_from.lock_expires_at` truthful); `IS NOT NULL` mirrors
  `renewLease` and the pickers (a legacy NULL-lease row is never reclaimable
  and stays so).
- `updated_at` is **not** touched: `lastActivityAt` (status.ts:188) reads it,
  and the end of a session is not work on the task. The trace is the log line.

## 3. Which tasks

`owner_session_id = ended id AND status = 'in_progress' AND lease NOT NULL`.

- Other sessions: owner differs. done/cancelled: status filter. Re-claimed by a newer session: `claimTask` writes the new id and a reclaim
  hands out with owner NULL, so the old id no longer matches. No lease
  comparison is needed; the owner column is the "who holds it now" fact.
- Subagents: share the parent's session id and do not fire SessionEnd (docs
  above). Their tasks expire when the parent ends, which is correct: the
  parent's exit ends them. Open point (S5): does `/resume` (switching
  conversations) leave background subagents running under the old id? If so,
  their task looks dead while alive; their next slice write renews it.
- `get_next_task` hand-outs (owner NULL) are out of reach. Acceptable: CLAUDE.md
  requires `claim_task` with the session id; the 2 h lease covers the rest.

## 4. CLI entry: `src/cli/session-end.ts` -> `dist/cli/session-end.js`

Same layout as `src/cli/status.ts` (shebang, built by `tsconfig.build.json`,
which compiles all of `src`). The MCP server already runs from this checkout's
`dist/index.js` (`~/.claude.json` mcpServers.task-tracker), so the hook calls
the same `dist`.

1. Read stdin to end; `JSON.parse`; take `session_id` (string, non-empty) and
   `reason`. Anything else: log and exit 0.
2. DB path: `defaultDbPath()` (honours `TASK_TRACKER_DB_PATH`). **Do not call
   `openDatabase`**: it `mkdir`s, creates a missing DB and runs migrations (a
   table rebuild can hold the 1.5 s budget). Open with
   `new Database(path, { fileMustExist: true })`, `busy_timeout = 1000`.
3. Call the domain function `expireSessionLeases(db, sessionId, nowIso)`.
4. Append one line to `~/.task-tracker/session-end-YYYY-MM.log` (dirname of the DB path; one file per UTC month, owner's decision):
   ISO time, session id, reason, expired task refs or the error message.
5. Whole body in try/catch; nothing on stdout/stderr (stderr would be shown to
   the user on exit); `process.exitCode = 0` always. A log-write failure is
   swallowed too.

Measured (load avg 53.9, `time -p`): node + better-sqlite3 open 0.09 s real /
0.07 user; `status.js` 0.17 / 0.13. Inside 1.5 s; `timeout: 10` covers a busy DB.

## 5. Hook script and settings snippet (installed only in S5, after approval)

`~/.claude/hooks/task-session-end.sh`:
```bash
#!/bin/bash
# SessionEnd: expire task-tracker-mcp leases held by the ending session.
# Never fails the exit: every error ends in the CLI's log or is dropped.
REPO="${TASK_TRACKER_REPO:-$HOME/Projects/ClaudeProjects/task-tracker-mcp}"
CLI="$REPO/dist/cli/session-end.js"
[ -f "$CLI" ] || exit 0
node "$CLI" >/dev/null 2>&1
exit 0
```

`~/.claude/settings.json`, merged as a third key beside `SubagentStop` and
`Stop` inside the existing `"hooks"` object (no matcher = every reason):
```json
"SessionEnd": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "~/.claude/hooks/task-session-end.sh",
        "timeout": 10
      }
    ]
  }
]
```

## 6. Edit map

- `src/domain/lifecycle.ts`: add `expireSessionLeases(db, sessionId, nowIso):
  string[]` after `releaseTask` (lines 117-167), doc comment citing this note.
  `claimTask` (73-115), `releaseTask`, `isLockActive` (53-55) unchanged. g-mesh
  `find_callers isLockActive` -> claimTask, releaseTask, cancelTask only;
  `find_callers releaseTask` -> registerLifecycleTools (src/mcp/tools/lifecycle.ts)
  plus tests/lifecycle.test.ts, tests/ownership.test.ts. No MCP tool is added.
- `src/cli/session-end.ts`: new (section 4).
- `package.json`: `bin` `task-tracker-session-end`; `npm run build` after merge.
- `tests/session-end.test.ts`: new; drives the CLI through tsx exactly as
  `tests/cli.test.ts` does (`resolveTsxCli`), DB in a temp dir.

## Tests (each with its control: revert the code, never the test)

1. CLI with `{session_id: A}`: A's in_progress task gets lease < now; the next
   `get_next_task` returns it with `reclaimed_from.owner_session_id = A`.
   Control: CLI made a no-op -> get_next_task returns `all_blocked`/nothing.
2. Task held by B (live lease) untouched. Control: drop the owner filter.
3. done and cancelled tasks of A keep their lease value. Control: drop the
   status filter.
4. Task claimed by A, then reclaimed and `claim_task`-ed by B; CLI for A leaves
   B's lease. Control: match on the reclaim marker/history instead of owner
   (or drop the owner filter) -> fails.
5. Already-lapsed lease of A is not moved later. Control: `=` instead of `MIN`.
6. Same-ms reclaim (fake clock): control `endedAt = now` without the 1 ms.
7. DB unavailable (path to a missing file, and to an unreadable/garbage file):
   exit 0, empty stdout/stderr, no DB file created, log line written. Control:
   use `openDatabase` -> a DB file appears; remove the try/catch -> non-zero.
8. Bad stdin (empty, non-JSON, no session_id): exit 0, log line. 9. Unit: `expireSessionLeases` returns the expired task codes (not uuids); same-id `startSlice`
   afterwards renews the lease (resume case).

## Risks

- Hook-payload id != the id agents pass to `claim_task` (e.g. after `/clear`):
  the hook silently matches nothing; the 2 h lease remains the fallback. S5 (b)/(f).
- `/resume` inside a session while background agents still run: their task is
  marked expired though alive; a reclaim hands it out with `reclaimed_from`,
  whose receiver must check (TTM-78 contract). Bounded, not prevented.
- A stale `dist` (not rebuilt): the hook does nothing. Board `stale_since`
  (lease - 2 h) reads ~2 h before the end for an expired task.
- `-p` runs (bench, scripts) each pay ~0.1-0.2 s of node at exit.
## Owner must confirm

1. Expire-now, not release (section 2).
2. All `reason` values, `clear` and `resume` included (no matcher).
3. Log file per month, `~/.task-tracker/session-end-YYYY-MM.log` (owner's change).
4. The script and settings snippet in section 5, installed in S5.
