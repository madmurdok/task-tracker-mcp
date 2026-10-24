# TTM-105: one status per task, and dependency links in get_task

Status: approved by the owner 2026-10-24 ("Утверждаю как есть (Recommended)").
Branch `fix/TTM-105-status-agreement`, off `release-0.17.0` at 7c85f52.

## Diagnosis

`blocked` is never stored: the `tasks.status` CHECK allows only
`pending|in_progress|done|cancelled` (src/db/schema.ts:48). It is derived at
read time by `displayStatus` (src/domain/taskStatus.ts:115-118): a stored
`pending` with an unmet dependency (`hasUnmetDependencies`, :83-93, predicate
`UNMET_DEPENDENCY_SQL` = dependency not done/cancelled) reads as `blocked`.

- list_tasks -> `listTasks` (src/domain/status.ts:553-596) maps every row
  through `displayStatus` and filters on the result: derived.
- get_task -> `getTaskDetail` (src/domain/status.ts:173-185) spreads
  `withCode(db, task)`, i.e. the raw row: stored `status`. No dependency
  fields at all (keys: row columns + code, file_paths, handoff_notes,
  amendments, slices, slice_revisions).

Probe (throwaway vitest file, `openDatabase(":memory:")`, deleted after;
real tracker DB untouched): tasks A, B; `addDependency(B, A)`.

```
list_tasks(status:"blocked") = [["DEM-2","blocked"]]
get_task(DEM-2).status       = "pending"
get_project_status           = {"blocked":1,"pending":1,...}
```

This is exactly the GM-436/452/461 report. get_task is the odd one out.

## Decision

The derived status is the truth; get_task adopts it. `blocked` is the only
derived value and every aggregate already counts it, so changing the single
read that does not derive it is the smallest change that makes all reads
agree. `TaskDetail.status` becomes `DisplayStatus`
(`Omit<Task, "status"> & { status: DisplayStatus }`); `getTaskDetail` sets
`status: displayStatus(db, task)`.

Every read that reports a task status (found with g-mesh `find_references`
on `displayStatus`, `hasUnmetDependencies`, `getTaskDetail`, `withCode`,
`withCodes`):

| Read | Code | Status today | Change |
|---|---|---|---|
| list_tasks (+ `status` filter) | `listTasks` status.ts:553 | derived | stays |
| get_project_status / CLI `status` | `aggregateStatus` status.ts:603 via `getProjectStatus`; src/cli/status.ts | derived | stays |
| get_release_status, list_releases | `releaseTaskCounts` -> `aggregateStatus` | derived | stays |
| get_epic_status, list_epics | `epicTaskCounts` -> `aggregateStatus` | derived | stays |
| dashboard board (+ `blocked_by`) | `getBoardData` board.ts:228, `listUnmetBlockers` :158 | derived | stays |
| get_plan items | `listPlanItems` plans.ts:339 | derived | stays |
| get_next_task pick / `blocked_on` | `pickByPriority`, `pickByPlan` -> `hasUnmetDependencies` | derived | stays |
| get_next_task `task` | `handOut` -> `getTaskDetail` | in_progress, same either way | follows get_task |
| claim_task / start_slice guards | `claimTask`, `startSlice` -> `hasUnmetDependencies` | derived (refusal) | stays |
| **get_task** | `getTaskDetail` status.ts:173 | **stored** | **derive** |
| runner (`run-batch`) | `preflight`, `watch`, `releaseIfUnclaimed`, `codeOf`, `runBatch` -> `getTaskDetail` | stored | follows; compares only to in_progress/done/cancelled, so unaffected (a refusal message may now print `blocked`) |
| export_projects / backup | src/domain/backup.ts `SELECT *` | stored | **stays stored**: a backup restores rows, and the CHECK rejects `blocked` |
| create_tasks, complete_task, slices | `withCode` callers | use `code` only | none |

Trade-offs / risks:
- A caller testing `get_task(...).status === "pending"` to mean "not started"
  now misses blocked tasks. In-repo, only the runner reads it, and only for
  the three non-pending values. Same contract as list_tasks has had since
  TTM-97, so external callers already had to handle `blocked`.
