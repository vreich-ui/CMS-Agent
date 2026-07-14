// RFC 9728 Protected Resource Metadata. Served ahead of the SPA catch-all so Claude's connector
// discovers the authorization server instead of receiving the dashboard HTML.
import { handleProtectedResourceMetadata } from "../../src/agent/mcp/http/oauthEndpoints.js";
import { toOAuthRequest, type NetlifyFunctionEvent } from "../../src/agent/mcp/http/netlifyEvent.js";

export const handler = async (event: NetlifyFunctionEvent) => handleProtectedResourceMetadata(toOAuthRequest(event));
