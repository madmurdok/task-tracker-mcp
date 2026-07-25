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
```

## Tools (v1)

`create_project`, `create_task`, `add_dependency`, `split_task`, `get_next_task`,
`list_tasks`, `get_project_status`, `claim_task`, `add_handoff_note`, `complete_task`.
