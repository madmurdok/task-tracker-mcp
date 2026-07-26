# Requirements Backlog

Running backlog of ideas and gaps found while using task-tracker-mcp to plan and
build a large, multi-session project through Claude. Each entry captures the
problem and a proposed direction, not a finished design — turn an entry into an
`architecture-design` / `code-implementation` pass once it's picked up.

Status values: `proposed` (idea only) -> `planned` (approach agreed) -> `in-progress`
-> `done`.

## Open Items

### 1. Task detail packet: `get_task` + `get_next_task` returns file_paths & handoff_notes

- **Status:** planned
- **Priority:** high
- **Problem:** The architecture doc's data flow explicitly promises a "compact task
  packet (files, acceptance criteria, prior handoff notes)" from `get_next_task`, but
  the actual `Task` shape returned has no `file_paths` (they live in a separate
  `task_files` table) and `add_handoff_note` is write-only — there's no read path for
  prior notes anywhere. A fresh session picking up a task can't see which files it
  should touch or what a previous session already decided, which defeats the core
  cross-session handoff goal of the whole project. `list_tasks` also only returns
  compact summary rows, with no side-effect-free way to re-fetch one task's full
  detail later (originally tracked as a separate item — folded in here since both
  need the same underlying data).
- **Design:**
  - `requireTask(db, task_id) -> Task` in `src/domain/tasks.ts` — a shared lookup
    (throws `Unknown task_id: ...`); `splitTask`'s existing inline
    `SELECT ... WHERE id = ?` gets replaced with this instead of keeping a second
    copy of the same check.
  - `listTaskFilePaths(db, task_id) -> string[]` — new query over `task_files`
    (nothing reads that table back today).
  - `listHandoffNotes(db, task_id) -> HandoffNote[]` in `src/domain/handoffNotes.ts`,
    ordered `created_at ASC` (same convention as every other list in the codebase).
  - `getTaskDetail(db, task_id) -> Task & { file_paths, handoff_notes }` in
    `src/domain/status.ts` (next to `getNextTask`/`displayStatus`, which it reuses),
    composing the three functions above.
  - `get_next_task`'s success shape becomes `{ task: TaskDetail }` — `handOut()`
    calls `getTaskDetail` on the freshly-updated row instead of returning the bare
    `Task`.
  - New read-only MCP tool `get_task(task_id) -> TaskDetail` — same builder, no
    claim/lock side effect, so a task can be re-inspected anytime.
  - Docs: update `docs/architecture/task-tracker-mcp.md`'s Interfaces entries for
    `get_next_task`/`get_task` and the Data Flow diagram (the "task packet" comment
    becomes literally true instead of aspirational).

### 2. Bulk task creation for initial planning

- **Status:** planned
- **Priority:** medium
- **Problem:** Planning a large design doc into the graph means one `create_task`
  MCP round-trip per task (plus one `add_dependency` call per edge) — for a project
  with 50+ tasks that's a lot of tool calls just to stand up the initial graph.
- **Design:**
  - New tool `create_tasks(project_id, tasks: [{ temp_id?, title, description?,
    acceptance_criteria?, file_paths?, epic_id?, depends_on?: string[] }]) ->
    { tasks: [{ temp_id?, task_id, estimated_tokens, over_budget }] }`.
  - `temp_id` is an arbitrary client-chosen string scoped to the batch, letting a
    task's `depends_on` reference a sibling created earlier in the *same* call
    before it has a real id; an entry in `depends_on` that isn't a known `temp_id`
    in this batch is treated as an existing `task_id` (so a batch can also wire new
    tasks onto an already-existing graph).
  - Domain-level `createTasks(db, estimator, project_id, specs)`: reject duplicate
    `temp_id`s up front, create every task first (reusing `createTask` as-is), *then*
    resolve and add every `depends_on` edge in a second pass (reusing `addDependency`
    as-is, so cycle detection stays exactly where it already lives) — the two-pass
    split avoids needing creation order to match dependency order within a batch.
  - Whole call wrapped in one `db.transaction`, so a bad epic ref or a cyclic edge
    rolls back the entire batch instead of leaving a half-planned graph.

