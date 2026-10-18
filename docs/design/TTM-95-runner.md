# TTM-95: a batch runner, one fresh session per task

Status: round 2 (2026-10-18), awaiting owner review. Round 1 (2026-10-04) was
declined because a `claude -p` session cannot ask the owner anything; this
round removes that blocker by running each task in an interactive background
session (`claude --bg`) instead of `-p`. Sections marked **[changed]** differ
from round 1; the rest is round 1 kept as still valid.

## Why round 1 was declined (kept)

In `claude -p` every owner question became a stop: a `NEEDS_OWNER:` handoff
note, the loop halted, and the owner answered later from a terminal with
`--resume ... --owner-says`. Questions that come up mid-task (design reviews,
scope changes, stop-and-ask cases) waited until the owner next looked at a
terminal, and they were not the interactive form (AskUserQuestion) the owner's
rules require.

Settled then and still true:
- The runner targets only the orchestrator's context growth; subagents are
  already fresh per slice, and inside each task the orchestrator still slices
  and delegates as today.
- A session cannot start another orchestrator session; the runner is an
  external process the owner starts. Running `claude` from an agent's Bash would
  keep the parent waiting and growing.
- The no-automation fallback: one task per session, the owner starting a fresh
  session that picks up via `get_next_task`.

## Goal

Work one approved release batch unattended, task by task, each task in a fresh
session, so the orchestrator's context starts near zero for every task instead
of growing to 312k over the batch (2026-09-24: orchestrator ~$9 of ~$32, 29%).
The tracker carries all state between sessions. When a task needs the owner,
the question waits as the normal interactive form and the owner answers it
whenever they come back; the runner then carries on. The loop stops cleanly,
saying why, on exhaustion, a draft/drifted plan, or a failure.

## Round 2: how an owner question reaches the owner [new]

Installed: Claude Code 2.1.302. Sources: `claude --help`, `claude agents --help`,
the docs pages cited, and the experiments below.

| # | Candidate | How it works | Benefit | Risk | Confirmed? |
|---|---|---|---|---|---|
| 1 | **`claude --bg` session per task** (recommended) | The runner starts each task as `claude --bg "<prompt>"`: a full interactive session with no terminal attached. AskUserQuestion shows the form and waits with no timeout. `claude agents --json` reports `state: blocked`, `status: waiting`, `waitingFor: "input needed"`. The owner answers in agent view (`claude agents`, the session shows "Needs input") or `claude attach <id>`; the session continues by itself | the question is the real form; no resume, no `--owner-says`; the runner sees "waiting" with a free `claude agents --json` call; the session's context is still fresh per task | the owner must open agent view to see it (a desktop notification fires only while agent view is open); `--max-budget-usd` is `-p` only, so no per-session dollar cap; `--session-id` is ignored with `--bg`; an idle session is stopped by the supervisor after ~1 h unattached, so the runner must notice "done" itself | **yes**: experiment (d) |
| 2 | Remote Control on top of 1 (phone) | `/config` "Push when actions required" pushes permission prompts and questions to the mobile app; the form stays open until answered (docs: code.claude.com/docs/en/remote-control) | answer from the phone, away from the desk | needs the computer on; combining Remote Control with `--bg` is not documented | read only; needs the owner's phone to test |
| 3 | Runner's own notification | when a session turns `blocked`, the runner fires a macOS notification (`osascript -e 'display notification ...'`) and prints the line | works without agent view open; no Claude feature needed | desktop only; the owner must be near the machine | not run (standard macOS command) |
| 4 | `-p` + PreToolUse hook `defer` on AskUserQuestion | docs (code.claude.com/docs/en/hooks, "Defer a tool call for later"): `-p` exits with the question deferred; later `claude -p --resume <sid>` and the hook returns `allow` with the answers in `updatedInput` | keeps `-p` (budget cap, json result) | the answer still needs a channel and a resume; only when the turn makes a single tool call; `--permission-prompts none` removes AskUserQuestion entirely | read only |
| 5 | Agent SDK / `--input-format stream-json` host answering via `canUseTool` | the host receives `AskUserQuestion` input and returns `answers` | full programmatic control | the runner becomes a UI: it must render the form somewhere (terminal or board); stream-json routing of questions is undocumented; a third-party report says headless answers came back empty | read only |
| 6 | MCP-side question queue on the board | an `ask_owner` tracker tool stores the question; the owner answers on the dashboard; the session polls or ends and is resumed | the board shows every waiting question across projects | needs a writable dashboard (today GET-only, `src/dashboard/server.ts`), a new table, and either a long-blocking MCP call (tool timeouts) or a resume; not the AskUserQuestion form | design only |
| 7 | Continue other tasks while one waits | the runner skips a blocked task and starts the next unblocked one | no idle time | two sessions in one checkout fight over branches (the release-branch merge step); needs one worktree per task | design only; v2 |

