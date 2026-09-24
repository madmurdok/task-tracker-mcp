# Requirements Backlog

Running backlog of ideas and gaps found while using task-tracker-mcp to plan and
build a large, multi-session project through Claude. Each entry captures the
problem and a proposed direction, not a finished design — turn an entry into an
`architecture-design` / `code-implementation` pass once it's picked up.

Status values: `proposed` (idea only) -> `planned` (approach agreed) -> `in-progress`
-> `done`.

## Open Items

### 1. Task detail packet: `get_task` + `get_next_task` returns file_paths & handoff_notes

- **Status:** done (see Implemented, v4)
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
  - **`splitTask` gains a status guard** (closes the auto-review Weakly-justified
    finding on this): reject with `Cannot split task ${taskId}: already ${status}`
    if the original task's status is `done` or `cancelled` (the latter once Item 6
    ships). Today, splitting a finished task is merely pointless; once `cancelled`
    exists, it would otherwise silently resurrect an abandoned task — deleting its
    row (losing `cancellation_reason`) and replacing it with fresh `pending`
    subtasks, with no trace the cancellation ever happened. No `force` override —
    reviving cancelled work deliberately should be its own explicit action, not a
    side effect of splitting.
  - Docs: update `docs/architecture/task-tracker-mcp.md`'s Interfaces entries for
    `get_next_task`/`get_task` and the Data Flow diagram (the "task packet" comment
    becomes literally true instead of aspirational).

### 2. Bulk task creation for initial planning

- **Status:** done (see Implemented, v4)
- **Priority:** medium
- **Problem:** Planning a large design doc into the graph means one `create_task`
  MCP round-trip per task (plus one `add_dependency` call per edge) — for a project
  with 50+ tasks that's a lot of tool calls just to stand up the initial graph.
- **Design:**
  - New tool `create_tasks(project_id, tasks: [{ temp_id?, title, description?,
    acceptance_criteria?, file_paths?, epic_id?, release_id?, priority?,
    complexity_hint, depends_on?: string[] }]) -> { tasks: [{ temp_id?, task_id,
    estimated_tokens, over_budget }] }` — `release_id`/`priority` kept in sync with
    what Items 3 and 4 each add to `create_task` itself (closes the auto-review
    Contradictions finding on this spec going stale relative to those two items);
    `complexity_hint` (required, no `?`) kept in sync with Item 7 from the start.
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

- **Status:** done (see Implemented, v4)
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

- **Status:** done (see Implemented, v4)
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
    *Extended by v9 (release cancellation, see the Done/changelog list below):*
    a `cancelled` release
    gets a second, deliberately **narrower** version of this freeze — closed to
    inbound tasks (same "don't add work to a closed batch" reason, distinct error
    message naming the status), but **open outbound**, so a task can still be moved
    or cleared *out of* one. The outbound half of the rule above exists purely to
    stop generated `release_notes` drifting from the membership they were built
    from, and a cancelled release never reached `release_it`, so it has none — while
    rescuing salvageable work out of an abandoned batch into a later release is a
    real workflow worth keeping open.
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
       summary), ordered by `updated_at` (completion order). Once Item 6 ships and a
       release can close with `cancelled` tasks in it too, append a second
       `Cancelled:` section listing them the same way (`- {title}: {reason}`) — so
       the notes surface what was dropped, not just what shipped (closes the
       auto-review Weakly-justified finding on this).
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

- **Status:** done (see Implemented, v5)
- **Priority:** low
- **Problem:** `check_doc_sync` detects that a tracked design doc changed but doesn't
  touch the graph; Claude has to be told to re-plan by hand. On a long-running large
  project this is an easy step to forget. A second, smaller papercut: the only way
  to clear a detected drift was to call `create_project` again, which creates a
  brand-new project rather than updating the existing one in place.
