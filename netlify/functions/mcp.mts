// Thin Netlify adapter over the transport-neutral MCP endpoint core
// (src/agent/mcp/http/mcpEndpoint.ts), mirroring the OAuth function adapters. Netlify-specific
// request lifecycle (connect Lambda Blobs, refresh the per-request repository manager) lives in
// src/agent/mcp/http/netlifyMcpAdapter.ts; all auth/session/dispatch logic is shared with the Cloud
// Run MCP Service.
//
// The lifecycle used to live in THIS file, and workspace-mcp.mts reached into it by importing this
// function directly. That cross-function import is what produced the ERR_REQUIRE_ESM 502 that has
// answered every request to both functions since 2026-08-14, taking the Conductor Workbench's only
// data path with it — see netlifyMcpAdapter.ts's header. Keep this file an entry point and nothing
// more: never import it from another function.
import { handleNetlifyMcpRequest, type NetlifyMcpEvent } from "../../src/agent/mcp/http/netlifyMcpAdapter.js";

export const handler = async (event: NetlifyMcpEvent) => handleNetlifyMcpRequest(event);
