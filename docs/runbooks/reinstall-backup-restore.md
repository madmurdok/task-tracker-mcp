# Runbook: back up before a reinstall, restore after

Moves the whole tracker (all projects) across a reinstall of the machine or of
`~/.task-tracker`. Reference: the "Backup & restore" section of `README.md` and
`docs/design/backup-restore.md`. Every command below was run end-to-end against
scratch copies (never the live DB) when this runbook was written.

`$BK` below is the backup file, e.g. `$BK=/Volumes/usb/task-tracker-all.json`.

## Before the reinstall

1. Build the current checkout (the bins are `dist/cli/*.js`):

   ```bash
   cd <task-tracker-mcp checkout>
   npm run build
   ```

2. Stop sessions that write to the tracker (an MCP server holding the DB is
   fine for a read, but changes made after the export are not in the file).
3. Export everything:

   ```bash
   node dist/cli/export.js --all --out "$BK"
   ```

   Exit 0 and a list of per-table row counts is success. Note the counts
   (`projects`, `tasks`, ...). `external_dependencies` should be 0 with `--all`;
   a non-zero value means edges point at tasks that are not in the file (they
   will be skipped on import).
   `--out` may not be the DB or its `-wal`/`-shm` (refused, exit 1).
4. Keep the file outside `~/.task-tracker` and outside the repo checkout: both
   are what a reinstall wipes. Use an external drive or cloud storage, and keep
   a second copy. The file holds task text, notes and absolute paths: treat it
   as private.
5. Check the file against the DB: the counts printed by the export are the
   ones to match after the restore. Optionally record the status for
   comparison: `node dist/cli/status.js > status-before.txt`.

## After the reinstall

1. Install and build the tracker again (`npm ci && npm run build`). Do not
   start any MCP session against it yet, so the DB stays empty.
2. Import into the fresh DB (`TASK_TRACKER_DB_PATH`, default
   `~/.task-tracker/tracker.db`, is created if missing):

   ```bash
   node dist/cli/import.js "$BK"
   ```

   If the home layout changed (another user name, another projects directory),
   map the old prefix to the new one; repeat `--root-path-map` per prefix:

   ```bash
   node dist/cli/import.js "$BK" --root-path-map /Users/old/Projects=/Users/new/Projects
   ```

   Exit 0 prints the imported projects, the same per-table counts as the
   export, `skipped_dependencies: 0`, and with a map the rewrite counts
   (`rewritten projects.root_path: <n>`, ...) plus any `unused root-path map`
   line (a typo in `old`). Exit 1 means nothing was written: a clash means the
   target is not empty (a project with that id, name or code_prefix exists);
   `schema_mismatch` means the file is newer than this build (update the
   checkout) or incompatible. Fix the cause and rerun; no cleanup is needed.
   Do not rerun a successful import: the second run is refused as a clash.
3. Verify:
   - `node dist/cli/status.js` lists every project with the task totals
     recorded before (`diff status-before.txt <(node dist/cli/status.js)`;
     with a root-path map only the `root:` lines differ).
   - Re-export and compare with the backup:

     ```bash
     node dist/cli/export.js --all --out "$BK.check"
     diff "$BK" "$BK.check"
     ```

     Without a root-path map the only difference is the `exported_at` line
     (`diff` exits 1 for that one line, which is expected); the counts printed
     must equal the pre-reinstall ones. With a map, the differing lines are the
     rewritten paths (`root_path`, and any `file_path`/`artifacts` under the
     old prefix).
   - `check_doc_sync` on a project reports whether its design doc at the new
     root matches the stored hash; the import never re-hashes.
4. Delete `"$BK.check"`. Keep `$BK` until the tracker has been used normally
   for a while.