**Recommendation: 1, with 3 as the alert, and 2 as an owner-side opt-in.**
The session keeps asking through the normal form; the runner only watches
`claude agents --json` and the tracker, and waits while a session is blocked
(no parallel tasks in v1, 7 is v2).

## Experiments (round 2) [new]

Scripts and logs: `/private/tmp/claude-502/-Users-Valentin-Taiurskii-Projects-ClaudeProjects/97de4f20-a078-4dd6-8fcd-7b3a9396ede9/scratchpad/ttm95/`
(`experiments.sh`, `experiments2.sh`, `experiment-d.sh`, `summary*.txt`). All
runs `--model haiku`; total cost under $0.05.

(a) **`CLAUDE_CODE_SESSION_ID` equals `--session-id` (in `-p`): confirmed.**
`claude -p 'Run the bash command ./sid.sh ...' --session-id b2d6581a-... --allowedTools 'Bash(./sid.sh)' --permission-prompts none`
-> `result: SID=b2d6581a-c8ec-4682-9946-3da410f6ed36`. The Stop hook's env and
its stdin `session_id` carry the same value. (An inline `echo "$CLAUDE_CODE_SESSION_ID"`
was denied under `--permission-prompts none` as an unverifiable expansion, hence
the script.) Under `--bg` it does not apply: `--bg` prints
`warning: --bg manages the session id; ignoring --session-id`; the uuid is
`sessionId` in `claude agents --json`.

(b) **The Stop hook fires under `-p`: confirmed.** A `--settings` Stop hook
appended its stdin to a log: `{"session_id":"1342f9bd-...","hook_event_name":"Stop",
"stop_hook_active":false,"background_tasks":[],...}` and `env_sid=1342f9bd-...`.

(c) **`-p` waits for background subagents: confirmed.** The prompt launched one
`run_in_background` subagent running `./slow.sh` (`sleep 45; date > c-marker`)
and ended its turn. `-p` exited after 58 s (`real 57.28 user 5.12`, so it was
waiting, not working); the marker was written 5 s before exit; the final
`result` was the main session's reply after the completion notification
("Вывод ./slow.sh: slept"); `subagent_stats: {started_in_background: 1,
completed: 1, killed: {parent: 0}}`. In the first, failed attempt the Stop
hook fired twice (once per main-session turn end). Round 1's rule "forbid
backgrounding" is not needed.

(d) **A `--bg` session holds AskUserQuestion and reports it: confirmed.**
`claude --bg --model haiku -n ttm95-probe-d 'Use the AskUserQuestion tool once ...'`
(run from this worktree; the scratch dir failed with "Workspace not trusted").
After 45 s, `claude agents --json`:
`{"id":"b585fca4","kind":"background","sessionId":"b585fca4-3189-...","name":"ttm95-probe-d","status":"waiting","waitingFor":"input needed","state":"blocked"}`;
`claude logs b585fca4` showed the form ("Probe: pick one", 1. Alpha, 2. Beta,
"Enter to select"). The session started in auto mode. `claude stop` takes the
id, not the name (`stop ttm95-probe-d` -> "No job matching"); `claude stop
b585fca4` -> `stopped`, then `state: stopped`.

## Language: TypeScript, in this repo (`src/cli/runBatch.ts`) (kept)

- The runner calls the tracker's domain functions on the same DB
  (`openDatabase`, `getNextTask`, `getTaskDetail`, `releaseTask`,
  `addHandoffNote`, `renewLease`), as `src/cli/status.ts` does.
- Testable with vitest via `CLAUDE_BIN` pointing at a fake `claude` that answers
  `--bg`, `agents --json` and `stop`; no test spends usage.

## Loop shape [changed: `--bg` + watch instead of a blocking `-p`]

```
runBatch(project, release, repo, opts):
  preflight: claude --version; repo clean; HEAD == release-<version>;
             plan approved; no in_progress task of the batch unless --resume
  loop:
    r = getNextTask(db, project, release)               # runner picks, no model turn
    if r.task == null: stop(r.reason, r.blocked_on/drift)
    if r.plan_status != "approved" or r.doc_drift: releaseTask; stop(...)
    id = spawn(claude --bg -n "<CODE> runner" <flags> PROMPT(task))  # parse "backgrounded · <id>"
    sid = agentsJson()[id].sessionId
    watch every 30 s (script poll, no model cost):
      a = agentsJson()[id]; t = getTaskDetail(task.id)
      if t.status == done and a.status in (idle, waiting-for-prompt) : claude stop id; checks; next
      if a.state == blocked: first time -> notify owner (print + osascript), log since;
                             renewLease(task, sid) each poll   # 30-min lease must not lapse while waiting
                             (wall timer paused)
      if a.state in (failed, stopped) or a missing: note under sid; stop
      if working time > timeout: claude stop id; note; stop
    after done: git clean and HEAD == release branch, else stop
```

