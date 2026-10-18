# TTM-99: name the "everything is held" answer

Status: draft for owner review, 2026-10-18.
Branch `docs/TTM-99-held-tasks-design`, off `release-0.14.0`.

## Problem

When get_next_task has nothing to hand out, `exhausted()`
(src/domain/status.ts:242-254) answers `all_done` if the pool has no unfinished
task, and otherwise `all_blocked` with `blocked_on` = the pending tasks it
passed over for unmet dependencies. A task in_progress under a live lease is
never in `blocked_on` (it is not pending), so a pool where every remaining task
is held by a worker answers:

```json
{ "task": null, "reason": "all_blocked", "blocked_on": [], "doc_drift": false,
  "plan_status": "approved" }
```

The form is accurate, but "blocked" reads as a dependency problem. The caller
must infer "everyone is busy, wait for your agents" from an empty list, and it
cannot see which tasks are held or when their leases run out. Since TTM-98 a
fully held plan step yields nothing instead of re-handing out a held task, so
an orchestrator running a parallel step meets this answer on every extra call.

Today's tests pin exactly this: tests/status.test.ts:195-206 ("does not
reclaim ... before its lock expires", `all_blocked`) and :402-424 ("never
re-hands out a task under a live lease ...", `all_blocked`, `blocked_on: []`).

### What is in the pool when `exhausted()` runs

Remaining = pending + in_progress (TaskStatus has no stored `blocked`).
At that point:

- every pending task in the pool has an unmet dependency (an unblocked one
  would have been handed out), and both pickers pass all of them as
  `skipped` - pickByPriority its whole pending list, pickByPlan every
  pending task of every step, since it walked them all;
- every in_progress task has a live lease (or, legacy only, a NULL one):
  a lapsed lease would have been reclaimed first (pickByPriority's reclaim
  query; pickByPlan's per-step `reclaimable`, which covers the whole batch
  because an unplanned or orphaned task is drift and was refused earlier).
  Every writer of `in_progress` sets a lease (status.ts:182 handOut,
  lifecycle.ts:110 claimTask, slices.ts:493 startSlice), so NULL appears only
  on rows older than the lease.

So `blocked_on.length + held.length == remaining` exactly: the two lists
partition the unfinished work.

## Options

**A. New reason `all_held` only.** `exhausted()` returns
`{ reason: "all_held" }` when there is no blocked task. Names the state, but
the mixed case (some held, some blocked) still says only `all_blocked`, and the
caller still cannot see what is held or until when. Fails the acceptance line
"a mix of held and dependency-blocked tasks reports both".

**B. `held` field only.** Keep `reason: "all_blocked"` and add
`held: [{ id, code, lock_expires_at, owner_session_id }]` beside `blocked_on`.
Fully backward compatible and covers the mixed case, but the all-held case
still reads "blocked"; the explicit name is a convention the caller must know
(`blocked_on` empty and `held` non-empty).

**C. Both (recommended).** `held` on every exhausted-but-not-done answer, and
the reason picks the actionable word:

- `all_held` when `blocked_on` is empty (then `held` is non-empty, by the
  partition above): wait for the holders;
- `all_blocked` when at least one pending task is blocked, with `held` listing
  whatever else is in progress (possibly `[]`): something needs unblocking,
  and `held` says which of the blockers are merely in flight.

```json
{ "task": null, "reason": "all_held", "blocked_on": [],
  "held": [
    { "id": "…", "code": "TTM-97", "lock_expires_at": "2026-10-18T14:02:11.000Z",
      "owner_session_id": null },
    { "id": "…", "code": "TTM-98", "lock_expires_at": "2026-10-18T14:05:40.000Z",
      "owner_session_id": "sess-1" } ],
  "doc_drift": false, "plan_status": "approved" }
```

Mixed (step [A, B] held, C pending on A):
`{ "reason": "all_blocked", "blocked_on": ["<C uuid>"], "held": [A, B] }`.

## Recommendation: C

Benefit: the reason alone tells "wait" from "unblock"; `held` gives the codes
and lease ends, so an orchestrator knows which agents it is waiting for and
when a lapsed one would become reclaimable; the mixed case reports both lists.

Risk: a caller that tests `reason === "all_blocked"` to mean "work remains,
none for me" now sees a new value in the all-held case. Mitigations below; the
cost of B's "no new value" is that the misreading the task exists for stays.

### Shape details

- `held` entries: `{ id, code, lock_expires_at, owner_session_id }`. `id`
  matches `blocked_on`'s uuids (plans.ts drift convention); `code` is what a
  person and the orchestrator use (`TTM-97`); `owner_session_id` is often NULL
  (get_next_task hand-outs leave it NULL, TTM-78) but tells a claim_task
  holder apart. `lock_expires_at` is `string | null` (NULL only on legacy rows).
- Order: `lock_expires_at ASC, created_at ASC` - the soonest lease to lapse
  first, i.e. the first task that would become reclaimable.