### 3. Priority hint for `get_next_task`

- **Status:** planned
- **Priority:** low
- **Problem:** `get_next_task` always picks the oldest unblocked pending task
  (`ORDER BY created_at ASC`). On a large project with many tasks unblocked at once
  across different epics, there's no way for Claude (the planner) to say "do this
  branch first" — only creation order decides.
- **Design:**
  - New nullable-with-default `priority INTEGER NOT NULL DEFAULT 0` column on
    `tasks` (migration via `ensureColumn`, same pattern as every other added
    column); higher sorts first.
  - `create_task`/`create_tasks` accept an optional `priority`.
  - New single-purpose tool `set_task_priority(task_id, priority)` to adjust it
    later, once a task turns out to matter more/less than assumed at creation time
    — deliberately not folded into a general-purpose "update_task" tool, since
    priority is the only mutable field this problem actually needs.
  - `get_next_task`'s candidate query changes to
    `ORDER BY priority DESC, created_at ASC` — with every task defaulting to `0`,
    existing behavior (pure creation order) is unchanged until priorities are
    actually set.
  - Epic-level ordering hints are explicitly out of scope for this pass — task
    priority alone covers the stated problem; revisit only if task-level proves
    insufficient in practice.

### 4. Release grouping (version-based), with a release-time test gate and auto-generated release notes

- **Status:** planned
- **Priority:** high
- **Problem:** On a large project, tasks need a second, orthogonal grouping besides
  Epic: a **release** ("0.1", "0.2", "2.6", ...) — an explicitly-numbered bucket of
  tasks that, once all done, gets shipped: gated by a test run, and accompanied by
  auto-generated release notes. Epic groups *by feature* ("Auth rework"); Release
  groups *by shipment* — the same task can belong to one of each. Confirmed with the
  user: Release is an independent entity from Epic (not "Epic + a version field"),
  and `release_it` should run a test command as a gate before allowing the release,
  not just flip a status flag.
- **Prerequisite finding:** `complete_task`'s `summary` argument is accepted by the
  MCP tool schema but silently discarded — `CompleteTaskInput`/`completeTask` in
  `src/domain/lifecycle.ts` don't even have a field for it. There is currently no
  stored per-task completion text anywhere, which release notes need as their source.
