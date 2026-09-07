# task-tracker-mcp

Local MCP server for agent-driven task planning and cross-session handoff. See
[`docs/architecture/task-tracker-mcp.md`](docs/architecture/task-tracker-mcp.md) for the full
design (data model, tool contracts, failure modes).

## Setup

```bash
npm install
npm run build
```

Data lives in a single SQLite file, shared across all projects:
`~/.task-tracker/tracker.db` (override with `TASK_TRACKER_DB_PATH`).

## Register with Claude Code

```bash
claude mcp add task-tracker -- node /absolute/path/to/task-tracker-mcp/dist/index.js
```

## Development

```bash
npm run dev        # run against stdio via tsx, no build step
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run dashboard  # read-only live web dashboard, see below
```

## Tools

`create_project`, `list_projects`, `create_epic`, `list_epics`, `get_epic_status`,
`create_release`, `list_releases`, `get_release_status`, `release_it`,
`cancel_release`, `set_task_release`, `set_release_sequence`, `create_task`, `set_task_priority`,
`cancel_task`, `delete_task`, `add_dependency`, `split_task`, `get_next_task`, `get_task`,
`list_tasks`, `get_project_status`, `claim_task`, `release_task`, `check_doc_sync`,
`add_handoff_note`, `complete_task`, `create_plan`, `get_plan`, `approve_plan`.

Every tool that takes a `project_id` also accepts the project's unique `name`
instead, so you don't have to keep its UUID around once it's been created.

## Status CLI

Read-only, bypasses the MCP transport entirely — opens the same SQLite file
directly.

```bash
npm run build
npm run status                        # list every registered project
npm run status <project_id_or_name>   # that project's status + full task list
```

## Dashboard

Read-only, live-updating web view of a project's task graph — a project
picker plus a per-project board (release swimlanes × status columns), polling
every 1.5s. No write path to the tracker; purely an observability window. See
the architecture doc's Interfaces section for the underlying API.

```bash
npm run dashboard   # binds 127.0.0.1:4321 (override with TASK_TRACKER_DASHBOARD_PORT)
                     # opens your default browser automatically - set TASK_TRACKER_DASHBOARD_NO_OPEN to skip
```
