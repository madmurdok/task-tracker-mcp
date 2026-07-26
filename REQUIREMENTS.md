# Requirements Backlog

Running backlog of ideas and gaps found while using task-tracker-mcp to plan and
build a large, multi-session project through Claude. Each entry captures the
problem and a proposed direction, not a finished design — turn an entry into an
`architecture-design` / `code-implementation` pass once it's picked up.

Status values: `proposed` (idea only) -> `planned` (approach agreed) -> `in-progress`
-> `done`.

## Open Items

### 1. `get_next_task` doesn't return file_paths or handoff notes

- **Status:** proposed
- **Priority:** high
- **Problem:** The architecture doc's data flow explicitly promises a "compact task
  packet (files, acceptance criteria, prior handoff notes)" from `get_next_task`, but
  the actual `Task` shape returned has no `file_paths` (they live in a separate
  `task_files` table) and `add_handoff_note` is write-only — there's no read path for
  prior notes anywhere. A fresh session picking up a task can't see which files it
  should touch or what a previous session already decided, which defeats the core
  cross-session handoff goal of the whole project.
- **Direction:** extend `get_next_task` (and any future `get_task`) to include
  `file_paths` and the task's handoff notes (most recent first, or all of them).

### 2. `get_task(task_id)` — full task detail on demand

- **Status:** proposed
- **Priority:** medium
- **Problem:** `list_tasks` intentionally returns compact summary rows only; there's
  no way to re-fetch one task's full detail (description, acceptance criteria, files,
  dependencies, handoff notes) later without re-running `get_next_task`, which has
  side effects (claims the task). Already flagged as a known gap in the architecture
  doc's Interfaces section ("use get_next_task/a future get_task for full detail").
- **Direction:** a read-only `get_task(task_id)` tool, side-effect free.

### 3. Bulk task creation for initial planning

- **Status:** proposed
- **Priority:** medium
- **Problem:** Planning a large design doc into the graph means one `create_task`
  MCP round-trip per task (plus one `add_dependency` call per edge) — for a project
  with 50+ tasks that's a lot of tool calls just to stand up the initial graph.
- **Direction:** a `create_tasks` (plural) tool taking an array of task specs
  (optionally with inline `depends_on` refs by index/temp-id) in one call.

### 4. Ordering/priority hints for `get_next_task`

- **Status:** proposed
- **Priority:** low
- **Problem:** `get_next_task` always picks the oldest unblocked pending task
  (`ORDER BY created_at ASC`). On a large project with many tasks unblocked at once
  across different epics, there's no way for Claude (the planner) to say "do this
  branch first" — only creation order decides.
- **Direction:** optional `priority` field on tasks, or an epic-level ordering hint,
  factored into `get_next_task`'s selection query.

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