- **Design:**
  - **Data model** — new `releases` table, `releases.name/description` and `unique
    (project_id, version)` mirroring `epics.name`'s per-project uniqueness:
    ```sql
    CREATE TABLE releases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released')),
      sequence INTEGER NOT NULL,
      release_notes TEXT,
      released_at TEXT,
      created_at TEXT NOT NULL
    );
    -- unique (project_id, version); index on project_id
    ```
    `sequence` is what `list_releases` actually orders by — resolves the auto-review
    Weakly-justified-decision finding (releases have a real order, version-number
    order, that plain `created_at` can't be trusted to match; e.g. a "0.1.1" hotfix
    created after "0.2" already exists). `createRelease` auto-assigns it as
    `COALESCE(MAX(sequence) WHERE project_id = ?, 0) + 10` — incrementing by **10**,
    not 1, deliberately leaving gaps so a release can later be manually slotted
    between two existing ones without renumbering anything else. `listReleases`
    becomes `ORDER BY sequence ASC, created_at ASC` (the latter only as a tiebreak
    for equal/duplicate sequences, which are allowed — no uniqueness constraint on
    `sequence`). New MCP tool `set_release_sequence(project_id, release_id,
    sequence: number) -> { ok: true }` lets it be adjusted later (e.g. set to `15` to
    place a release between two already at `10` and `20`); unlike `set_task_release`,
    this isn't blocked by a release already being `released` — reordering where a
    past release *shows up* in a list is unrelated to the task-membership-drift
    problem `set_task_release`'s freeze rule exists for.
    `tasks` gets a second nullable grouping FK alongside `epic_id`:
    `release_id TEXT REFERENCES releases(id) ON DELETE SET NULL` (same
    CREATE-TABLE-plus-`ensureColumn` treatment). Also add
    `completion_summary TEXT` (nullable) to `tasks`, to close the prerequisite
    finding above.
  - **Domain — `src/domain/releases.ts`** (mirrors `src/domain/epics.ts` exactly):
    `createRelease`, `getRelease`/`requireRelease` (resolved by id or `version`,
    scoped to project — same reasoning as epic name scoping), `listReleases`.
  - **Domain — task association:** `CreateTaskInput`/`create_tasks` get an optional
    `release_id`, validated with `requireRelease(db, project.id, ref)` exactly like
    `epic_id` is today; `splitTask` inherits `release_id` onto subtasks the same way
    it already inherits `epic_id`. `listTasks` gets an independent optional
    `releaseRef` filter alongside the existing `epicRef` one (both may be given
    together) — `TaskSummary` gets a `release_id` field next to `epic_id`.
    *Implementation note:* `listTasks`'s optional-parameter list is getting long
    (`status?`, `epicRef?`, now `releaseRef?`) — worth considering a small options
    object at execution time, not a design blocker.
  - **Domain — released releases are frozen for task membership** (closes the
    auto-review Bottleneck finding on drift, resolved as the strict option): once a
    release's `status` is `'released'`, its task set can never change again.
    `createTask`/`createTasks` reject a `release_id` that resolves to an already-
    `released` release ("Release X is already released; cannot assign new tasks to
    it"). `setTaskRelease` rejects the move if *either* the task's current release
    or its target release is already `released` (moving a task *out of* a released
    release is exactly the same drift, just backwards). `splitTask` needs no extra
    code for this — it already creates subtasks via `createTask`, so the same guard
    applies for free.
  - **Domain — persisting completion summary:** `CompleteTaskInput` gets
    `summary?: string`; `completeTask`'s transaction sets
    `completion_summary = summary ?? null` alongside the existing `status = 'done'`
    update. `Task`/`TaskDetail` (see Open Item #1) naturally expose it since it's
    just another column on the row.
  - **Domain — status aggregation:** `getReleaseStatus`/`listReleasesWithStatus` in
    `src/domain/status.ts`, reusing the same `aggregateStatus` helper introduced for
    epics, filtered by `release_id`.
  - **Domain — `releaseIt(db, verifier, { project_id, release_id, test_command?,
    force? })`** in `src/domain/releases.ts` (or `lifecycle.ts`, next to
    `completeTask` — same shape of operation):
    1. Resolve project + release; reject if `status` is already `'released'`
       (one-shot, like `complete_task` has no "un-complete").
    2. Reject if any task in the release isn't `done` (or, once Item 6 ships,
       `cancelled` — a cancelled task shouldn't block a release either) yet, listing
       the offending task ids — this check is **not** skippable by `force` (can't
       ship unfinished work), unlike the test gate below.
    3. Unless `force`, `test_command` is **required** — reject with a clear error
       ("release_it requires a test_command or force:true to skip the test gate")
       if neither is given, so omitting it can't silently skip testing (see the
       auto-review Contradictions finding this closes). When a `test_command` is
       given, run the test gate by calling the *same* injected `CompletionVerifier`
       already used by `complete_task` —
       `verifier.verify({ rootPath: project.root_path, filePaths: [], testCommand })`.
       Passing an empty `filePaths` skips the git-diff check entirely (see
       `GitDiffCompletionVerifier.verify` in `src/domain/verification.ts`) and runs
       only `testCommand`, so **no new verifier abstraction is needed** — this is a
       straight reuse.
    4. Build release notes from every `done` task in the release:
       `- {title}: {completion_summary}` (omit the `: ...` part when a task has no
       summary), ordered by `updated_at` (completion order).
    5. In one transaction: `UPDATE releases SET status = 'released', release_notes =
       ?, released_at = ? WHERE id = ?`.
    6. Returns `{ ok: true, release_notes, released_at }`.
  - **Domain/MCP — escape valve for a stuck release (closes the auto-review
    Bottleneck finding below, small half):** `setTaskRelease(db, task_id,
    release_ref | null)` in `src/domain/releases.ts` — resolves `task_id` via
    `requireTask` (Item 1), resolves `release_ref` via `requireRelease` scoped to
    the task's own `project_id` (or clears it when `null`), then updates
    `tasks.release_id`. Exposed as MCP tool `set_task_release(task_id, release_id:
    string | null) -> { ok: true }`, letting a task that turns out not to belong in
    a release be moved to another release or unassigned entirely, without needing
    full task-cancellation semantics (deferred — see Item 6).
  - **MCP tools — new `src/mcp/tools/releases.ts`** (mirrors
    `src/mcp/tools/epics.ts`, plus one action tool needing the verifier like
    `registerLifecycleTools` does):
    - `create_release(project_id, version, name?, description?) -> { release_id }`
    - `list_releases(project_id) -> { releases: [{ id, version, name, description, status, released_at, total, done, in_progress, blocked, pending, percent }] }`
    - `get_release_status(project_id, release_id) -> { ...same shape... }`
    - `release_it(project_id, release_id, test_command?, force?) -> { ok: true, release_notes, released_at } | not_all_done error | verification_failed error`
    - `set_task_release(task_id, release_id: string | null) -> { ok: true }`
    - `set_release_sequence(project_id, release_id, sequence: number) -> { ok: true }`
    - `create_task(s)` and `list_tasks` gain `release_id`/`release_id` filter params,
      same as their existing `epic_id` ones.
  - **Docs:** add `RELEASES` to the architecture doc's ER diagram (own box, FK from
    `TASKS` alongside `EPICS`, no relation to `EPICS` itself), document the new tools
    and the `epic_id`-style additions in Interfaces, and add a Non-goals line
    ("releases don't participate in the dependency graph or `get_next_task` either,
    same as epics — a release is a reporting/shipping gate, not a scheduling unit").

### 5. Design-doc drift reconciliation stays manual

- **Status:** proposed (carried over from the architecture doc's existing Open
  Questions/Non-goals — not a new finding)
- **Priority:** low
- **Problem:** `check_doc_sync` detects that a tracked design doc changed but doesn't
  touch the graph; Claude has to be told to re-plan by hand. On a long-running large
  project this is an easy step to forget.
- **Direction:** revisit only if this proves a recurring papercut in practice — no
  concrete design yet.

### 6. Task cancellation lifecycle

- **Status:** planned
- **Priority:** medium
- **Problem:** There is no way to cancel/abandon a task anywhere in the tracker — a
  task that turns out unnecessary (requirement dropped, superseded) stays `pending`
  or `in_progress` forever, with `complete_task` (a dishonest force-complete) as the
  only way to get it out of everyone's way. This surfaced concretely via Item 4's
  `release_it`: its "all tasks done" gate is intentionally not skippable by `force`,
  so a dead task permanently blocks its release (partially mitigated by
  `set_task_release` letting it be moved out of the release, but that doesn't help
  `get_next_task`/dependents, which still treat an abandoned task as unresolved
  forever).
- **Confirmed with the user:** cancellation reason gets its own
  `cancellation_reason` column (not shared with `completion_summary` from Item 4 —
  two distinct single-purpose fields for two distinct lifecycle events). Cancelled
  tasks get their own bucket in every status aggregation and still count toward
  `total`; `percent` stays `done / total` unchanged — cancellation is visible, not
  hidden from the stats.
- **Design:**
  - **Data model:** `tasks.status`'s CHECK constraint widens to
    `CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled'))`, plus a new
    nullable `cancellation_reason TEXT` column.
  - **⚠️ Migration is the hard part of this item, not a routine `ensureColumn`.**
    SQLite bakes a `CHECK` constraint into the table's stored schema permanently —
    unlike every column added so far, there is no `ALTER TABLE ... ADD COLUMN` that
    loosens an existing `CHECK`. Every already-existing `~/.task-tracker/tracker.db`
    has the *old* three-value constraint physically baked into its `tasks` table, so
    it will keep rejecting `status = 'cancelled'` forever unless the table itself is
    rebuilt. `runMigrations` needs a genuinely different kind of step for this one:
    1. Detect whether the rebuild is still needed (e.g. check `sqlite_master`'s
       stored `CREATE TABLE` text for `tasks` for the substring `'cancelled'`).
    2. If needed: `db.pragma("foreign_keys = OFF")` first — `task_files`,
       `task_dependencies`, and `handoff_notes` all have
       `ON DELETE CASCADE` FKs into `tasks(id)`, so dropping/renaming `tasks` with
       enforcement still on risks cascading deletes wiping them out mid-migration.
    3. `ALTER TABLE tasks RENAME TO tasks_old`, `CREATE TABLE tasks (...)` using the
       *current* full column list from `schema.ts` (every column any earlier
       migration has already added — `epic_id`, `release_id`, `priority`,
       `completion_summary`, etc. — plus the widened `CHECK` and the new
       `cancellation_reason`), `INSERT INTO tasks (<explicit column list>) SELECT
       <same list> FROM tasks_old`, `DROP TABLE tasks_old`.
    4. Recreate every index that pointed at the old table
       (`idx_tasks_project_id`, `idx_tasks_status`, `idx_tasks_epic_id`,
       `idx_tasks_release_id`, ...) — dropping the old table drops them too.
    5. `db.pragma("foreign_keys = ON")` again, all of the above wrapped in one
       transaction.
    This needs its own dedicated test (not just the existing schema-shape checks in
    `tests/db.test.ts`): build a DB on the *old* 3-value schema, insert rows, run
    `runMigrations`, and assert both that old rows/statuses survived intact and that
    a `cancelled` insert now succeeds.
  - **Domain — `src/domain/tasks.ts`:** `TaskStatus`/`DisplayStatus` gain
    `"cancelled"`. `displayStatus` needs no change — it already returns
    `task.status` as-is for anything other than `'pending'`, so `'cancelled'` flows
    through untouched.
  - **Domain — resolution rules:** `hasUnmetDependencies`'s query changes from
    `t.status != 'done'` to `t.status NOT IN ('done', 'cancelled')`, so a cancelled
    prerequisite stops blocking its dependents. `get_next_task`'s `all_done`-vs-
    `all_blocked` decision query gets the same `NOT IN ('done', 'cancelled')` swap.
    Its *candidate* query (`status = 'pending'`) already excludes `cancelled` tasks
    with no change needed.
  - **Domain — `cancelTask(db, task_id, reason?, force?)`** in
    `src/domain/lifecycle.ts`, right next to `completeTask`/`releaseTask` (reusing
    their exact conflict-handling shape): rejects an already-`done`/already-
    `cancelled` task; rejects with the same `TaskConflictError` as
    `claimTask`/`releaseTask` if another session's lock is still active, unless
    `force`. Otherwise: sets `status = 'cancelled'`, `cancellation_reason = reason ??
    null`, and clears `owner_session_id`/`lock_expires_at` (same as `releaseTask` —
    a cancelled task isn't being worked by anyone). Computes `unblocked_task_ids`
    with the *same* dependents-scan `completeTask` already does — worth factoring
    that scan into one shared helper both call, rather than duplicating it.
  - **Domain — status aggregation:** `ProjectStatus` (and therefore `EpicStatus`/
    the release equivalent) gets a `cancelled` field; `aggregateStatus` needs no
    logic change since it already does `counts[status] += 1` from `displayStatus`'s
    result — adding `cancelled: 0` to the initial counts object is enough.
  - **Item 4 update required:** `releaseIt`'s "all tasks done" gate changes from
    "every task is `done`" to "every task is `done` OR `cancelled`" — this is what
    actually closes that bottleneck for good (see Item 4, step 2).
  - **MCP:** new tool `cancel_task(task_id, reason?, force?) -> { ok: true,
    unblocked_task_ids: [...] } | conflict error`. `list_tasks`'s `status` filter
    enum (`src/mcp/tools/status.ts`) gains `"cancelled"` alongside the existing four
    values.

## Implemented

What's already shipped, so a new idea can be checked against it before being added
above. Full contract for every tool lives in
[`docs/architecture/task-tracker-mcp.md`](docs/architecture/task-tracker-mcp.md); this
is just an index.

- **v1 — core graph** (`create_project`, `create_task`, `add_dependency`,
  `split_task`, `get_next_task`, `list_tasks`, `get_project_status`): projects own a
  flat task graph; dependency edges gate `status = blocked` (derived, not stored);
  `split_task` replaces a task with subtasks and rewires its edges onto them; a
  Context Budget Estimator flags oversized tasks (`over_budget`) from `create_task`.
- **v2 — ownership & locking** (`claim_task`, `release_task`, auto-reclaim): `get_next_task`
  atomically hands out and locks a task (30 min lease); a second session gets a
  `conflict` error while the lock is live; an expired lock is auto-reclaimed by the
  next `get_next_task` call instead of staying stuck.
- **v2 — completion verification** (`complete_task`, `add_handoff_note`): a
  `CompletionVerifier` (git-diff based) rejects `complete_task` unless the task's
  declared files actually changed and any `test_command` exits zero, unless
  `force: true`; `add_handoff_note` persists decisions/remaining-work/discoveries per
  task (currently write-only — see Open Item #1).
- **v2 — design-doc drift detection** (`check_doc_sync`): hashes a tracked design doc
  at `create_project` time and reports if its content has changed since; doesn't
  reconcile the graph itself (see Open Item #5).
- **v2 — Status CLI** (`node dist/cli/status.js`): read-only, opens the SQLite file
  directly, no MCP round-trip; lists every project or one project's full task list.
- **v3 — project lookup by name** (`list_projects`): every `project_id` argument
  accepts the project's unique `name` interchangeably, so Claude doesn't need to
  remember a UUID once a project exists.
- **v3 — epics** (`create_epic`, `list_epics`, `get_epic_status`, `epic_id` on
  `create_task`/`list_tasks`): a pure grouping/reporting layer — epics have a
  per-project-unique name, aggregate task status counts on read, and are inherited by
  a task's subtasks on `split_task`. Epics do **not** enter the dependency graph and
  `get_next_task` is not epic-aware (an explicit non-goal, see architecture doc).

## How to use this file

- Append new ideas as a new numbered item under Open Items as they come up, with at
  least Problem + a rough Direction.
- When an item is picked up for real, flip its Status to `planned` once the approach
  is agreed, and link the resulting design doc / implementation plan.
- Move finished items to a `## Done` section (or just mark `done` and leave them —
  keep whichever is less friction) instead of deleting, so the backlog also reads as
  a changelog of *why* things were built.

## Additional Discussion Topics (auto-review)

### Contradictions

- ~~**Item 4's test gate is optional, not guaranteed.**~~ **Resolved:** `release_it`
  now rejects unless either `test_command` or `force: true` is given (see Item 4's
  design, step 3) — omitting both is an error instead of a silent no-op test pass.

### Bottlenecks

- ~~**No escape valve for a release with a task that will never be "done."**~~
  **Partially resolved:** `set_task_release` (Item 4) lets a dead task be moved out
  of a release so it stops blocking `release_it`. The underlying problem — no way to
  cancel a task at all, so it still blocks `get_next_task`/dependents forever — is
  real and deliberately tracked separately as Item 6 (task cancellation lifecycle),
  since it's bigger than release grouping and deserves its own design pass.
- ~~**Release membership can silently drift after `released`.**~~ **Resolved (strict
  option chosen):** a `released` release's task membership is now frozen —
  `create_task`/`create_tasks` reject assigning into it, and `set_task_release`
  rejects moving a task into *or* out of it (see Item 4's design).

### Weakly-justified decisions

- ~~**`listReleases` copies epics' creation-order convention onto a domain that has a
  real order.**~~ **Resolved:** releases get an explicit `sequence` column
  (auto-assigned in gaps of 10, manually adjustable via `set_release_sequence`) that
  `list_releases` orders by instead of `created_at` (see Item 4's design).
