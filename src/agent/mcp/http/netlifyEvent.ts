// Adapter from the Netlify (Lambda-compat) function event to the transport-neutral request shapes
// used by the endpoint logic. Keeps the .mts handlers to a couple of lines each.

import type { OAuthRequest } from "./oauthEndpoints.js";

export type NetlifyFunctionEvent = {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body: string | null;
  blobs?: string;
};

export const toOAuthRequest = (event: NetlifyFunctionEvent): OAuthRequest => ({
  httpMethod: event.httpMethod,
  headers: event.headers ?? {},
  query: event.queryStringParameters ?? {},
  body: event.body ?? null
});
