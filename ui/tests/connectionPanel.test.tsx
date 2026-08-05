import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectionPanel } from "../src/components/ConnectionPanel";
import type { McpConnection } from "../src/connection";
import type { McpClient } from "../src/mcp/client";

const client: McpClient = {
  method: async () => ({ serverInfo: { name: "test" }, protocolVersion: "2025-06-18" }) as never,
  call: async () => { throw new Error("unused"); }
};

const connection: McpConnection = { endpoint: "https://cms-agent-mcp.example.run.app/mcp", token: "t" };

const baseProps = {
  connection,
  client,
  token: "t",
  onEndpointChange: () => {},
  onTokenChange: () => {},
  onConnectionSuccess: () => {},
  onConnectionError: () => {}
};

// GCloud-only: there is no control-plane or connection-mode choice anywhere in this panel — just
// the Cloud Run endpoint override and the bearer token.
describe("ConnectionPanel", () => {
  it("never renders a control-plane or connection-mode switch", () => {
    render(<ConnectionPanel {...baseProps} />);
    expect(screen.queryByText("Control plane")).toBeNull();
    expect(screen.queryByText("Connection mode")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("exposes the endpoint as free text, editable for local dev", () => {
    let latest = "";
    render(<ConnectionPanel {...baseProps} onEndpointChange={(value) => { latest = value; }} />);
    const input = screen.getByLabelText("Cloud Run MCP endpoint");
    expect(input).toHaveValue(connection.endpoint);
    fireEvent.change(input, { target: { value: "http://localhost:9999/mcp" } });
    expect(latest).toBe("http://localhost:9999/mcp");
  });
});
