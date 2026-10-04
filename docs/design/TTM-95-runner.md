# TTM-95: a headless runner, one fresh session per task

Status: design, awaiting approval. Branch `feat/TTM-95-headless-runner`.

## Goal

Work one approved release batch unattended, task by task, each task in a fresh
`claude -p` session, so the orchestrator's context starts near zero for every
task instead of growing to 312k over the batch (2026-09-24: orchestrator ~$9 of
~$32, 29%). The tracker carries all state between sessions. The loop stops
cleanly, saying why, on exhaustion or when the owner is needed.

## Language: TypeScript, in this repo (`src/cli/runBatch.ts`)

- The runner calls the tracker's own domain functions on the same DB
  (`openDatabase`, `getNextTask`, `claimTask`, `releaseTask`, `addHandoffNote`,
  `getTaskDetail`), exactly as `src/cli/status.ts` already does. Bash would need
  raw `sqlite3` SQL that re-implements `pickByPlan`'s plan walk, or an MCP
  client; either drifts from the tracker.
- Testable with vitest via `CLAUDE_BIN` pointing at a fake `claude`; no test
  spends usage. Risk: tied to the tracker's schema, but it lives in the same repo.

## Loop shape

```
runBatch(project, release, repo, opts):
  preflight: claude --version; repo clean (git status --porcelain empty);
             HEAD == release-<version>; plan approved (get_plan) else stop
  if opts.resume: task = opts.resume; releaseTask(stale runner lease); goto run
  loop:
    r = getNextTask(db, project, release)            # runner pulls, not the model
    if r.task == null: stop(r.reason, r.blocked_on/drift)   # all_done | all_blocked | plan_not_approved
    if r.plan_status != "approved" or r.doc_drift: releaseTask; stop(...)
  run:
    sid = randomUUID()
    claimTask(db, task.id, sid)                      # owner_session_id = sid, so the Stop hook matches
    res = spawn(claude -p PROMPT(task) <flags> --session-id sid), wall timeout T
    write log; t = getTaskDetail(task.id)            # DB is the truth, not the model's claim
    if t.status == done and git clean and HEAD == release branch: continue loop
    if note from sid with remaining_work ^"NEEDS_OWNER:": stop(needs_owner, question)
    else: addHandoffNote(task, sid, "runner: <cause>"); stop(cause)
```

The runner, not the session, calls `get_next_task`: the stop decision costs no
model turn, and the order still comes from the plan (the call that refuses on
draft/drifted is the one that picks). `get_next_task` hand-outs leave `owner_session_id` NULL
(status.ts `handOut`), hence the explicit `claimTask` with the session's uuid.
One task at a time; parallel plan steps run sequentially in v1.

## Per-iteration prompt

```
Headless run, no human on this session. Work exactly one task: <CODE> "<title>",
release <version> of project <PREFIX>. It is already claimed for this session.
Follow ~/.claude/CLAUDE.md and the slice-task skill as the orchestrator: run its
remaining slices (get_task shows them and any handoff notes) with one fresh
subagent each, in the foreground (never run_in_background), task branch off
release-<version>, merge into release-<version>, set_task_release, complete_task,
and leave the checkout clean on release-<version>.
Do not call get_next_task and do not start any other task. Never push, never
touch main. The approved plan covers commits on the task branch and the merge.
If you need the owner (a design doc ready for review, any stop-and-ask case in
CLAUDE.md, a question), stop instead of guessing: commit what you have on the
task branch, leave the slice in_progress, call add_handoff_note(session_id=
$CLAUDE_CODE_SESSION_ID) with remaining_work starting "NEEDS_OWNER: " and the
question or the doc path, switch back to release-<version>, then end.
<if resumed: "The owner answered, verbatim: «...». Record these words where an
approval is recorded (the design slice's complete_slice result).">
```

`--append-system-prompt` adds one line: "Nobody reads this session live; a
question asked in text is never answered. Use the NEEDS_OWNER handoff note."

## Stop conditions

| Stop | Detected by | Recorded |
|---|---|---|
| batch done | `getNextTask` → `all_done` | runner summary only |
| all blocked | → `all_blocked`, `blocked_on` | summary lists codes |
| plan draft/drifted | → `plan_not_approved` (+`drift`) | summary; nothing to note (no task held) |
| doc drift | `doc_drift: true` on a hand-out | task released (`releaseTask`), summary |
| owner needed | task not done + note from `sid` with `NEEDS_OWNER:` | the session's own handoff note |
| session ended without finishing | task not done, no such note | runner's note under `sid` |
| crash / timeout / usage limit / budget | exit code, result `is_error`/subtype, timer | runner's note under `sid` with the cause |
| dirty tree or wrong branch after a done task | `git status`, `git rev-parse` | summary; no note (task is done) |

Every stop prints: cause, task code, question or doc path, log path, resume command.

## "Needs owner": convention now, tracker field later

No tracker change in this task: a handoff note whose `remaining_work` starts with
`NEEDS_OWNER:`, written under the session's id. The runner reads it with
`listHandoffNotes` filtered by `session_id = sid`, so an old note cannot trigger
a stop. Limits: the board does not show it; a string prefix is a convention, not
a constraint. A proper `needs_owner` state (a task flag or a slice status
`awaiting_owner` that `get_next_task` and the board understand) would be its own
task - **decision**.

Lease interaction (TTM-78): a paused task stays `in_progress` under a 30-minute
lease; after it lapses, any project-wide `get_next_task` may reclaim it. The
runner itself stops on the pause, so it never reclaims; resume goes by id.

## Owner review and resume