- `held` present (possibly `[]`) on both `all_blocked` and `all_held`, like
  `blocked_on` is today; absent on `all_done`, `plan_not_approved` and a
  hand-out. An empty list is a real answer here ("nothing in flight, only
  blocked work"), not a missing report, so the "absent is not zero" habit
  does not apply.
- Held is computed by one scope query in `exhausted()`, with the live-lease
  predicate written out (`lock_expires_at IS NULL OR lock_expires_at >= now`)
  rather than relying on the pickers having reclaimed everything, so a lapsed
  lease can never be reported as held even if a picker changes. The code comes
  from a JOIN on `projects.code_prefix`, so `HandOutScope` needs no new field.

### A lapsed lease

It is reclaimed, not held: whichever picker runs hands it out with
`reclaimed_from` (TTM-78) before `exhausted()` is reached, so a pool with one
live and one lapsed in_progress task answers with a hand-out, never
`all_held`. Between calls a lease can lapse: `all_held` at 14:00, then at
14:03 (after the first `lock_expires_at`) the same call reclaims that task.

### Backward compatibility

- In-repo readers of the reason/`blocked_on` (below): none outside
  src/domain/status.ts and tests/status.test.ts. ~/.claude/hooks/*.sh: no
  match for `all_blocked` or `blocked_on`.
- `task: null` is unchanged in every case, so `task === null && reason !==
  "all_done"` (the robust "work remains" test) keeps working.
- `blocked_on` keeps its meaning and presence; `all_blocked` keeps its
  meaning in every case that had a blocked task. Only the all-held case
  (previously `all_blocked` + `blocked_on: []`) changes its reason.
- Real callers are LLM sessions reading the tool description; the
  description gains one sentence for `all_held`/`held`.

## Cross-file facts relied on

- Callers of `exhausted`: `pickByPriority` and `pickByPlan` only
  (g-mesh `find_callers exhausted`, complete, both in src/domain/status.ts).
- References to `getNextTask`: src/mcp/tools/status.ts (the get_next_task
  tool) plus tests doc-sync, lifecycle, ownership, session-end, status
  (g-mesh `find_references getNextTask`, files view, total 6). No CLI
  (src/cli), board (src/domain/board.ts) or dashboard reference.
- `GetNextTaskResult` is referenced only by `getNextTask` (g-mesh
  `find_references GetNextTaskResult`).
- Text readers (grep, non-code): `all_blocked`/`blocked_on` appear in
  src/domain/status.ts, tests/status.test.ts (16 lines),
  docs/architecture/task-tracker-mcp.md:371, REQUIREMENTS.md:374-375,
  docs/design/TTM-78-lease.md:99 and TTM-100-session-end.md:151 (history,
  left as is). The tool description (src/mcp/tools/status.ts:14) does not
  mention either today.

## Edit map

Change (1-based lines, release-0.14.0):

- src/domain/status.ts:81-85 - add exported `HeldTask` next to `ReclaimedFrom`.
- src/domain/status.ts:87-102 `NextTaskOutcome` - `all_blocked` gains
  `held: HeldTask[]`; add `{ task: null; reason: "all_held"; blocked_on: [];
  held: HeldTask[] }` (or one variant with `reason: "all_blocked" |
  "all_held"`; implementer's call, the narrowing in tests decides).
- src/domain/status.ts:236-254 `exhausted` - take `nowIso`; query held tasks
  (JOIN projects for the code, live-lease predicate, order above); choose the
  reason; update the doc comment.
- src/domain/status.ts:296 (`pickByPriority`) and :408 (`pickByPlan`) - pass
  `nowIso` to `exhausted`.
- src/domain/status.ts:335-341 (`pickByPlan` comment, "same
  all_done/all_blocked") and :417 (`getNextTask` comment) - name `all_held`.
- src/mcp/tools/status.ts:14 - one sentence: when nothing can be handed out,
  `reason` is `all_done`, `all_blocked` (`blocked_on` lists pending tasks
  waiting on a dependency) or `all_held` (every remaining task is in progress
  under a live lease: wait for the holders); `held` lists in-progress tasks
  with `code` and `lock_expires_at` on both.
- docs/architecture/task-tracker-mcp.md:371 - signature line.
- tests/status.test.ts:195-206 and :402-424 - expected reason becomes
  `all_held` (these are the tests that pin today's behaviour).

Read for context: `pickByPriority` (status.ts:266-297), `pickByPlan`
(:347-409, comment from :320), `reclaim` (:211-219), `taskCode`
(src/domain/tasks.ts:60), `listTasks` (status.ts:493-536, existing
`code: taskCode(prefix, …)` use), test helper `planWithSteps` in
tests/status.test.ts.

## Behaviours the tests must pin

1. Unscoped, every remaining task in_progress under a live lease ->
   `all_held`, `blocked_on: []`, `held` names them by code with their
   `lock_expires_at`.
2. Plan path, whole step held, nothing later -> `all_held` (the TTM-98 case).
3. Mixed: held step + later task blocked on a held one -> `all_blocked`,
   `blocked_on: [C]`, `held: [A, B]`.
4. Only dependency-blocked work, nothing in progress -> `all_blocked`,
   `held: []`.
5. One live and one lapsed in_progress task -> hand-out with
   `reclaimed_from`, not `all_held` (lapsed is reclaimed, not held).
6. `held` is ordered by `lock_expires_at` ascending.
7. Batch scope: a held task outside the batch is not in `held`.
8. `all_done` carries no `held`.

## Candidate control reverts

- `exhausted` always returns `all_blocked` (drop the reason choice) -> 1, 2 fail.
- `held` hard-coded to `[]` -> 1, 3 fail.
- Live-lease predicate dropped from the held query, and pickByPriority's
  reclaim branch skipped -> 5 fails by reporting the lapsed task as held
  (the predicate on its own is defence in depth; 5 pins the ordering of
  reclaim before exhausted).
- `ORDER BY` reversed (`DESC`) -> 6 fails.
- Held query uses `project_id` regardless of scope -> 7 fails.
- Reason chosen by `held.length > 0` instead of `blocked_on.length === 0`
  -> 3 fails (mixed would read `all_held`).

## Open for the owner

- `blocked_on` stays uuids while `held` carries codes too. Converting
  `blocked_on` to codes is a separate, breaking change; not proposed here.
- Whether a blocked task whose blocker is held should be flagged as "will
  unblock by itself" is left to the caller (it has both lists); not proposed.
