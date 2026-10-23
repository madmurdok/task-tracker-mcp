#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openDatabase } from "../db/connection.js";
import { BackupRefusal, RootPathMapError, importFromFile, parseRootPathMap } from "../domain/backup.js";

const USAGE = `Usage: task-tracker-import <file> [--root-path-map <old>=<new>]...

Restores the projects of a task-tracker-export file into the database. A
project whose id, name or code_prefix already exists refuses the whole import;
nothing is written on any refusal. --root-path-map (repeatable, absolute paths)
rewrites root_path, design_doc_path, task file paths and slice artifacts.
Exit codes: 0 ok, 1 refusal or error, 2 usage.`;

function usageError(message: string): void {
  console.error(`${message}\n\n${USAGE}`);
  process.exitCode = 2;
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        "root-path-map": { type: "string", multiple: true, default: [] },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    usageError((err as Error).message);
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) return usageError("Give exactly one export file");
  const rootPathMap = values["root-path-map"] ?? [];
  try {
    parseRootPathMap(rootPathMap);
  } catch (err) {
    if (err instanceof RootPathMapError) return usageError(err.message);
    throw err;
  }

  const db = openDatabase();
  try {
    const result = importFromFile(db, positionals[0] as string, { rootPathMap });
    console.log(result.path);
    for (const p of result.projects) {
      console.log(`  project: ${p.code_prefix ?? "-"} ${p.name} (${p.id})`);
    }
    for (const [table, count] of Object.entries(result.counts)) {
      console.log(`  ${table}: ${count}`);
    }
    console.log(`  skipped_dependencies: ${result.skipped_dependencies.length}`);
    for (const s of result.skipped_dependencies) {
      console.log(`    ${s.task_id} -> ${s.depends_on_task_id} (target not in the file or the database)`);
    }
    if (rootPathMap.length > 0) {
      for (const [column, count] of Object.entries(result.root_path_rewrites)) {
        console.log(`  rewritten ${column}: ${count}`);
      }
      for (const entry of result.unused_root_path_maps) console.log(`  unused root-path map: ${entry}`);
      for (const id of result.artifacts_not_rewritten) console.log(`  artifacts not rewritten (not a JSON array): slice ${id}`);
    }
  } catch (err) {
    if (err instanceof BackupRefusal) {
      console.error(err.message);
    } else {
      console.error(`Import failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