1. A design slice finishes; the session commits the doc on the task branch and
   writes `NEEDS_OWNER: design doc docs/design/<CODE>-x.md ready for review`.
2. Loop stops and prints it. The owner reads the doc.
3. `task-tracker-run --project TTM --release 0.14.0 --resume TTM-n --owner-says "<words>"`.
   The runner `releaseTask`s the lapsed/ended runner lease, claims under a new
   uuid, and passes the words verbatim; the session re-slices from the note
   (slice-task "Re-slice after design") and goes on. Then the loop continues.

Or answer in an interactive session and rerun without `--resume`.

## Permissions (flags from `claude --help`, 2.1.289)

Common: `-p`, `--session-id <uuid>`, `--output-format json`,
`--permission-prompts none` ("anything that would prompt is denied
automatically"), `--max-budget-usd <n>` (per session, `--print` only),
`-n "<CODE> runner"`, `--disallowedTools "Bash(git push*)" "mcp__task-tracker__delete_task"`
plus deny patterns for `main`. CLAUDE.md, hooks and MCP servers load as in an
interactive session (no `--bare`). `--max-turns` does not exist in this
version's `--help`; the wall-clock timeout replaces it.

| Option | Flags | Risk |
|---|---|---|
| A (proposed) | `--permission-mode auto` | the classifier decides; a wrong denial ends the task early (caught as "ended without finishing"); a wrong allow is possible but the deny list covers push/main/delete |
| B | `--permission-mode dontAsk` + `--allowedTools` allowlist | deterministic, but every gap (a new script, an MCP tool) fails a task; maintaining the list is ongoing work; exact `dontAsk` semantics to confirm in docs |
| C | `--dangerously-skip-permissions` | rejected: `--help` itself says "only for sandboxes with no internet access"; push and destructive git become possible |

## Logs

`~/.task-tracker/runs/<PREFIX>-<version>-<UTC stamp>/`, outside any repo:
- `runner.log` (one timestamped line per hand-out/spawn/exit/stop),
  `<n>-<CODE>.json` (the `--output-format json` result), `<n>-<CODE>.stderr`.
- `summary.md`: per task: outcome, wall time, session uuid, transcript path
  (`~/.claude/projects/<slug>/<uuid>.jsonl`), `slice_metrics.py --json` of the
  orchestrator transcript and of its `subagents/`; the stop block.


## Failure handling

- **Crash** (non-zero exit, no parsable result): note "runner: session exited
  <code>", stop. No automatic retry in v1: a retry would re-run slices whose
  state the crash may have left half-written.
- **Timeout** (`--timeout`, default 4 h): SIGTERM the group, then SIGKILL; note, stop.
- **Usage limit**: error result naming the limit; note it, stop. Waiting for
  the reset and resuming is a v2 option - **decision**.
- **Budget cap** / **ended without completing**: note with the cause and the
  session's last result text, stop.
- **Runner itself killed**: the held task keeps its claim; the next run's
  preflight lists `in_progress` tasks of the batch and refuses until `--resume`.

## Measurement plan

- Per task: orchestrator = `slice_metrics.py <uuid>.jsonl --json` (main
  transcript only); agents = `slice_metrics.py <uuid>/subagents/*.jsonl --json`.
  Report `usd`, `reread_tokens`, `max_context` for each, and the orchestrator
  share. The json result's own cost/usage fields are logged for cross-check.
- Baseline: the 2026-09-24 session (~$9 / ~$23, peak 312k) per task, same script.
- `/usage` before/after the batch (owner reads it): `usd` is only a proxy.
- Control telling the arms apart: orchestrator `max_context` per task stays far
  below 312k and does not grow with position in the batch (baseline grows).
- Batch: 3-4 small tasks including one with a design slice, to exercise the
  pause and resume - **owner picks**.
- Smoke run first (~cents): one `claude -p` with a trivial prompt to confirm the
  json result's field names, `CLAUDE_CODE_SESSION_ID == --session-id`, that the
  Stop hook fires in `-p`, and whether `-p` waits for background subagents.

## What changes

- `src/cli/runBatch.ts`, `src/cli/runBatch.test.ts` (new); `package.json`
  (`bin` `task-tracker-run`, script `run-batch`); a usage section in docs.
- After approval and the measurement: `~/.claude/CLAUDE.md` "Token economy":
  "One session per batch" becomes "One session per task: run an approved batch
  with `task-tracker-run`; the tracker carries state". Not in this task's code.

## Must confirm (owner)

1. Runner pulls `get_next_task` itself and claims for the session (vs the
   session pulling it).
2. Permission option A (`auto`) with the deny list.
3. `NEEDS_OWNER:` handoff-note convention now; a tracker `needs_owner` state as
   a separate task (yes/no).
4. On a pause, stop the whole loop (proposed) rather than continue with other
   unblocked tasks.
5. No automatic retry; usage limit stops (no wait-and-resume in v1).
6. The batch to measure on, and approval of the ~cents smoke run.
7. Timeout 4 h and a per-session `--max-budget-usd` value.

## Risks

- If `-p` exits when the main turn ends, a backgrounded slice is orphaned; the
  prompt forbids backgrounding, the smoke run confirms.
- The model may still ask in text and end: "ended without completing", safe
  but costs a resume. Concurrent interactive work on the repo/batch is caught by
  the git checks, not prevented.
- A fresh session re-reads CLAUDE.md, skills and `get_task` every task: a fixed
  per-task cost that the measurement must show is smaller than the saved growth.
- `auto` classifier behaviour on long autonomous runs is unmeasured here.
