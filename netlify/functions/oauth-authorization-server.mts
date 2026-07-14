// RFC 8414 Authorization Server Metadata. Advertises the authorize/token/register endpoints and
// that PKCE S256 is required.
import { handleAuthorizationServerMetadata } from "../../src/agent/mcp/http/oauthEndpoints.js";
import { toOAuthRequest, type NetlifyFunctionEvent } from "../../src/agent/mcp/http/netlifyEvent.js";

export const handler = async (event: NetlifyFunctionEvent) => handleAuthorizationServerMetadata(toOAuthRequest(event));
