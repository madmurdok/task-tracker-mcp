import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { writeLegacyV1Db } from "./fixtures/legacyV1Db.js";

/**
 * D2 of docs/design/backup-restore.md: SCHEMA_VERSION versions the rows of an
 * export, and this literal pins it to the schema it describes. Each table in
 * name order, its columns in name order as `name|type|notnull|dflt_value|pk`
 * from PRAGMA table_info.
 *
 * When this fails because a table or column changed: bump SCHEMA_VERSION in
 * src/db/schema.ts and update the literal below in the same commit. Then add
 * tests/fixtures/backup/schema-v<old>.json (an export made before the bump)
 * and a test that imports it, so the subset rule's promise that older files
 * still import is checked rather than assumed.
 */
const EXPECTED = {
  SCHEMA_VERSION: 1,
  fingerprint: {
    "epics": [
      "created_at|TEXT|1|null|0",
      "description|TEXT|1|''|0",
      "id|TEXT|0|null|1",
      "name|TEXT|1|null|0",
      "project_id|TEXT|1|null|0"
    ],
    "handoff_notes": [
      "created_at|TEXT|1|null|0",
      "decisions|TEXT|1|''|0",
      "discoveries|TEXT|1|''|0",
      "id|TEXT|0|null|1",
      "remaining_work|TEXT|1|''|0",
      "session_id|TEXT|1|null|0",
      "task_id|TEXT|1|null|0"
    ],
    "projects": [
      "code_prefix|TEXT|0|null|0",
      "created_at|TEXT|1|null|0",
      "design_doc_hash|TEXT|0|null|0",
      "design_doc_path|TEXT|0|null|0",
      "id|TEXT|0|null|1",
      "name|TEXT|1|null|0",
      "root_path|TEXT|1|null|0"
    ],
    "release_plan_items": [
      "added_at|TEXT|1|null|0",
      "note|TEXT|1|''|0",
      "plan_id|TEXT|1|null|1",
      "position|INTEGER|1|null|0",
      "step|INTEGER|1|null|0",
      "task_id|TEXT|1|null|2"
    ],
    "release_plans": [
      "approval_note|TEXT|0|null|0",
      "approved_at|TEXT|0|null|0",
      "approved_by|TEXT|0|null|0",
      "created_at|TEXT|1|null|0",
      "id|TEXT|0|null|1",
      "rationale|TEXT|1|''|0",
      "release_id|TEXT|1|null|0",
      "status|TEXT|1|'draft'|0",
      "updated_at|TEXT|1|null|0"
    ],
    "releases": [
      "cancellation_reason|TEXT|0|null|0",
      "created_at|TEXT|1|null|0",
      "description|TEXT|1|''|0",
      "id|TEXT|0|null|1",
      "name|TEXT|1|''|0",
      "project_id|TEXT|1|null|0",
      "release_notes|TEXT|0|null|0",
      "released_at|TEXT|0|null|0",
      "sequence|INTEGER|1|null|0",
      "status|TEXT|1|'planned'|0",
      "version|TEXT|1|null|0"
    ],
    "task_amendments": [
      "amended_at|TEXT|1|null|0",
      "field|TEXT|1|null|0",
      "id|TEXT|0|null|1",
      "previous_value|TEXT|1|null|0",
      "reason|TEXT|1|null|0",
      "task_id|TEXT|1|null|0"
    ],
    "task_dependencies": [
      "depends_on_task_id|TEXT|1|null|2",
      "task_id|TEXT|1|null|1"
    ],
    "task_files": [
      "file_path|TEXT|1|null|0",
      "task_id|TEXT|1|null|0"
    ],
    "task_slice_revisions": [
      "id|TEXT|0|null|1",
      "reason|TEXT|1|null|0",
      "replaced_slices|TEXT|1|null|0",
      "revised_at|TEXT|1|null|0",
      "task_id|TEXT|1|null|0"
    ],
    "task_slices": [
      "artifacts|TEXT|1|'[]'|0",
      "brief|TEXT|1|''|0",
      "completed_at|TEXT|0|null|0",
      "created_at|TEXT|1|null|0",
      "exit_criterion|TEXT|1|''|0",
      "id|TEXT|0|null|1",
      "label_number|INTEGER|0|null|0",
      "metrics|TEXT|0|null|0",
      "model|TEXT|0|null|0",
      "phase|TEXT|1|null|0",
      "position|INTEGER|1|null|0",
      "result|TEXT|0|null|0",
      "started_at|TEXT|0|null|0",
      "status|TEXT|1|'pending'|0",
      "step|INTEGER|1|null|0",
      "task_id|TEXT|1|null|0",
      "title|TEXT|1|null|0",
      "updated_at|TEXT|1|null|0"
    ],
    "tasks": [
      "acceptance_criteria|TEXT|1|''|0",
      "cancellation_reason|TEXT|0|null|0",
      "completion_summary|TEXT|0|null|0",
      "complexity_hint|TEXT|1|'normal'|0",
      "created_at|TEXT|1|null|0",
      "description|TEXT|1|''|0",
      "epic_id|TEXT|0|null|0",
      "estimated_tokens|INTEGER|1|0|0",
      "id|TEXT|0|null|1",
      "lock_expires_at|TEXT|0|null|0",
      "owner_session_id|TEXT|0|null|0",
      "priority|INTEGER|1|0|0",
      "project_id|TEXT|1|null|0",
      "release_id|TEXT|0|null|0",
      "status|TEXT|1|'pending'|0",
      "task_number|INTEGER|0|null|0",
      "title|TEXT|1|null|0",
      "updated_at|TEXT|1|null|0"
    ]
  },
};

function fingerprint(db: DatabaseInstance): Record<string, string[]> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    out[name] = cols
      .map((c) => ({ key: c.name, text: `${c.name}|${c.type}|${c.notnull}|${c.dflt_value}|${c.pk}` }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((c) => c.text);
  }
  return out;
}

describe("schema version fingerprint (D2)", () => {
  it("pins { SCHEMA_VERSION, fingerprint } of a fresh database", () => {
    const db = openDatabase(":memory:");
    try {
      expect({ SCHEMA_VERSION, fingerprint: fingerprint(db) }).toEqual(EXPECTED);
    } finally {
      db.close();
    }
  });

  it("a migrated legacy (v1) database has the same fingerprint as a fresh one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-fp-"));
    try {
      const dbPath = path.join(dir, "legacy.db");
      writeLegacyV1Db(dbPath);
      const migrated = openDatabase(dbPath);
      const fresh = openDatabase(":memory:");
      try {
        expect(fingerprint(migrated)).toEqual(fingerprint(fresh));
      } finally {
        migrated.close();
        fresh.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
