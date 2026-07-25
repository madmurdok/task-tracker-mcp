import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db/connection.js";
import { createServer } from "./mcp/server.js";

const db = openDatabase();
const server = createServer(db);
const transport = new StdioServerTransport();

await server.connect(transport);