Changed from round 1: the session claims its own task (`claim_task` with
`$CLAUDE_CODE_SESSION_ID`), because `--bg` ignores `--session-id` and the runner
learns the uuid only after spawn. No release is needed in between: `handOut`
(`src/domain/status.ts`) writes `owner_session_id = NULL` for a pending task
with a fresh lease, and `claimTask` (`src/domain/lifecycle.ts`) refuses only
when another *non-null* owner holds a live lease. The lease meanwhile keeps
other pickers off the task while the session starts.

Detecting "task finished": the DB (`status == done`) is the truth; the session
state only says when it is safe to stop it. A session that goes idle without a
done task and without a pending question ("ended without finishing") is
treated as: notify the owner like a question (they may want to talk to it),
and stop the loop after a grace period (**decision**: grace length).

## Per-iteration prompt [changed]

```
Batch runner session: the owner is not watching live, but will answer
AskUserQuestion forms when they come back; ask through the form as usual and
wait. Work exactly one task: <CODE> "<title>", release <version> of project
<PREFIX>. First claim_task(<CODE>, session_id = $CLAUDE_CODE_SESSION_ID).
Follow ~/.claude/CLAUDE.md and the slice-task skill as the orchestrator: run its
remaining slices with one fresh subagent each, task branch off release-<version>,
merge into release-<version>, set_task_release, complete_task, and leave the
checkout clean on release-<version>. Do not call get_next_task and do not start
another task. Never push, never touch main. The approved plan covers commits on
the task branch and the merge. When the task is complete, say DONE and stop.
```

Removed: the `NEEDS_OWNER:` handoff-note protocol, `--owner-says`, and the
"never background" rule (experiment c). The convention survives only as the
fallback for a session that ends without finishing.

## Stop conditions [changed]

| Event | Detected by | Runner does |
|---|---|---|
| batch done | `getNextTask` -> `all_done` | summary, exit 0 |
| all blocked | -> `all_blocked`, `blocked_on` | summary lists codes, exit |
| plan draft/drifted | -> `plan_not_approved` (+`drift`) | summary, exit |
| doc drift | `doc_drift: true` on a hand-out | `releaseTask`, summary, exit |
| owner question | `state: blocked`, `waitingFor: input needed` | **not a stop**: notify, renew lease, wait |
| permission prompt | `waitingFor: permission prompt` | same as a question (the owner approves in agent view) |
| ended without finishing | idle, task not done, no question | notify; stop after grace; runner note under `sid` |
| crash / usage limit | `state: failed`/`stopped`, or session missing | runner note with the cause, exit |
| timeout (working time) | timer excluding blocked time | `claude stop`, note, exit |
| dirty tree / wrong branch after done | `git status`, `git rev-parse` | summary, exit |

Every stop prints: cause, task code, session id, `claude attach <id>`, log path.

## Permissions [changed]

`claude --bg --permission-mode auto -n "<CODE> runner" --disallowedTools "Bash(git push*)" "mcp__task-tracker__delete_task"`
plus deny patterns for `main`. `--permission-prompts none` must not be used:
it removes AskUserQuestion (docs: headless, "turn off permission prompts").
With `--bg` a classifier denial no longer kills the task: an ask becomes a
`permission prompt` the owner can answer. `--dangerously-skip-permissions`
stays rejected.

## Logs (kept, adjusted)

`~/.task-tracker/runs/<PREFIX>-<version>-<UTC stamp>/`: `runner.log` (spawn,
state changes with timestamps, blocked/answered intervals, stops), `summary.md`
per task: outcome, wall time, time blocked on the owner, session uuid,
transcript `~/.claude/projects/<slug>/<uuid>.jsonl`, `slice_metrics.py --json`
of the transcript and of `<uuid>/subagents/`. No json result exists under
`--bg`; cost comes from the transcripts only.

## Failure handling (kept, adjusted)

- No automatic retry in v1 (a retry re-runs slices whose state a crash may have
  half-written).
- Usage limit: the session shows it and goes idle/failed; note and exit.
  Wait-for-reset is v2 - **decision**.
- No per-session dollar cap under `--bg` (`--max-budget-usd` is `-p` only); the
  working-time timeout is the only cap - **decision**: accept, or keep `-p`
  for tasks with no design slice.
- Runner killed: the `--bg` session keeps running (it is supervised by Claude
  Code, not the runner); `--resume <CODE>` re-attaches the watch by finding the
  session by name in `claude agents --json`.

## Measurement plan [changed: which batch]

