import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type DatabaseInstance } from "../db/connection.js";
import { getBoardData } from "../domain/board.js";
import { listProjects } from "../domain/projects.js";

const DEFAULT_PORT = 4321;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Serves static files out of PUBLIC_DIR only - resolves the request path
 * first, then checks the result still lives under PUBLIC_DIR, so a request
 * like `/../../etc/passwd` can't escape it. This dashboard has no auth in
 * front of it (see REQUIREMENTS.md Item 8), so path traversal here would
 * otherwise expose the whole filesystem, not just the intended static assets.
 */
function serveStatic(res: http.ServerResponse, pathname: string): void {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

export interface CreateServerOptions {
  /**
   * Called once the /api/shutdown response has actually been flushed to the
   * client. Defaults to tearing the real process down - overridable so tests
   * can assert a shutdown was requested without killing the test process
   * itself.
   */
  onShutdown?: () => void;
}

/**
 * Read-only dashboard server (REQUIREMENTS.md Item 8): serves the static
 * picker/board pages plus a small JSON API built on the same domain functions
 * the MCP tools use. Takes an already-open DatabaseInstance rather than
 * opening one itself so tests can point it at a temp/`:memory:` DB and pick
 * an ephemeral listen port instead of the real one main() uses.
 */
export function createServer(db: DatabaseInstance, options: CreateServerOptions = {}): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Handled ahead of the GET-only gate below since it's the one
    // intentional non-GET route - everything else stays read-only.
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      sendJson(res, 200, { ok: true });
      // This is a single-user local dev tool, not a service with other
      // clients to protect - a fixed short delay after the response is
      // flushed (not a graceful server.close() drain) is simple and
      // deterministic, matching the "no distributed-systems concerns"
      // reasoning the architecture doc already applies elsewhere.
      const onShutdown = options.onShutdown ?? (() => setTimeout(() => process.exit(0), 50));
      res.on("finish", onShutdown);
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method not allowed");
      return;
    }

    if (url.pathname === "/api/projects") {
      sendJson(res, 200, { projects: listProjects(db).map(({ id, name }) => ({ id, name })) });
      return;
    }

    const boardMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/board$/);
    if (boardMatch) {
      try {
        sendJson(res, 200, getBoardData(db, decodeURIComponent(boardMatch[1])));
      } catch (error) {
        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    serveStatic(res, url.pathname);
  });
}

function main(): void {
  const port = Number(process.env.TASK_TRACKER_DASHBOARD_PORT ?? DEFAULT_PORT);
  const db = openDatabase();
  const server = createServer(db);
  // 127.0.0.1 only, never 0.0.0.0 - this server has no auth in front of it
  // and serves project file paths and task descriptions (see Item 8).
  server.listen(port, "127.0.0.1", () => {
    console.log(`Dashboard running at http://127.0.0.1:${port}/`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
