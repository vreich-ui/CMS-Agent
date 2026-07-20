// Process wrapper: starting the MCP server is a side effect, kept out of mcpServerMain.ts so that
// module can be imported by tests without binding a port.
import { startMcpServer } from "./mcpServerMain.js";

startMcpServer();