Metrics (kept): per task, orchestrator = `slice_metrics.py <uuid>.jsonl --json`,
agents = the same over `<uuid>/subagents/*.jsonl`; report `usd`,
`reread_tokens`, `max_context`, and the orchestrator share. Baseline: the
2026-09-24 single session (~$9 / ~$23, peak 312k), same script. Control that
tells the arms apart: orchestrator `max_context` per task stays far below 312k
and does not grow with position in the batch (the baseline grows). `/usage`
before/after is the owner's cross-check. Time blocked on the owner is logged
and excluded from wall-time comparisons.

Which batch, given 0.14.0 may be the only one in flight and its other tasks are
already being worked in parallel:
- **A (proposed)**: after TTM-95's code merges into release-0.14.0, the owner
  creates a small follow-up batch (3-4 small backlog tasks, one with a design
  slice so a question gets exercised) and runs it with the runner. Cost: those
  tasks wait for TTM-95.
- B: run the runner on whatever 0.14.0 tasks are still pending when TTM-95
  lands. Cost: may be zero or one task, too few to show a trend.
- C: re-run an already-done small batch on a throwaway branch. Cost: real
  money for work already done; not proposed.

Smoke run before the batch (~cents): one `--bg` task that asks one question,
to check the watch loop end to end (spawn, blocked, answered, done, stop).

## Edit map for the code slice [new]

- `src/cli/claudeBg.ts` (new): `spawnBg(args) -> id` (parses `backgrounded · <id>`),
  `listAgents() -> AgentEntry[]` (`claude agents --json --all`), `stopBg(id)`;
  `CLAUDE_BIN` override for tests.
- `src/cli/runBatch.ts` (new): preflight, loop, watch, stop table, logs,
  `--resume <CODE>`, `--timeout`, `--poll` (default 30 s), `--dry-run` (print the
  hand-out and the command, spawn nothing).
- `src/cli/runBatch.test.ts`, `test/fixtures/fake-claude` (new): a fake binary
  driven by a script file (states over time).
- `src/domain/taskStatus.ts`: reuse `renewLease`; no change expected.
- `package.json`: `bin` `task-tracker-run`, script `run-batch`.
- `README.md`: a "Batch runner" usage section.
- After measurement and owner approval: `~/.claude/CLAUDE.md` token-economy
  rule (outside this repo).

## Behaviours tests must pin

1. Plan not approved / drifted / all_done / all_blocked -> exit with that
   reason, nothing spawned.
2. After the runner's hand-out, a claim under a new session uuid succeeds and
   the task's `owner_session_id` becomes that uuid.
3. `blocked` + `input needed` is not a stop: notifies once, renews the lease
   each poll, does not count toward the timeout.
4. Task `done` in the DB -> `stopBg(id)` and the next task is picked.
5. Session idle, task not done, no question, past the grace -> stop with a
   runner note under the session's uuid.
6. Session `failed`/`stopped`/missing -> note with the cause, exit.
7. Working-time timeout -> `stopBg` and exit.
8. Dirty tree or wrong branch after a done task -> exit, no next spawn.
9. Preflight refuses an `in_progress` batch task without `--resume`.
10. `--bg` args never contain `--permission-prompts none` and always carry the
    deny list.

## Candidate control reverts

- Runner claims the task under its own id before spawn -> test 2 fails
  (the session's claim is refused with TaskConflictError).
- Treat `blocked` as a stop -> test 3 fails.
- Remove `renewLease` in the blocked branch -> test 3's lease assertion fails.
- Count blocked time toward the timeout -> test 3/7 fail.
- Decide "done" from session state instead of the DB -> test 5 fails (idle
  without done would advance).
- Skip the git check after done -> test 8 fails.
- Add `--permission-prompts none` to the spawn args -> test 10 fails.

## Must confirm (owner)

1. `--bg` session per task, owner answers in agent view, runner waits while a
   question is open (recommended), vs. the round-1 `-p` + resume.
2. How the owner wants to be alerted: runner's macOS notification (proposed),
   Remote Control push to the phone (owner enables it; untested with `--bg`), both.
3. No per-session dollar cap under `--bg`; working-time timeout (4 h) only.
4. Grace before "ended without finishing" stops the loop (proposed 15 min).
5. Measurement batch: option A.
6. Permission option: `auto` + deny list (kept from round 1).

## Risks

- `--bg` and `claude agents --json` field names are not a stable API; a Claude
  Code update can rename `state`/`waitingFor`. The fake-binary tests pin the
  runner, not Claude Code; the smoke run re-checks after updates.
- The owner may not notice a waiting question for hours; the batch simply
  pauses (cost: time, not money). The lease renewal keeps the task held.
- Background sessions left in agent view: the runner stops each finished
  session; `claude rm` is not used (it may delete a worktree).
- A fresh session re-reads CLAUDE.md, skills and `get_task` every task: a fixed
  per-task cost the measurement must show is smaller than the saved growth.
- `auto` classifier behaviour on long autonomous runs is unmeasured.
