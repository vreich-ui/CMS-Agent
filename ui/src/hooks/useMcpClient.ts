import { useMemo, useRef } from "react";
import { createMcpClient } from "../mcp/client";
import type { McpClient } from "../mcp/client";
import type { McpConnection } from "../connection";

// The returned client's identity changes exactly when a field that determines WHICH SERVER/
// CREDENTIAL is used changes — mode, endpoint, the direct bearer token, or the secure-proxy token
// getter — so any hook that keys a data-loading effect on [client] (useWorkspace, useChanges,
// useProjects, ...) reliably re-runs when the user switches control plane / connection mode /
// credentials. Memoized on those primitive fields directly, never on the `connection` object
// itself (App.tsx's own connection useMemo already recreates that object with equal fields on
// unrelated renders, and a naive `[connection]` dependency — or the previous `[]` stable-singleton
// — would either churn needlessly or never change at all).
//
// The ref indirection is kept so a request already in flight (or fired between renders) always
// resolves the connection at CALL time rather than closing over a stale snapshot; it is populated
// every render and is not itself part of the client's identity.
export function useMcpClient(connection: McpConnection): McpClient {
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const credential = connection.mode === "direct" ? connection.token : connection.getAccessToken;
  return useMemo(() => createMcpClient(() => connectionRef.current), [connection.mode, connection.endpoint, credential]);
}
