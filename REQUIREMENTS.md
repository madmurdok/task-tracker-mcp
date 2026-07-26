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
      release_notes TEXT,
      released_at TEXT,
      created_at TEXT NOT NULL
    );
    -- unique (project_id, version); index on project_id
    ```
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
    2. Reject if any task in the release isn't `done` yet, listing the offending
       task ids — this check is **not** skippable by `force` (can't ship unfinished
       work), unlike the test gate below.
    3. Unless `force`, run the test gate by calling the *same* injected
       `CompletionVerifier` already used by `complete_task` —
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
  - **MCP tools — new `src/mcp/tools/releases.ts`** (mirrors
    `src/mcp/tools/epics.ts`, plus one action tool needing the verifier like
    `registerLifecycleTools` does):
    - `create_release(project_id, version, name?, description?) -> { release_id }`
    - `list_releases(project_id) -> { releases: [{ id, version, name, description, status, released_at, total, done, in_progress, blocked, pending, percent }] }`
    - `get_release_status(project_id, release_id) -> { ...same shape... }`
    - `release_it(project_id, release_id, test_command?, force?) -> { ok: true, release_notes, released_at } | not_all_done error | verification_failed error`
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
