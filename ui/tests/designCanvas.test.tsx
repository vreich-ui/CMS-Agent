import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesignCanvas } from "../src/components/constellation/DesignCanvas";
import { defaultDesignLayers } from "../src/designGraph";
import type { WorkspaceNode } from "../src/types/workspace";

const node = (id: string, overrides: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id,
  name: id,
  prompt: "must never appear on the canvas",
  kind: "agent",
  status: "active",
  riskLevel: "publish",
  dependsOn: [],
  position: { x: 40, y: 40 },
  ...overrides
});

// Smoke-level only: jsdom's no-op ResizeObserver means React Flow never completes measurement,
// so interaction depth lives in tests/ui/designGraph.test.ts and the live Playwright drive.
describe("DesignCanvas", () => {
  it("mounts React Flow with the minimal agent cards and no prompt leakage", () => {
    const { container } = render(<DesignCanvas
      nodes={[node("alpha"), node("beta", { dependsOn: ["alpha"], position: { x: 400, y: 40 } })]}
      relationships={[]}
      layers={defaultDesignLayers}
      selectedId={null}
      selectedEdgeId={null}
      saving={false}
      onSelectNode={() => {}}
      onSelectEdge={() => {}}
      onMoveNode={() => {}}
      onConnectDependency={() => {}}
      onRequestEdgeDelete={() => {}}
    />);

    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getAllByText("publish")).toHaveLength(2);
    expect(screen.getByText("0 skills · 0 tools · 1 deps")).toBeInTheDocument();
    expect(screen.queryByText(/must never appear/)).not.toBeInTheDocument();
  });
});
