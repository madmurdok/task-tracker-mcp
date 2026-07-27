import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../src/db/connection.js";
import { createServer } from "../src/dashboard/server.js";
import type { BoardData } from "../src/domain/board.js";
import { createProject } from "../src/domain/projects.js";
import { createTask } from "../src/domain/tasks.js";
import type { BudgetEstimator } from "../src/domain/budget.js";
import type { Server } from "node:http";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

describe("dashboard server", () => {
  let db: DatabaseInstance;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    server = createServer(db);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it("GET /api/projects lists registered projects as { id, name }", async () => {
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [{ id: project.id, name: "Demo" }] });
  });

  it("GET /api/projects/:id/board returns that project's board data", async () => {
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
    createTask(db, noopEstimator, { project_id: project.id, title: "Task A", complexity_hint: "normal" });

    const res = await fetch(`${baseUrl}/api/projects/${project.id}/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BoardData;
    expect(body.project_id).toBe(project.id);
    expect(body.lanes[0].tasks.map((t) => t.title)).toEqual(["Task A"]);
  });

  it("resolves a project by its unique name too, same as the MCP tools", async () => {
    const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });

    const res = await fetch(`${baseUrl}/api/projects/Demo/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BoardData;
    expect(body.project_id).toBe(project.id);
  });

  it("returns a clean 404 (not a 500) for an unknown project id", async () => {
    const res = await fetch(`${baseUrl}/api/projects/does-not-exist/board`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown project/);
  });

  it("returns 404 for a static asset that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist.html`);
    expect(res.status).toBe(404);
  });

  it("serves the picker page's static assets", async () => {
    const htmlRes = await fetch(`${baseUrl}/`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toMatch(/text\/html/);

    const jsRes = await fetch(`${baseUrl}/picker.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toMatch(/javascript/);
  });

  it("rejects a static path that tries to escape the public directory", async () => {
    const res = await fetch(`${baseUrl}/../../../../etc/passwd`);
    expect([403, 404]).toContain(res.status);
  });

  it("rejects non-GET requests", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("POST /api/shutdown responds ok and calls the injected onShutdown hook instead of exiting", async () => {
    let shutdownCalled = false;
    const shutdownServer = createServer(db, { onShutdown: () => (shutdownCalled = true) });
    await new Promise<void>((resolve) => shutdownServer.listen(0, "127.0.0.1", resolve));
    const { port } = shutdownServer.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // onShutdown fires on the response's "finish" event - asynchronous
      // relative to the fetch resolving, so give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shutdownCalled).toBe(true);
    } finally {
      await new Promise<void>((resolve) => shutdownServer.close(() => resolve()));
    }
  });
});
