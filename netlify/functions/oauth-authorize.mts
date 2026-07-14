// Authorization endpoint. GET renders the human consent screen; POST verifies the workspace
// approval secret and redirects back to the client with a one-time authorization code. This is the
// step that replaces the old dead-end dashboard redirect and lets Claude finish authenticating.
import { handleAuthorize } from "../../src/agent/mcp/http/oauthEndpoints.js";
import { toOAuthRequest, type NetlifyFunctionEvent } from "../../src/agent/mcp/http/netlifyEvent.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";

export const handler = async (event: NetlifyFunctionEvent) => {
  connectLambdaBlobs(event);
  return handleAuthorize(toOAuthRequest(event));
};
