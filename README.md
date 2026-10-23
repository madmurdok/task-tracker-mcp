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
`add_handoff_note`, `complete_task`, `create_plan`, `get_plan`, `approve_plan`,
`export_projects` (JSON backup of one or all projects to an absolute `out_path`),
`import_projects` (restore such a file, optional `root_path_map`).

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

## Backup & restore

JSON backup of one or all projects, restorable into another (or a fresh)
database. Design and decisions: `docs/design/backup-restore.md`. Step-by-step
for a reinstall: [`docs/runbooks/reinstall-backup-restore.md`](docs/runbooks/reinstall-backup-restore.md).

### Export

`dist/cli/export.js` (bin `task-tracker-export`) reads the DB at
`TASK_TRACKER_DB_PATH` (default `~/.task-tracker/tracker.db`); every row of the
project's twelve tables goes in, read in one transaction. Keys are sorted, so
two exports of an unchanged DB differ only on the `exported_at` line.

```bash
npm run build
npm run export -- <project_id_or_name> --out backup.json   # one project
npm run export -- --all --out all.json                     # every project
```

- `<project_id_or_name>` and `--all` are mutually exclusive; one is required.
- `--out <file>` is required. The file is written to `<out>.tmp-<pid>` and
  renamed over `<out>`: an existing file is replaced atomically, and a failure
  leaves no file.
- Forbidden out paths: the DB file or its `-wal`/`-shm` (compared after
  resolving symlinks) are refused (`forbidden_out_path`), nothing is written.
- stdout: the out path, per-table row counts and `external_dependencies`
  (dependency edges that point at tasks outside the export).
- Exit codes: 0 ok, 1 refusal or error (unknown project, forbidden out path),
  2 usage error.

### Import

`dist/cli/import.js` (bin `task-tracker-import`) restores the projects of an
export file into the DB at `TASK_TRACKER_DB_PATH` (a missing DB is created).

```bash
npm run import -- backup.json
npm run import -- all.json --root-path-map /Users/old/Projects=/home/new/Projects
```

- Everything is checked before the single write transaction; any refusal
  writes nothing (a refused file does not even create or migrate the DB).
- Clash rule: a project `id`, `name` or `code_prefix` already in the target
  (or repeated inside the file) refuses the whole import. There is no merge.
- UUIDs, task numbers, sequences, timestamps, leases and `design_doc_hash` are
  kept as they are; the design doc is not re-hashed, so `check_doc_sync`
  reports whether the doc at the new root still matches.
- Cross-project dependencies: a dependency on a task that is in neither the
  file nor the target DB is skipped and listed (`skipped_dependencies`); every
  other reference must resolve inside the file or the import is refused
  (`dangling_reference`).
- `--root-path-map old=new` (repeatable, both sides absolute) rewrites
  `projects.root_path`, an absolute `design_doc_path`, `task_files.file_path`
  and string elements of `task_slices.artifacts` at a whole path-segment
  prefix. Hashes and history are left alone. Unused maps and artifacts that
  are not a JSON array are reported.
- stdout: the file, imported projects, per-table row counts, skipped
  dependencies, and rewrite counts when a map was given.
- Exit codes: 0 ok, 1 refusal or error (nothing written), 2 usage error
  (including a malformed `--root-path-map`).

### File format and versions

The file is `{ exported_at, format: "task-tracker-export", format_version,
projects: [{ project, rows }], schema_version }`. Rows are column -> value
objects, every column present; JSON-in-TEXT columns stay strings.

- `format_version` (currently 1) versions the envelope; any other value is
  refused (`unsupported_format`).
- `schema_version` versions the rows (the DB schema this build exports). A
  newer file is refused (`schema_mismatch`). An older file imports when its
  columns are a subset of this build's: an unknown table or column is refused,
  and a column missing from the file must be nullable or have a DEFAULT.
  Refusals name the table and column.

### MCP tools

- `export_projects` - args: `project_id` (id or unique name) or `all: true`
  (exactly one), `out_path` (absolute). Same forbidden-path rule as the CLI.
- `import_projects` - args: `path` (absolute), optional `root_path_map`
  (`{"/old/root": "/new/root"}`).

Both return only the path, projects, per-table counts, and the
dependency/rewrite reports, never the file's content. Refusals come back as
`isError` with the refusal code (`unsupported_format`, `schema_mismatch`,
`clash`, `dangling_reference`, `unknown_project`, `forbidden_out_path`).

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
