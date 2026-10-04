#!/usr/bin/env node
// SessionEnd hook entry (docs/design/TTM-100-session-end.md, section 4): expires
// the leases held by the ending Claude Code session and logs one line. It must
// never disturb the exit: nothing on stdout/stderr (stderr is shown to the
// user), exit code 0 whatever happens, a log-write failure included.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { defaultDbPath } from "../db/connection.js";
import { expireSessionLeases } from "../domain/lifecycle.js";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function main(): void {
  const now = new Date();
  const nowIso = now.toISOString();
  let dbPath: string | undefined;
  let sessionId = "-";
  let reason = "-";
  let outcome: string;

  try {
    dbPath = defaultDbPath();
    const payload = JSON.parse(fs.readFileSync(0, "utf8")) as unknown;
    if (payload === null || typeof payload !== "object") {
      throw new Error("stdin payload is not a JSON object");
    }
    const fields = payload as { session_id?: unknown; reason?: unknown };
    if (typeof fields.reason === "string" && fields.reason !== "") reason = fields.reason;
    if (typeof fields.session_id !== "string" || fields.session_id === "") {
      throw new Error("stdin payload has no session_id");
    }
    sessionId = fields.session_id;

    // Not openDatabase: that would mkdir, create a missing DB and run
    // migrations, none of which belong in a 1.5 s exit hook.
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.pragma("busy_timeout = 1000");
      const expired = expireSessionLeases(db, sessionId, nowIso);
      outcome = `expired ${expired.length > 0 ? expired.join(",") : "none"}`;
    } finally {
      db.close();
    }
  } catch (error) {
    outcome = `error ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    if (dbPath === undefined) return;
    const month = nowIso.slice(0, 7); // UTC YYYY-MM, one log file per month
    const logPath = path.join(path.dirname(dbPath), `session-end-${month}.log`);
    const line = [nowIso, sessionId, reason, outcome].map(oneLine).join("\t");
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    // Nowhere left to report it without reaching the user's terminal.
  }
}

try {
  main();
} catch {
  // main already catches everything; this only guards the unexpected.
}
process.exitCode = 0;
