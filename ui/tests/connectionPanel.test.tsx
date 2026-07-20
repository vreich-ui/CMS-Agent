import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionPanel } from "../src/components/ConnectionPanel";
import type { McpConnection } from "../src/connection";
import type { McpClient } from "../src/mcp/client";

const client: McpClient = {
  method: async () => ({ serverInfo: { name: "test" }, protocolVersion: "2025-06-18" }) as never,
  call: async () => { throw new Error("unused"); }
};

const directConnection: McpConnection = { mode: "direct", endpoint: "/api/mcp", token: "t" };

const baseProps = {
  connection: directConnection,
  client,
  token: "t",
  onModeChange: vi.fn(),
  onEndpointChange: vi.fn(),
  onTokenChange: vi.fn(),
  onConnectionSuccess: vi.fn(),
  onConnectionError: vi.fn()
};

describe("ConnectionPanel control-plane switch", () => {
  it("hides the switch when Cloud Run is unavailable, and hides the mode switch under Cloud Run", () => {
    const { rerender } = render(<ConnectionPanel {...baseProps} cloudRunAvailable={false} />);
    expect(screen.queryByText("Control plane")).toBeNull();
    // Netlify plane still shows the auth mode switch.
    expect(screen.getByText("Connection mode")).toBeTruthy();

    rerender(<ConnectionPanel {...baseProps} cloudRunAvailable controlPlane="cloud-run" onPlaneChange={vi.fn()} />);
    expect(screen.getByText("Control plane")).toBeTruthy();
    // Under Cloud Run the auth-mode switch is hidden (Cloud Run is direct-token only).
    expect(screen.queryByText("Connection mode")).toBeNull();
  });

  it("fires onPlaneChange when a plane is selected", async () => {
    const onPlaneChange = vi.fn();
    render(<ConnectionPanel {...baseProps} cloudRunAvailable controlPlane="netlify" onPlaneChange={onPlaneChange} />);
    // Both plane radios and the Netlify mode switch are present.
    expect(screen.getByText("Control plane")).toBeTruthy();
    expect(screen.getByText("Connection mode")).toBeTruthy();

    await userEvent.click(screen.getByRole("radio", { name: "Cloud Run" }));
    expect(onPlaneChange).toHaveBeenCalledWith("cloud-run");
  });
});
