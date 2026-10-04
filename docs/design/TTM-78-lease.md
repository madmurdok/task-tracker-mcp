# TTM-78: a lease that outlives long tasks

Status: approved with changes by the owner, 2026-10-04 (see "Owner decision").
Branch `fix/TTM-78-lease-outlives-long-tasks`.

## Owner decision (2026-10-04)

1. Reclaim: **R1, not R2** - keep automatic reclaim, but mark it so the
   receiving agent checks before continuing ("выдача с пометкой чтобы агент
   проверил"). get_next_task's answer for a reclaimed task carries
   `reclaimed_from: { owner_session_id, lock_expires_at, last_activity_at }`
   and the tool description tells the caller to confirm the previous holder is
   gone (its agent finished or died, its branch idle) before working on it.
   Both paths (unscoped and plan walker) report it the same way; their
   ordering difference stays and stays documented in `pickByPlan`.
2. Lease 2 h: accepted.
3. `add_handoff_note` does not renew: accepted.
4. A SessionEnd hook that releases a session's tasks: a separate task, in this
   batch, after TTM-78.

Sections below that describe R2 (`reclaimable`, no silent reclaim) are
superseded by point 1.

## Problem

`LOCK_LEASE_MS` (src/domain/taskStatus.ts:11) is 30 minutes. Three writers stamp
`lock_expires_at = now + 30 min` and nothing ever renews it:
get_next_task's `handOut`, `claimTask`, and `startSlice` on a still-pending task.
Any task that runs longer than 30 minutes therefore:

1. shows a "stale lock" badge on the board (`isStale`, board.ts:136, documented as
   "session likely died"), and
2. becomes a reclaim candidate: get_next_task hands it to the next caller with
   the owner cleared (`pickByPriority`'s reclaim branch, status.ts:215-231;
   `pickByPlan`'s lapsed-lease branch, status.ts:323-333) while the first worker
   is still writing to its branch.

## Evidence (tracker DB, read-only, 2026-10-04)

- Slice duration (`completed_at - started_at`, 373 slices): p50 20.3 min,
  p75 37.8, p90 72.8, p95 121.6, max 1254 (overnight). 132 of 373 (35%) exceed
  30 min. By phase, slices over 30 min: design 12/45, implement 55/163,
  measure 31/57, verify 34/108.
- Longest gap between consecutive slice events (start or complete) per task,
  103 tasks: <=30 min 44, 30-60 min 25, 60-120 min 8, >120 min 26.
  So even a perfect heartbeat on slice calls leaves 57% of tasks with a gap
  longer than today's lease, and 25% with a gap longer than two hours.
- Live right now: TTM-77 (being verified) had its lease lapse at 11:28Z
  mid-verify; GOO-16 has been in_progress under a lapsed lease since
  2026-08-30 (a genuinely dead session); GM-329 lapsed this morning.
- The >2 h gaps are mostly paused sessions (usage limit, overnight, waiting on
  the owner), which later resume the same task. Elapsed time cannot tell a
  paused session from a dead one.

What evidence of death exists besides time? `owner_session_id` (set by
claim_task only; get_next_task hand-outs leave it NULL, and subagents share the
parent's id, so it names a session, not a worker), `tasks.updated_at`,
`task_slices.started_at/completed_at`, `handoff_notes.created_at`. All of them
are still time. The only non-time signal would be an explicit end-of-session
event (a SessionEnd hook calling release_task); out of scope, noted below.

## Options

| Bet | Gain | Cost / risk |
|---|---|---|
| H. Heartbeat: renew the lease as a side effect of task-scoped writes the orchestrator already makes | Zero new calls; live workers stop looking dead between slices | Covers only gaps between calls; a single long slice (p90 73 min) still lapses |
| L. Longer lease | One constant | Any number is either too short for paused sessions or too long for dead ones; delays takeover of a dead task |
| R1. Report reclaim: keep auto-reclaim, add `reclaimed_from` to the answer | Visible | Still hands the task out; the receiving agent usually proceeds anyway |
| R2. No silent reclaim: get_next_task never hands out a held task; it lists lapsed ones as `reclaimable`, takeover is an explicit `claim_task` | Double hand-out needs a deliberate act; makes plan walker and unscoped path identical | A dead session's task is no longer picked up automatically; someone must claim it |

## Recommendation

**(a) Stale badge: H + L.** Renew on activity, lease 2 h.
- Heartbeat writers: `start_slice` (any task status, not just pending),
  `complete_slice`, `set_task_slices`, `revise_task_slices`, `claim_task`
  (already does). Renewal is `lock_expires_at = MAX(lock_expires_at, now+lease)`
  guarded by `status = 'in_progress' AND lock_expires_at IS NOT NULL`: never
  shortens a lease, never creates one on a legacy NULL-lease row, never touches
  a done/cancelled task. It renews an already-lapsed lease too: activity after
  a lapse proves the worker is alive (a resumed session).
- NOT a heartbeat: `add_handoff_note` (per CLAUDE.md and the Stop hook it is the
  last act of a stopping session; renewing would hide exactly the dead task),
  `get_task` and other reads (a read that writes is a surprise).
- 2 h is justified by p95 slice duration (121.6 min): with the heartbeat, the
  lease must outlast one slice, and 2 h covers 95% of them. Beyond it the badge
  is honest: no tracker activity for 2 h.
- Badge wording changes from "stale lock" / "session likely died" to
  "no activity since HH:MM" (title attribute keeps the lease time) - it is a
  signal for a human, not a verdict.

**(b) Reclaim: R2 (recommended), decided separately from (a).** With 25% of
tasks showing >2 h gaps that are mostly paused-and-resumed sessions, any time
threshold keeps double-handing-out live work; only an explicit act removes it.
- `get_next_task` (both paths) treats an in_progress task as held whatever its
  lease. It adds `reclaimable?: ReclaimableTask[]` (absent when empty, per the
  project's "absent is not zero" habit) listing in_progress tasks in the pool
  whose lease lapsed: `{ id, code, owner_session_id, lock_expires_at,
  last_activity_at }`. Present alongside a handed-out task as well as on
  all_blocked, so a session sees abandoned work even when other work exists.
- Takeover is `claim_task`, which already allows claiming over a lapsed lease
  (`isLockActive`, lifecycle.ts:53) and already conflicts on a live one. No
  change to claim_task's rules.
- Alternative R1+H+L (if the owner wants automation kept): auto-reclaim stays,
  answer gains `reclaimed_from`. Still double-hands-out the >2 h gap tasks.

A worker that never heartbeats is no worse than today on (a) (lease 2 h vs
30 min, badge later) and strictly safer on (b) (its task is never silently
re-issued). It is worse in one respect: if it dies, its task waits for an
explicit claim instead of being auto-reissued. That is the R2 trade-off.

## Plan walker vs unscoped path

Under R2 both paths stop reclaiming, so they become consistent by
construction: in each, an in_progress task is held and contributes no
candidate; each reports lapsed ones in `reclaimable`. The only remaining
difference is the order of that list: plan position in `pickByPlan`, oldest
lease first in `pickByPriority` - each path's own order, documented at the
field. The TTM-98 "pending before reclaim within a step" rule becomes moot and
its doc comment is rewritten (a step with only held tasks yields nothing, as a
fully live-leased step does today). Under R1 the existing difference (plan
walker reclaims a step-1 task before pending step-2 work; unscoped drains
pending first) stays and is already documented in `pickByPlan`'s comment.

## What changes

1. taskStatus.ts: `LOCK_LEASE_MS = 2 h`; doc comment updated; new
   `renewLease(db, taskId, nowIso)` beside it (leaf module, so slices.ts and
   lifecycle.ts can use it without importing status.ts).
2. slices.ts: startSlice renews for an in_progress task; completeSlice,
   setTaskSlices, reviseTaskSlices renew.
3. status.ts (R2): drop the reclaim branch from pickByPriority and pickByPlan;
   new `listReclaimable(db, scope, order)`; `GetNextTaskResult.reclaimable`.
   `handOut`'s `ownerSessionId = null` call sites disappear.
4. board.ts: isStale doc rewritten; board.js/style.css wording.
5. Tool descriptions: get_next_task (status.ts:14), start_slice
   (slices.ts:102), claim_task; README.md, docs/architecture/task-tracker-mcp.md,
   REQUIREMENTS.md where they describe automatic reclaim / 30 min.

## Must-confirm (owner)

1. R2 (no silent reclaim) vs R1 (reported auto-reclaim). Recommendation R2.
2. Lease 2 h (p95 slice). A longer one only delays the badge further.
3. add_handoff_note excluded from the heartbeat.
4. Out of scope, file separately if wanted: a SessionEnd hook that calls
   release_task, the only non-time death signal available.

## Edit map

Change:
- src/domain/taskStatus.ts:4-11 `LOCK_LEASE_MS` (+ new `renewLease`)
- src/domain/status.ts:64-91 `NextTaskOutcome`/`GetNextTaskResult` (add `reclaimable`)
- src/domain/status.ts:142-144 `withLease`, 146-157 `handOut`
- src/domain/status.ts:204-234 `pickByPriority` (drop reclaim; R2)
- src/domain/status.ts:236-337 `pickByPlan` doc + lapsed branch (R2)
- src/domain/status.ts:355-417 `getNextTask` (attach `reclaimable`)
- src/domain/slices.ts:469-502 `startSlice`, 514-544 `completeSlice`,
  328-354 `setTaskSlices`, 393-451 `reviseTaskSlices`
- src/domain/board.ts:127-138 `isStale` doc; src/dashboard/public/board.js:134-180
- src/mcp/tools/status.ts:14, src/mcp/tools/slices.ts:102 (descriptions)

Read for context: src/domain/lifecycle.ts:53-115 (`isLockActive`, `claimTask`),
:129-170 (`releaseTask`), :255-290 (`completeTask` lease clear), :485-515
(`cancelTask`); tests/ownership.test.ts:33-50; tests/status.test.ts:193-220,
318-400, 579-591; tests/board.test.ts:286.

## Tests

Time is advanced with `vi.setSystemTime`, not by writing `lock_expires_at`,
so the demonstrations exercise the real lease arithmetic.
1. **Lease expires while held (the AC demo).** claim + start slice 1; advance
   past the old lease (31 min), complete slice 1, start slice 2; advance to
   just under 2 h after the last call: board `is_stale` false, get_next_task
   does not hand it out. Control: remove the renewal in completeSlice/startSlice
   and the board test fails.
2. **Lease lapses with an open slice (worker silent > 2 h).** Badge true;
   get_next_task (unscoped and plan) does not hand it out and lists it in
   `reclaimable` with `owner_session_id` and `last_activity_at`. Control:
   restore the reclaim branch and the "not handed out" assertion fails.
3. **Genuinely dead session still reclaimable.** session-1 claims, goes
   silent, time passes the lease: `reclaimable` lists it, `claim_task` by
   session-2 succeeds and becomes owner (rewrites ownership.test.ts:33).
   And before the lease lapses, session-2's claim throws TaskConflictError.
4. Renewal never shortens (a lease further out survives a heartbeat), never
   creates one on a NULL-lease in_progress row, never touches done/cancelled.
5. add_handoff_note and get_task do not move `lock_expires_at`.
6. Resumed session: activity after a lapse renews and clears `reclaimable`.
7. Plan walker parity: same pool through both paths yields the same hand-out
   and the same `reclaimable` set (orders per path).
8. `reclaimable` absent (not `[]`) when nothing lapsed; mcp-smoke updated.
9. Existing reclaim tests (status.test.ts:206, 318, 362, 385, 579;
   ownership.test.ts:33) are rewritten to the new contract, not deleted.

## Risks

- R2 changes get_next_task's contract: orchestrators relying on auto-reclaim
  (the "resume from get_next_task's handoff_notes" flow) must now act on
  `reclaimable` with claim_task. Mitigated by the field being on every answer
  and by README/CLAUDE.md wording; needs a line in the owner's CLAUDE.md.
- Abandoned tasks accumulate (GOO-16 since August) if nobody claims or
  cancels them; `reclaimable` keeps them visible rather than hidden.
- start_slice/complete_slice carry no session id, so a heartbeat renews the
  task whoever holds it; a second worker that took over also renews. Harmless:
  renewal only extends.
- Heartbeat adds one UPDATE per slice call; negligible.
- A 2 h lease delays claim_task takeover of a dead task without `force` by up
  to 2 h after its last activity; `release_task force` remains the escape.
