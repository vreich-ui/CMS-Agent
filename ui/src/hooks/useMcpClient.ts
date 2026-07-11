import { useMemo, useRef } from "react";
import { createMcpClient } from "../mcp/client";
import type { McpClient } from "../mcp/client";
import type { McpConnection } from "../connection";

// Stable McpClient bound to the latest connection through a ref. The client identity never
// changes, so hooks can depend on [client] without re-creating callbacks per keystroke, while
// every request still uses the current mode/endpoint/credential.
export function useMcpClient(connection: McpConnection): McpClient {
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  return useMemo(() => createMcpClient(() => connectionRef.current), []);
}
