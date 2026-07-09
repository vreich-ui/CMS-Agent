import { describe, expect, it } from "vitest";
import { orderWorkspaceNodesForDisplay } from "../../ui/src/workspaceOrder.js";
import type { WorkspaceNode } from "../../ui/src/types/workspace.js";

// Canonical Publishing Conductor layout: row-major grid (three columns per row).
const canonical: WorkspaceNode[] = [
  { id: "input_triage", name: "Input Triage", prompt: "", position: { x: 0, y: 0 } },
  { id: "topic_opportunity", name: "Topic Opportunity", prompt: "", position: { x: 280, y: 0 } },
  { id: "reader_insight", name: "Reader Insight", prompt: "", position: { x: 560, y: 0 } },
  { id: "research", name: "Research", prompt: "", position: { x: 840, y: 0 } },
  { id: "objection_mapping", name: "Objection Mapping", prompt: "", position: { x: 1120, y: 0 } },
  { id: "narrative_movement", name: "Narrative Movement", prompt: "", position: { x: 0, y: 180 } }
];
const canonicalIds = canonical.map((node) => node.id);

describe("orderWorkspaceNodesForDisplay (UI graph ordering)", () => {
  it("returns nodes in canonical position order regardless of input order", () => {
    const shuffled = [...canonical].reverse();
    expect(orderWorkspaceNodesForDisplay(shuffled).map((node) => node.id)).toEqual(canonicalIds);
  });

  it("keeps research in its canonical slot even if it arrives last (post-update storage order)", () => {
    const researchLast = [...canonical.filter((node) => node.id !== "research"), canonical.find((node) => node.id === "research")!];
    const ordered = orderWorkspaceNodesForDisplay(researchLast).map((node) => node.id);
    expect(ordered).toEqual(canonicalIds);
    expect(ordered[ordered.length - 1]).not.toBe("research");
  });

  it("preserves input order for nodes without positions", () => {
    const noPositions: WorkspaceNode[] = [
      { id: "a", name: "A", prompt: "" },
      { id: "b", name: "B", prompt: "" },
      { id: "c", name: "C", prompt: "" }
    ];
    expect(orderWorkspaceNodesForDisplay(noPositions).map((node) => node.id)).toEqual(["a", "b", "c"]);
  });
});
