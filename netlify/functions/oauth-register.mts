// RFC 7591 Dynamic Client Registration. Claude registers its redirect_uri here and receives a
// client_id before starting the authorization-code flow.
import { handleRegister } from "../../src/agent/mcp/http/oauthEndpoints.js";
import { toOAuthRequest, type NetlifyFunctionEvent } from "../../src/agent/mcp/http/netlifyEvent.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";

export const handler = async (event: NetlifyFunctionEvent) => {
  connectLambdaBlobs(event);
  return handleRegister(toOAuthRequest(event));
};
