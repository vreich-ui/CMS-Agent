// Deprecated location. The project MCP adapter is generic (works on any ProjectConnectionConfig)
// and lives at src/agent/projects/projectMcpAdapter.ts; it was moved out of the drLurie folder so
// generic callers no longer import from a single client's module. This re-export keeps old import
// paths working and will be removed once nothing references it.
export * from "../projectMcpAdapter.js";
