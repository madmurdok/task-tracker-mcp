import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { createServer } from "../src/mcp/server.js";
import { insertProject, seedFullProject } from "./fixtures/backupSeed.js";

/**
 * TTM-108: the export_projects / import_projects MCP wrappers
 * (docs/design/backup-restore.md D11). Domain behaviour is pinned in
 * backup-export.test.ts and backup-import.test.ts; this file pins argument
 * handling, refusal mapping and the "no payload in the result" rule.
 */

let dir: string;
let source: DatabaseInstance;
let target: DatabaseInstance;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "ttmcp-mcpbackup-"));
  dbPath = path.join(dir, "source.db");
  source = openDatabase(dbPath);
  target = openDatabase(path.join(dir, "target.db"));
  seedFullProject(source, "alpha", "Alpha", "2026-01-01T00:00:00.000Z");
  insertProject(source, "beta", "Beta", "2026-01-02T00:00:00.000Z");
});
afterEach(() => {
  source.close();
  target.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function clientFor(db: DatabaseInstance) {
  const server = createServer(db);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return { isError: result.isError === true, text, json: text.startsWith("{") ? JSON.parse(text) : undefined };
}

const count = (db: DatabaseInstance, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("export_projects", () => {
  it("writes the file and returns path and counts, never the payload", async () => {
    const out = path.join(dir, "one.json");
    const r = await call(await clientFor(source), "export_projects", { project_id: "Alpha", out_path: out });

    expect(r.isError).toBe(false);
    expect(r.json.path).toBe(out);
    expect(r.json.projects).toBeDefined();
    expect(r.json.counts).toBeDefined();
    expect(fs.existsSync(out)).toBe(true);

    const fileText = fs.readFileSync(out, "utf8");
    expect(fileText).toContain("Task 1"); // the row data is in the file...
    expect(r.text).not.toContain("Task 1"); // ...but not in the result
    expect(r.text).not.toContain("Task 2");
    expect(r.text).not.toContain('"rows"');
    expect(r.text.length).toBeLessThan(fileText.length);
    expect(r.text.length).toBeLessThan(3000);
  });

  it("exports every project with all:true", async () => {
    const out = path.join(dir, "all.json");
    const r = await call(await clientFor(source), "export_projects", { all: true, out_path: out });

    expect(r.isError).toBe(false);
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(doc.projects).toHaveLength(2);
  });

  it.each([
    ["neither project_id nor all", {}],
    ["both project_id and all", { project_id: "Alpha", all: true }],
  ])("rejects %s without writing", async (_label, args) => {
    const out = path.join(dir, "bad.json");
    const r = await call(await clientFor(source), "export_projects", { ...args, out_path: out });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/exactly one/i);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("rejects a relative out_path", async () => {
    const r = await call(await clientFor(source), "export_projects", { all: true, out_path: "rel/out.json" });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/absolute/);
    expect(fs.existsSync(path.join(process.cwd(), "rel/out.json"))).toBe(false);
  });

  it("maps an unknown project to an unknown_project refusal", async () => {
    const out = path.join(dir, "none.json");
    const r = await call(await clientFor(source), "export_projects", { project_id: "nope", out_path: out });

    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("unknown_project");
    expect(typeof r.json.message).toBe("string");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("maps the database file itself to a forbidden_out_path refusal and leaves the DB intact", async () => {
    const r = await call(await clientFor(source), "export_projects", { all: true, out_path: dbPath });

    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("forbidden_out_path");
    expect(count(source, "projects")).toBe(2);
  });
});

describe("import_projects", () => {
  async function exportAll(): Promise<string> {
    const out = path.join(dir, "backup.json");
    const r = await call(await clientFor(source), "export_projects", { all: true, out_path: out });
    expect(r.isError).toBe(false);
    return out;
  }

  it("round-trips export -> import into a second DB, reporting counts only", async () => {
    const out = await exportAll();
    const r = await call(await clientFor(target), "import_projects", { path: out });

    expect(r.isError).toBe(false);
    expect(r.json.path).toBe(out);
    expect(r.json.counts).toBeDefined();
    expect(r.text).not.toContain("Task 1");
    expect(r.text).not.toContain('"rows"');
    expect(r.text.length).toBeLessThan(3000);

    for (const table of ["projects", "tasks", "epics"]) {
      expect(count(target, table)).toBe(count(source, table));
    }
    expect(target.prepare("SELECT title FROM tasks WHERE id = 'alpha-t1'").get()).toEqual({ title: "Task 1" });

    const listed = await call(await clientFor(target), "list_tasks", { project_id: "Alpha" });
    expect(listed.isError).toBe(false);
  });

  it("refuses a clash with existing data as a coded refusal and inserts nothing more", async () => {
    const out = await exportAll();
    const client = await clientFor(target);
    expect((await call(client, "import_projects", { path: out })).isError).toBe(false);
    const before = count(target, "tasks");

    const again = await call(client, "import_projects", { path: out });

    expect(again.isError).toBe(true);
    expect(again.json.error).toBe("clash");
    expect(count(target, "tasks")).toBe(before);
    expect(count(target, "projects")).toBe(2);
  });

  it("refuses an unsupported format_version and leaves the DB empty", async () => {
    const out = await exportAll();
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    doc.format_version = 99;
    fs.writeFileSync(out, JSON.stringify(doc));

    const r = await call(await clientFor(target), "import_projects", { path: out });

    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("unsupported_format");
    expect(count(target, "projects")).toBe(0);
  });

  it("rejects a relative path", async () => {
    const r = await call(await clientFor(target), "import_projects", { path: "backup.json" });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/absolute/);
  });

  it("rejects a non-absolute root_path_map side as a plain error and inserts nothing", async () => {
    const out = await exportAll();
    const r = await call(await clientFor(target), "import_projects", {
      path: out,
      root_path_map: { relative: "/new/root" },
    });

    expect(r.isError).toBe(true);
    expect(r.json?.error).toBeUndefined();
    expect(count(target, "projects")).toBe(0);
  });

  it("applies root_path_map to project root paths", async () => {
    const out = await exportAll();
    const r = await call(await clientFor(target), "import_projects", {
      path: out,
      root_path_map: { "/repo": "/moved" },
    });

    expect(r.isError).toBe(false);
    const roots = target.prepare("SELECT root_path FROM projects ORDER BY id").all();
    expect(roots).toEqual([{ root_path: "/moved/alpha" }, { root_path: "/moved/beta" }]);
  });
});

describe("README", () => {
  it("lists both backup tools", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("`export_projects`");
    expect(readme).toContain("`import_projects`");
  });
});
