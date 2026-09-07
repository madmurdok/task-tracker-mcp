import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { createServer } from "../src/mcp/server.js";
import { packageVersion } from "../src/version.js";

/**
 * Resolved from this test file's own location, not from process.cwd() and not
 * through packageVersion() - reading the manifest independently is the entire
 * point. A test that asked packageVersion() what the version is and then
 * compared it to packageVersion() would agree with itself no matter how wrong
 * both were, which is the shape of the bug this file exists to prevent.
 */
function manifestVersion(): string {
  const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
}

describe("the version a client sees in the MCP handshake", () => {
  it("is the version package.json carries, read over a real initialize", async () => {
    // A real handshake, deliberately, rather than reading the literal out of
    // src/mcp/server.ts: reading the source is exactly what everybody did for
    // two releases while the handshake reported 0.5.0.
    const db = openDatabase(":memory:");
    const server = createServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "version-test-client", version: "0.0.1" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const advertised = client.getServerVersion();
    expect(advertised).toMatchObject({ name: "task-tracker-mcp", version: manifestVersion() });

    db.close();
  });

  it("comes from the manifest rather than a literal, so a bump cannot leave it behind", () => {
    // The assertion that actually stops the drift recurring. It names no
    // version, so it keeps holding across every future bump - and fails the
    // moment somebody reintroduces a hardcoded one that disagrees.
    expect(packageVersion()).toBe(manifestVersion());
  });

  it("fails loudly rather than defaulting when the manifest has no version", () => {
    // The alternative - falling back to some placeholder - would recreate the
    // original bug in a worse form: a version that looks real, is wrong, and
    // has no literal in the source left to grep for.
    const dir = mkdtempSync(path.join(tmpdir(), "ttmcp-no-version-"));
    try {
      const versionless = path.join(dir, "package.json");
      writeFileSync(versionless, JSON.stringify({ name: "x" }));
      expect(() => packageVersion(versionless)).toThrow(/no usable "version" field/);

      const emptyVersion = path.join(dir, "empty.json");
      writeFileSync(emptyVersion, JSON.stringify({ name: "x", version: "" }));
      expect(() => packageVersion(emptyVersion)).toThrow(/no usable "version" field/);

      // A non-string version is the case a `typeof` check catches and a
      // truthiness check would not: 0.7 as a JSON number would otherwise
      // sail through and be advertised as the number 0.7.
      const numericVersion = path.join(dir, "numeric.json");
      writeFileSync(numericVersion, JSON.stringify({ name: "x", version: 0.7 }));
      expect(() => packageVersion(numericVersion)).toThrow(/no usable "version" field/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the manifest it could not read, so the failure is actionable", () => {
    const missing = path.join(tmpdir(), "ttmcp-definitely-absent", "package.json");
    expect(() => packageVersion(missing)).toThrow(/ttmcp-definitely-absent/);
  });
});
