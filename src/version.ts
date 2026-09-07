import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single place this package's version is read, so that nothing retypes
 * it. `src/mcp/server.ts` used to carry `version: "0.5.0"` as a literal while
 * package.json said 0.6.0, and the drift mattered: the version a client sees
 * in the MCP handshake was the only signal available for "the server you are
 * talking to predates the fix you are relying on", and it was lying. A
 * `set_task_release` call answered `{ok: true}` and changed nothing, against a
 * deployed build older than the fix for exactly that silent no-op, and nothing
 * in the protocol could say so.
 *
 * Read at runtime rather than imported: `tsconfig.build.json` sets
 * `rootDir: "src"`, so an `import "../../package.json"` (even with
 * resolveJsonModule on) is outside the root and tsc refuses to emit it.
 *
 * One level up resolves to the project root from BOTH layouts, which is what
 * makes a single path work in dev and in the build: this file sits at
 * `src/version.ts` and compiles to `dist/version.js`, and `src/..` and
 * `dist/..` are the same directory. That equality is why the file lives at the
 * top of `src/` rather than beside its first caller in `src/mcp/` - moving it
 * a directory deeper silently changes what this path resolves to, so if it
 * ever moves, this line moves with it.
 * Anchored on `import.meta.url`, never on `process.cwd()` - the MCP
 * server is started by a client from whatever directory that client happens to
 * be in.
 *
 * The manifest path is a parameter with that resolution as its default, so the
 * function is "read a version out of the manifest at this path" rather than
 * something only callable against one file. That is what lets the versionless
 * and malformed cases be tested against a manifest a test writes, instead of
 * by copying this module somewhere else and fighting the runner's resolver.
 */
export function defaultManifestPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
}

export function packageVersion(manifestPath: string = defaultManifestPath()): string {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: unknown };

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    // Loud rather than a fallback string. A default here would recreate the
    // original bug in a worse form: a version that looks real, is wrong, and
    // has no literal in the source to grep for.
    throw new Error(`package.json at ${manifestPath} has no usable "version" field`);
  }

  return manifest.version;
}
