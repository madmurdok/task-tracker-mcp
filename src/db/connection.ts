import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.js";

export function defaultDbPath(): string {
  return (
    process.env.TASK_TRACKER_DB_PATH ??
    path.join(os.homedir(), ".task-tracker", "tracker.db")
  );
}

export function openDatabase(dbPath: string = defaultDbPath()): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(SCHEMA_SQL);
  return db;
}

export type DatabaseInstance = Database.Database;
