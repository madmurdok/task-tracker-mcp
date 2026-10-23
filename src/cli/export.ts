#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openDatabase } from "../db/connection.js";
import { BackupRefusal, exportToFile, type ExportSelection } from "../domain/backup.js";

const USAGE = `Usage: task-tracker-export (<project_id_or_name> | --all) --out <file>

Writes a JSON backup of one project, or of every project with --all.
An existing <file> is replaced atomically. Exit codes: 0 ok, 1 refusal or error, 2 usage.`;

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
        all: { type: "boolean", default: false },
        out: { type: "string" },
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
  if (positionals.length > 1) return usageError(`Expected one project, got: ${positionals.join(" ")}`);
  const [ref] = positionals;
  if (ref !== undefined && values.all) return usageError("A project and --all are mutually exclusive");
  if (ref === undefined && !values.all) return usageError("Give a project or --all");
  if (!values.out) return usageError("--out <file> is required");

  const selection: ExportSelection = values.all ? { all: true } : (ref as string);
  const db = openDatabase();
  try {
    const result = exportToFile(db, selection, values.out);
    console.log(result.path);
    for (const [table, count] of Object.entries(result.counts)) {
      console.log(`  ${table}: ${count}`);
    }
    console.log(`  external_dependencies: ${result.external_dependencies}`);
  } catch (err) {
    if (err instanceof BackupRefusal) {
      console.error(err.message);
    } else {
      console.error(`Export failed: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
