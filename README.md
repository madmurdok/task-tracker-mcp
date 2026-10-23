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
`cancel_release`, `set_task_release`, `set_release_sequence`, `set_release_details`, `create_task`,
`set_task_priority`,
`amend_task`, `cancel_task`, `delete_task`, `add_dependency`, `split_task`, `get_next_task`, `get_task`,
`set_task_slices`, `revise_task_slices`, `start_slice`, `complete_slice`,
`list_tasks`, `get_project_status`, `claim_task`, `release_task`, `check_doc_sync`, `set_design_doc`,
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

## Batch runner

`dist/cli/runBatch.js` (bin `task-tracker-run`) works one release batch task by
task, each in a fresh `claude --bg` session that claims its own task
(`docs/design/TTM-95-runner.md`). The runner hands out the next task, starts the
session with `--permission-mode auto` and a deny list (no push, no
`delete_task`, nothing that moves `main`/`master`), and watches
`claude agents --json` plus the DB every `--poll`. When a session waits on a
question or a permission prompt it prints a line, fires one macOS notification
per episode, keeps the lease alive and pauses the working-time clock; answer in
`claude agents` or `claude attach <id>`. It stops on: batch done, all blocked,
plan not approved, doc drift, a failed/stopped/missing session, working time
over `--timeout`, an idle session with an unfinished task past `--grace`, or a
dirty tree / wrong branch after a task. Logs go to
`~/.task-tracker/runs/<PREFIX>-<version>-<UTC stamp>/` (`runner.log`,
`summary.md`).

```bash
npm run build
npm run run-batch -- <project> <release> --dry-run   # preflight + next hand-out + command; writes nothing
npm run run-batch -- <project> <release> [--repo <path>] [--timeout 4h] [--poll 30s] [--grace 15m] [--model <m>]
npm run run-batch -- <project> <release> --resume <CODE>   # re-attach to "<CODE> runner" after the runner died
```

Preflight: `claude --version`, a clean checkout on `release-<version>`, an
approved plan without drift, and no `in_progress` batch task unless `--resume`.
Overrides for tests: `CLAUDE_BIN` (the `claude` binary), `TTM_RUNNER_NOTIFY`
(`off`, or a command called with title and message), `TASK_TRACKER_RUNS_DIR`.

## SessionEnd hook CLI

`dist/cli/session-end.js` (bin `task-tracker-session-end`) is meant to run as a
Claude Code `SessionEnd` hook: it reads the hook's JSON from stdin and expires
the leases of the `in_progress` tasks the ending `session_id` owns, so the next
`get_next_task` reclaims them (with `reclaimed_from`) instead of waiting out the
2 h lease. It writes nothing to stdout/stderr, always exits 0, and appends one
line per run to `session-end-YYYY-MM.log` beside the DB. Installing the hook
(script + `~/.claude/settings.json` entry) is a manual, owner-approved step; see
`docs/design/TTM-100-session-end.md` section 5.

## Dashboard

Read-only, live-updating web view of a project's task graph — a project
picker plus a per-project board (release swimlanes × status columns), polling
every 1.5s. No write path to the tracker; purely an observability window. See
the architecture doc's Interfaces section for the underlying API.

```bash
npm run dashboard   # binds 127.0.0.1:4321 (override with TASK_TRACKER_DASHBOARD_PORT)
                     # opens your default browser automatically - set TASK_TRACKER_DASHBOARD_NO_OPEN to skip
```