- **Design:** deliberately the smallest change that closes the *forgetting* gap,
  not automatic doc-diffing/re-planning (out of scope — the server never parses or
  diffs doc content, matching the architecture doc's existing Non-goals).
  - `isDocDrifted(project)` (`src/domain/projects.ts`) — pure hash-comparison
    helper, no new column (reuses `design_doc_hash`).
  - `get_next_task` and `get_project_status` now return `doc_drift: boolean`
    (`src/domain/status.ts`), so drift surfaces on the two calls that sit in
    Claude's normal work loop instead of only on an explicit, easy-to-forget
    `check_doc_sync` call. `get_epic_status`/`get_release_status`/`list_tasks`
    deliberately left untouched — not the "am I still on track" checkpoints this
    problem is about.
  - `check_doc_sync` gains `acknowledge?: boolean` — when true (and the doc is
    tracked and readable), persists the current hash as the new baseline in
    place, replacing the old "re-register under a new project" workaround.
    No-op if untracked or unreadable.

### 6. Task cancellation lifecycle

- **Status:** done (see Implemented, v4)
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
    nullable `cancellation_reason TEXT` column. `cancellation_reason` itself is added
    as an ordinary `ensureColumn` step, same as every other column in this doc —
    kept entirely separate from (and running *before*) the CHECK-widening rebuild
    below, so the rebuild's own data copy has a real source column to read from
    (closes the auto-review Contradictions finding on this — the rebuild's `INSERT
    ... SELECT` can't select a column `tasks_old` was never given).
  - **⚠️ The CHECK-constraint rebuild is the hard part of this item, not a routine
    `ensureColumn`.** SQLite bakes a `CHECK` constraint into the table's stored
    schema permanently — unlike every column added so far, there is no
    `ALTER TABLE ... ADD COLUMN` that loosens an existing `CHECK`. Every
    already-existing `~/.task-tracker/tracker.db` has the *old* three-value
    constraint physically baked into its `tasks` table, so it will keep rejecting
    `status = 'cancelled'` forever unless the table itself is rebuilt.
    `runMigrations` needs a genuinely different kind of step for this one:
    1. Detect whether the rebuild is still needed (e.g. check `sqlite_master`'s
       stored `CREATE TABLE` text for `tasks` for the substring `'cancelled'`).
    2. If needed, run the whole rebuild as one `better-sqlite3`
       `db.transaction(fn).immediate()` call — `.immediate()` acquires SQLite's
       write lock (`BEGIN IMMEDIATE`) up front instead of lazily, so a second
       process (the MCP server *and* the Status CLI both call `openDatabase()`
       independently, per the architecture doc) can't race through its own
       `RENAME`/`CREATE`/`DROP` sequence at the same time (closes the auto-review
       Bottleneck finding on this). Pair with `db.pragma('busy_timeout = 5000')` at
       connection-open time so the second process *waits* for the lock instead of
       failing immediately with `SQLITE_BUSY` — it then re-enters the transaction,
       re-runs the "already migrated?" check from step 1, sees it's now `true`, and
       no-ops.
    3. Inside that transaction: `db.pragma("foreign_keys = OFF")` first —
       `task_files`, `task_dependencies`, and `handoff_notes` all have
       `ON DELETE CASCADE` FKs into `tasks(id)`, so dropping/renaming `tasks` with
       enforcement still on risks cascading deletes wiping them out mid-migration.
    4. `ALTER TABLE tasks RENAME TO tasks_old`, `CREATE TABLE tasks (...)` using the
       *current* full column list from `schema.ts` (every column any earlier
       migration has already added — `epic_id`, `release_id`, `priority`,
       `completion_summary`, `cancellation_reason`, etc. — plus the widened
       `CHECK`), `INSERT INTO tasks (<explicit column list>) SELECT <same list>
       FROM tasks_old` (valid now that every one of those columns, including
       `cancellation_reason`, already exists on `tasks_old`), `DROP TABLE
       tasks_old`.
    5. Recreate every index that pointed at the old table
       (`idx_tasks_project_id`, `idx_tasks_status`, `idx_tasks_epic_id`,
       `idx_tasks_release_id`, ...) — dropping the old table drops them too.
    6. `db.pragma("foreign_keys = ON")` again, still inside the same transaction.
    This needs its own dedicated test (not just the existing schema-shape checks in
    `tests/db.test.ts`): build a DB on the *old* 3-value schema, insert rows, run
    `runMigrations`, and assert both that old rows/statuses survived intact and that
    a `cancelled` insert now succeeds. Also cover **idempotency**: call
    `runMigrations` a second time on the already-migrated DB and assert it's a
    clean no-op (this is what actually exercises the "already migrated?" check from
    step 1).
    **Deliberately not covered by an automated test:** the concurrent-process race
    itself. `better-sqlite3` is synchronous, so genuinely proving two processes
    racing through this needs a real second OS process or worker thread with a
    timing-dependent wait/commit dance — a same-process test with two `Database`
    handles would just deadlock the one JS thread instead of testing anything (see
    the auto-review discussion this resolves). Given this path only matters once,
    at the moment an existing DB first upgrades past this migration, and
    `.immediate()` + `busy_timeout` is a standard, well-understood SQLite pattern,
    a timing-based test's flakiness risk outweighs what it would prove — leave a
    code comment on the `.immediate()` call explaining *why* (this reasoning),
    instead of a test.
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

### 7. Mandatory complexity hint on task creation (for opus-subagent delegation)

- **Status:** done (see Implemented, v4)
- **Priority:** medium
- **Problem:** Claude Code has an `opus` subagent meant for unusually hard work
  (deep debugging, tricky refactors, architectural trade-offs, multi-step
  reasoning) instead of the default session model — but nothing about a task
  captures whether it's worth that judgment call. That call is best made once,
  during planning, when the full design-doc context is available — not re-derived
  (or missed entirely) by whichever session later picks the task up via
  `get_next_task`.
- **Confirmed with the user:** make it **required** on task creation, not optional
  like `priority`/`epic_id`/`release_id` — forces an explicit judgment call every
  time, same reasoning as Item 4's `test_command`-required-or-`force` fix: an
  optional "should I flag this" field just quietly never gets set.
- **Design:**
  - **Data model:** new column `complexity_hint TEXT NOT NULL DEFAULT 'normal'
    CHECK (complexity_hint IN ('normal', 'high'))` on `tasks`. Unlike Item 6's
    `status` CHECK, this is a **brand-new** column, not a widened constraint on an
    existing one — a plain `ensureColumn`-style `ALTER TABLE ADD COLUMN` with a
    `NOT NULL DEFAULT` is valid SQLite here (the default trivially satisfies the
    `CHECK` for every existing row), no table rebuild needed.
  - **`create_task`'s contract changes (breaking):** `create_task` already shipped
    in v1, so this is a retrofit, not a fresh design. `CreateTaskInput.complexity_hint`
    becomes required (`z.enum(["normal", "high"])`, no `.optional()`) at both the
    MCP tool layer and the domain `TaskStatus`-style TS type — every existing call
    site across the test suite (`tasks.test.ts`, `split.test.ts`, `epics.test.ts`,
    `mcp-smoke.test.ts`, `ownership.test.ts`, the lifecycle/verification tests,
    `cli.test.ts`) needs updating to pass it explicitly. Mechanical, but broad.
  - **`create_tasks` (Item 2) kept in sync from the start:** its per-task spec gets
    `complexity_hint` as a required field too, written directly into Item 2 now —
    avoiding the staleness bug an earlier review round already caught once for
    `release_id`/`priority`.
  - **`splitTask` inheritance:** `SplitSubtaskInput` gets an optional
    `complexity_hint?` — inherits `original.complexity_hint` by default (same
    pattern as `epic_id`/`release_id`) if omitted, but can be overridden per
    subtask, since splitting sometimes reveals one piece is meaningfully
    harder/easier than the other.
  - **Exposure only, no scheduling effect:** surfaces on `get_next_task`/`get_task`'s
    `TaskDetail` (Item 1) and `list_tasks`'s `TaskSummary`, but doesn't affect
    `get_next_task`'s selection order at all — that's `priority`'s job (Item 3);
    this is purely a hint for *which agent* implements the task, not *when*. No
    dedicated `list_tasks` filter for it in this pass — that param list is already
    flagged as getting long (Item 4); revisit only if filtering by this proves
    needed in practice.

### 8. Real-time web dashboard for task state

- **Status:** done (see Implemented, v6)
- **Priority:** medium
- **Problem:** There's no way to *watch* an agent work on a project. `list_tasks`/
  `get_project_status` are pull-only snapshots a human has to remember to ask for,
  and the Status CLI (Item "v2" in Implemented) is a print-and-exit dump, not
  something you'd leave open. Watching what's `in_progress`, what just unblocked,
  and what's `done` as it happens requires re-running the CLI by hand on a loop.
- **Confirmed with the user:**
  - Two pages: a project picker, and a per-project board.
  - The board updates live with no user-driven mutation of the tracker itself —
    pure visualization of current state, not a second write path alongside the
    MCP tools. (A purely local UI toggle like collapsing a swimlane doesn't count
    as "interaction" here — nothing round-trips to the tracker for it.)
  - Cards show the minimum needed for a human glance: title, status, priority,
    description, its `epic_id` as a small tag (orthogonal to the release
    swimlane it already sits in), and who/what holds it (`owner_session_id`) so
    concurrent agent sessions are distinguishable. Deliberately **not**
    `file_paths`/`handoff_notes`/`acceptance_criteria` — that's agent-facing
    detail (Item 1's packet), not what a human watching the board needs.
  - An `in_progress` card whose `lock_expires_at` has already passed is
    highlighted as **stale** — it's about to be auto-reclaimed by the next
    `get_next_task` call (existing lease behavior), and that's an early signal
    the session behind it likely died.
  - `cancelled` cards stay visible but visually de-emphasized (muted/greyed),
    not hidden — same "visible, not hidden from the stats" principle Item 6
    already applied to status aggregation.
  - A project-level banner surfaces `doc_drift` (Item 5's field on
    `get_next_task`/`get_project_status`) at the top of the board — the two
    features compose directly, no extra backend work.
  - Releases need their own visual grouping, distinct from status. Decided:
    **swimlanes by release** (status columns nested inside each), collapsible
    per-release via a vertical accordion — a large project with many releases
    doesn't turn into one giant uninterrupted board.
  - Live updates via **frontend polling** (plain `fetch` every 1-2s against a
    read-only HTTP endpoint), not WebSocket/SSE push. Push would need the UI
    server to learn about writes made by the *separate* MCP server process —
    either polling the DB internally anyway and pushing diffs (same mechanism,
    extra transport plumbing) or a real cross-process event channel (none
    exists today). Polling from the browser needs neither: every tick is just
    "give me current state" through functions that already exist. The UI shows
    a "last updated Xs ago" timestamp (or a clear disconnected state once a
    poll fails) so a stuck poll reads as "connection lost", not "nothing's
    happening."
  - **Separate process**, not an HTTP add-on to the MCP server — same shape as
    the existing Status CLI (`src/cli/status.ts`): opens the SQLite file
    directly, read-only, no MCP round-trip. Keeps the MCP server's
    responsibility (tool calls over stdio) from mixing with serving a web UI.
    Binds to `127.0.0.1` only, never `0.0.0.0` — it's read-only, but still
    serves project file paths and task descriptions with no auth in front of it.
- **Direction (rough — turn into a full `architecture-design` pass before
  building):**
  - New entry point alongside `src/cli/status.ts`, e.g. `src/dashboard/server.ts`,
    started via its own `npm run dashboard`-style script; listens on
    `127.0.0.1` and serves static HTML/JS plus a small JSON API.
  - The card shape needed (title, status, priority, description, epic_id,
    release_id, owner_session_id, lock_expires_at) sits strictly between the
    existing `TaskSummary` (too little — no priority/description/ownership) and
    `TaskDetail` (too much — drags in file_paths/handoff_notes/
    acceptance_criteria). Likely a new type/query rather than reusing either as
    is.
  - JSON API otherwise built on existing read-only domain functions
    (`listProjects`, `listReleasesWithStatus`, `getProjectStatus`) — likely one
    new aggregation (tasks grouped by release, then by status) rather than the
    client stitching several endpoints together per poll.
  - This item effectively reverses the architecture doc's existing "full
    UI/viewer" Non-goal (it currently reads "a print-and-exit tool, not an
    interactive viewer") — once built, that Non-goal needs updating the same way
    Item 5 updated the doc-sync one.

### 9. A plan per release batch, so one approval covers the whole batch

- **Status:** done (see Implemented, v10)
- **Priority:** high
- **Problem:** working a release batch stalls. Claude finishes two or three tasks
  and then stops to ask what to take next — not because the order is unknown, but
  because it has no standing approval for the batch. CLAUDE.md requires explicit
  approval before starting execution, and nothing in the tracker records that an
  approval was ever given, so it gets re-earned every few tasks.
  The ordering data already existed: `tasks.priority` plus `task_dependencies`.
  Three things did not, and none of them is expressible as an integer:
  1. **An approval.** A priority cannot be approved. A plan can, once, for a batch.
  2. **Scope.** `get_next_task` was project-wide and could not be told "work the
     1.3.0 batch".
  3. **A computable answer to "in the batch but not in the plan"**, so a task added
     later cannot be silently missed. That requirement alone ruled out storing the
     plan as free text.
- **Confirmed with the user:**
  - **Approval happens in chat, recorded through an MCP tool** — the dashboard stays
    read-only, so Item 8's "pure visualization, not a second write path" is not
    reversed. Stated plainly and accepted: the tool recording the approval is called
    by the party the approval authorises, so this is an audit trail rather than an
    enforcement boundary, which is why `approval_note` stores the approver's
    verbatim words. The *ordering*, unlike the approval, is genuinely enforced —
    `get_next_task` refuses to hand out release-scoped work against an unapproved
    plan.
  - **A task added to (or removed from) the batch reverts the plan to `draft`**, and
    new work is not handed out until it is re-approved. Chosen over the looser
    options knowing it reintroduces a pause; the design's job is to make that pause
    cheap, which is why an added task is auto-appended as a final step — "it goes
    last" is the common case, so re-approval is one word.
  - **CLAUDE.md is in scope.** Without a rule that reads the plan, the tracker gains
    a table nobody's behaviour consults.
- **Design:** two tables (`release_plans`, `release_plan_items`), a `plans.ts`
  domain module, revert hooks on `createTask`/`createTasks`/`setTaskRelease`,
  `release_id` on `get_next_task`, three MCP tools, and a read-only Plan popup on
  the board. Drift and "new since approval" are computed at read time, never
  stored, for the same reason `blocked` is. Full contract in the architecture doc.

### 10. Task phases and slices, so how a task is worked is itself trackable

- **Status:** done (see Implemented, v11)
- **Priority:** high
- **Problem:** a task was one opaque span from `claim_task` to `complete_task` —
  no record of the phases it actually went through (design, implementation,
  verification, measurement), no place for a fresh agent's verification report
  to live separately from the implementer's own summary, and no way to catch a
  task marked done with part of that work never run. Working every task
  single-agent end to end also spends context a phase-by-phase handoff would
  not have to.
- **Confirmed with the user:**
  - Every task is worked as phases and slices: design -> implementation
    slices -> verification by a fresh agent -> measurement.
  - Results follow "option C": the slice's report goes in `result`, durable
    artifacts are referenced by path in the project repo, and scratch output
    is not recorded.
  - Evidence from the GM-395 pilot: context never exceeded 338k (vs 550k
    single-agent); the fresh-agent verification step found 3 blind tests the
    implementer's own pass had missed.
- **Design:** one table, `task_slices` (phase, step/position, title, brief,
  exit_criterion, model, status, result, artifacts, metrics, timestamps), a
  `slices.ts` domain module, and three MCP tools — `set_task_slices` (writes a
  task's whole slicing, wholesale-replace only), `start_slice`, `complete_slice`
  — plus `.slices` on `get_task`/`get_next_task` and a `complete_task` refusal
  (`open_slices`) while any slice is still pending or in progress. A slice is
  labelled `S1`, `S2`, ... in step/position order, computed at read time, and
  addressed by its own uuid or `<task>/S<n>`. The board's read-only Slices view
  is planned (TTM-84), not part of this. Full contract in the architecture doc.

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
- **v4 — task detail packet** (`get_task`, enriched `get_next_task`): both return
  `file_paths`/`handoff_notes` alongside the task row; `get_task` has no claim/lock
  side effect. `split_task` now rejects an already-`done`/`cancelled` original.
- **v4 — mandatory complexity_hint** (`create_task`/`create_tasks`/`split_task`):
  `complexity_hint: "normal" | "high"` is required at creation (inherited,
  overridable, on split) — see the project's `CLAUDE.md` for how this drives
  opus-subagent delegation.
- **v4 — priority** (`set_task_priority`, `priority` on `create_task`/`create_tasks`):
  `get_next_task` orders candidates `priority DESC, created_at ASC`; default `0`
  keeps pure creation-order behavior unless priorities are actually set.
- **v4 — task cancellation** (`cancel_task`): abandons a task without a dishonest
  force-completion; unblocks dependents the same way `complete_task` does;
  `cancelled` is a full `status` value (required a one-time table-rebuild migration
  for already-existing DBs, since SQLite bakes `CHECK` constraints in permanently).
- **v4 — releases** (`create_release`, `list_releases`, `get_release_status`,
  `release_it`, `set_task_release`, `set_release_sequence`, `release_id` on
  `create_task`/`create_tasks`/`list_tasks`): version-based grouping orthogonal to
  epics. `release_it` gates on every task being `done`/`cancelled` (not
  force-skippable) then on a required `test_command` (or explicit `force`) run
  through the same Completion Verifier `complete_task` uses, and generates
  `release_notes` from `completion_summary`/`cancellation_reason`. A `released`
  release's task membership is frozen. Releases, like epics, don't enter the
  dependency graph and aren't `get_next_task`-aware.
- **v4 — bulk task creation** (`create_tasks`): plans a whole batch (e.g. from a
  design doc) in one call, with `temp_id`-based cross-references for
  same-batch dependency edges; whole batch rolls back together on any error.
- **v5 — design-doc drift reconciliation** (`doc_drift` on `get_next_task`/
  `get_project_status`, `acknowledge` on `check_doc_sync`): drift is now surfaced
  automatically on the two calls in Claude's normal work loop instead of only on
  an explicit `check_doc_sync` call, closing the "easy to forget" gap; once
  reconciled by hand, `check_doc_sync(acknowledge: true)` persists the current
  hash as the new baseline in place (no new project needed). Re-planning itself
  is still manual — the server never diffs doc content or touches the graph on
  its own.
- **v6 — real-time dashboard** (`npm run dashboard`, `src/domain/board.ts`'s
  `getBoardData`): a read-only local web server (plain `node:http`, no new
  dependency, `127.0.0.1`-only) serving a project picker and a per-project
  board. The board groups tasks into release swimlanes (a "no release" lane
  first) split into status columns, with cards showing title/description/
  status/priority/epic tag/owner, a highlighted `is_stale` flag for a task
  past its lock lease, muted (not hidden) `cancelled` cards, and a `doc_drift`
  banner reusing Item 5's field. The frontend polls every 1.5s and re-renders,
  with a "last updated"/disconnected indicator and click-to-collapse
  swimlanes (in-memory only). No new schema - purely derived from existing
  tables, and zero write path back into the tracker (see the architecture
  doc's updated Non-goals).
- **v7 — task numbering, delete_task, board polish**: projects gain a
  `code_prefix` (derived from the project name, deduped across projects) and
  tasks gain a per-project `task_number`, both assigned by an idempotent
  startup backfill for existing rows; together they form a short `PREFIX-N`
  display code (e.g. `TTM-52`) now shown on every dashboard card, alongside
  `project_code_prefix` in `BoardData` and `task_number` in `list_tasks`/
  `get_task`. `delete_task` hard-deletes a backlog (no-release) task outright
  (cascading to its files/dependencies/handoff notes) instead of leaving a
  permanent `cancelled` row for a task that should never have been created.
  The dashboard board also always shows the Backlog lane first (even when
  empty), orders release lanes newest-first, and annotates each lane's title
  with its non-cancelled task count (e.g. "Backlog (5)").
- **v8 — `claim_task` starts pending work directly**: previously `claim_task`
  only ever touched `owner_session_id`/`lock_expires_at`, so calling it directly
  on a still-`pending` task silently left `status` unchanged — only
  `get_next_task`'s queue-pull actually flipped a task to `in_progress`. Now
  `claim_task` is a full direct-pick counterpart to `get_next_task`'s
  queue-pull (for a human/orchestrator assigning a specific task to a specific
  parallel worker, e.g. by epic/file area): it moves a `pending` task to
  `in_progress` itself, gated by the same unmet-dependency check `get_next_task`
  applies (rejects with a new `blocked` error otherwise), and rejects with a new
  `not_claimable` error for an already `done`/`cancelled` task. `get_next_task`
  itself is unchanged (no `session_id` param) — the two tools stay orthogonal:
  pull-the-next-one vs. take-this-specific-one, both converging on the same
  `in_progress` + owner + lease state.
- **v9 — release cancellation** (`cancel_release`, `cancelled` release status):
  a release could only ever be `planned` or `released`, so a batch that was
  built but deliberately not shipped — a measured gate saying don't ship it, a
  branch that will never be merged — had nowhere to go: every task `done`, the
  release stuck at 100% `planned` forever, and the only way to clear it off the
  board was to lie about it with `release_it`. `cancel_release(project_id,
  release_id, reason)` records it honestly, with `reason` **mandatory** (unlike
  `cancel_task`'s optional one — writing off a whole batch of finished work is
  only worth recording *with* the why, and it's also all the dashboard has for
  that lane, since a cancelled release never generates `release_notes`).
  One-shot in both directions, like `cancel_task`: no un-cancel, and
  `release_it` now rejects a cancelled release too. Assigning *new* tasks into
  one is rejected, but moving a task *out* stays allowed — see the deliberate
  asymmetry documented under Item 4's freeze rule. On the dashboard a cancelled
  lane defaults to collapsed and renders in `--danger` with a `Cancelled` badge
  and its reason behind the release-notes dialog: deliberately louder than a
  cancelled *task*'s muted, struck-through card, since an abandoned batch is
  the thing a reader most needs to spot. Required the same
  CHECK-widening table rebuild `cancelled` tasks needed in v4, with an extra
  hazard — `tasks.release_id` is `ON DELETE SET NULL`, so the rebuild has to
  run with `foreign_keys` off or it silently clears every task's release
  assignment (asserted against in `tests/migration.test.ts`).

- **v10 — a plan per release batch** (`create_plan`, `get_plan`, `approve_plan`,
  `release_id` on `get_next_task`, `release_plans`/`release_plan_items`): a batch
  carries its execution order plus the record that a human approved it, so an
  approved batch is worked end to end instead of re-earning approval every few
  tasks. Items sit at a `step` (parallel within one) and a `position`; drift in
  both directions and "new since approval" are computed at read time, never
  stored. `get_next_task(project_id, release_id)` walks an approved plan and
  returns `plan_not_approved` while it is `draft` or drifted — that refusal is the
  enforced half, since the approval itself is recorded by the party it authorises.
  Adding or removing a batch task reverts the plan to `draft`, auto-appending the
  new task so re-approval is one word. The board gains a read-only Plan popup
  beside Release notes, with finished items struck through. Reverses v4's
  "releases don't participate in scheduling" non-goal; the unscoped
  `get_next_task` is unchanged.

- **v11 — task phases and slices** (`set_task_slices`, `start_slice`,
  `complete_slice`, `.slices` on `get_task`/`get_next_task`, `task_slices`): a
  task's own work now has a record of the phases it went through — design,
  implementation slices, verification by a fresh agent, measurement — instead
  of one opaque span from claim to complete. `set_task_slices` writes a task's
  whole slicing at once: steps run in order, and a step holding an array of
  slices means they may run in parallel (the same shorthand `create_plan`'s
  steps use). Slices are labelled `S1`, `S2`, ... in step/position order,
  computed at read time rather than stored, and addressed by their own uuid or
  `<task>/S<n>` (e.g. `TTM-83/S2`). Replacing a slicing is wholesale — it
  carries nothing over, dropping even finished slices and listing them in
  `discarded` — and refuses while a slice is `in_progress` or the task is
  `done`/`cancelled`. `start_slice` moves `pending -> in_progress`;
  `complete_slice` records the outcome (`done`/`failed`/`skipped`) with
  `result` as the slice's report and optional `artifacts`/`metrics`, one-shot
  like `complete_task`. `complete_task` itself now refuses with `open_slices`
  while any slice is still open, naming each one, unless `force`. The board's
  read-only Slices view is planned (TTM-84), not part of this.
  TTM-87 tied slicing back into v10's plan approval: `approve_plan` now also
  refuses, after its drift check, while any open (not `done`/`cancelled`)
  batch task has zero slices — naming the unsliced tasks by code and pointing
  at `set_task_slices`, the same shape as the drift refusal. No bypass flag;
  the check runs only at approval time, so a plan can still be written and
  reordered before every task is sliced.

## How to use this file

- Append new ideas as a new numbered item under Open Items as they come up, with at
  least Problem + a rough Direction.
- When an item is picked up for real, flip its Status to `planned` once the approach
  is agreed, and link the resulting design doc / implementation plan.
- Move finished items to a `## Done` section (or just mark `done` and leave them —
  keep whichever is less friction) instead of deleting, so the backlog also reads as
  a changelog of *why* things were built.

## Additional Discussion Topics (auto-review)

Third pass. All five findings from the previous run are still holding (re-checked,
nothing regressed).

### Weakly-justified decisions

- ~~**Item 6's "test two concurrent `openDatabase()` calls" plan glosses over
  `better-sqlite3` being synchronous.**~~ **Resolved:** the concurrent-race case is
  deliberately left untested (a same-process test would deadlock; a real one needs a
  second OS process/worker thread and would be timing-dependent/flaky for what it
  proves) — covered instead by an idempotency test plus a code comment on
  `.immediate()` explaining why (see Item 6's design).
