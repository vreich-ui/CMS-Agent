// Token endpoint. Exchanges an authorization code (with PKCE verification) or a refresh token for
// an opaque bearer access token the MCP endpoint accepts.
import { handleToken } from "../../src/agent/mcp/http/oauthEndpoints.js";
import { toOAuthRequest, type NetlifyFunctionEvent } from "../../src/agent/mcp/http/netlifyEvent.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";

export const handler = async (event: NetlifyFunctionEvent) => {
  connectLambdaBlobs(event);
  return handleToken(toOAuthRequest(event));
};