- Re-deriving costs one COUNT query per get_task: negligible.
- Rejected: keep stored `status` and add `blocked: true` - the reads would
  still disagree on the `status` field, which is what the AC forbids.
  Rejected: make list_tasks report stored status - breaks the `blocked`
  filter, the aggregates, the board and the plan view.

No owner choice needed on the status rule.

## Dependency fields in get_task

Two new arrays on `TaskDetail`, ordered by code (prefix, then number):

```jsonc
"depends_on": [ { "code": "GM-430", "title": "...", "status": "in_progress", "met": false } ],
"dependents": [ { "code": "GM-470", "title": "...", "status": "blocked" } ]
```

- `depends_on`: every dependency (task_dependencies.task_id = this), met or
  not. `met` = `!UNMET_DEPENDENCY_SQL` (dependency done/cancelled) - the same
  predicate that derives `blocked`, so the task is `blocked` iff it is stored
  `pending` and some entry has `met: false`. Listing met ones too shows the
  whole graph; `met` keeps "what blocks it" a one-glance filter.
- `dependents`: tasks that depend on this one (depends_on_task_id = this).
  No `met`: it would be this task's own completion state.
- `status` of each entry is `displayStatus` of the linked task, so a link
  never contradicts list_tasks either. `code` uses the linked task's own
  project prefix (links may cross projects, as on the board).
- No `id`: get_task and every tool accept a code. Empty arrays when none.
- `blocked_by` was the task's wording; `depends_on` with `met` is used
  because a met dependency does not block. See must-confirm.

## Edit map

Change:
- src/domain/status.ts:142-164 `TaskDetail` - `status: DisplayStatus`
  (via `Omit<Task,"status">`), add `depends_on`, `dependents` + doc comments.
- src/domain/status.ts:173-185 `getTaskDetail` - derived status, the two lists.
- src/domain/taskStatus.ts (leaf module, near :83) - new
  `listDependencyLinks(db, taskId): { depends_on, dependents }`: two
  queries joining `tasks` + `projects` for prefix, `met` computed in SQL from
  `UNMET_DEPENDENCY_SQL`, entry status via `displayStatus`. It must not import
  tasks.ts' `taskCode` if that breaks the leaf rule - inline
  `prefix || '-' || task_number` in SQL, or move `taskCode`; implementer checks.
- src/mcp/tools/status.ts:36-44 `get_task` description - status is derived
  (blocked = pending with an unmet dependency, as in list_tasks), names
  `depends_on`/`dependents`.

Read for context: `displayStatus`, `hasUnmetDependencies`,
`UNMET_DEPENDENCY_SQL` (taskStatus.ts:68-118); `listUnmetBlockers`
(board.ts:158-190, same join shape); `listTasks` (status.ts:553-596);
runner reads of `.status` (src/cli/runBatch.ts:349-353, :466-503, :618).
Tests: tests/status.test.ts `describe("getTaskDetail")` :784.

## Tests must pin

- get_task and list_tasks agree on status for a pending task with an unmet
  dependency (`blocked` in both), and for the same task after the dependency
  is done (`pending` in both) and after it is cancelled (`pending`).
- Agreement sweep: for every task of a mixed fixture (pending, blocked,
  in_progress with an unmet dependency, done, cancelled), `getTaskDetail(t).status`
  equals its `listTasks` entry.
- in_progress task with an unmet dependency stays `in_progress` in get_task.
- `depends_on` lists met and unmet dependencies with correct `met`, `status`
  (a dependency that is itself blocked shows `blocked`), code-ordered.
- `dependents` lists tasks depending on this one; both arrays `[]` when none.
- Cross-project dependency carries the other project's prefix in `code`.
- Control: revert `getTaskDetail` to the stored status -> agreement test fails.

## Must-confirm

- Field names `depends_on` / `dependents` (vs. the task's `blocked_by` /
  `blocks`). Recommended as written; renaming is cheap before merge.
- Export keeps the stored status (not derived) - intended, see table.
