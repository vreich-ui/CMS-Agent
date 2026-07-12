import { describe, expect, it } from "vitest";
import {
  arrangeGridPositions,
  buildDesignEdges,
  buildDesignNodes,
  connectDependencyPatch,
  defaultDesignLayers,
  describeMutationError,
  graphListEntries,
  hasIdenticalPositions,
  layerAvailability,
  removeDependencyPatch
} from "../../ui/src/designGraph.js";
import type { WorkspaceNode, WorkspaceRelationship } from "../../ui/src/types/workspace.js";

const node = (id: string, overrides: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id,
  name: id.replace(/_/g, " "),
  prompt: "irrelevant to the canvas",
  kind: "agent",
  status: "active",
  riskLevel: "read",
  dependsOn: [],
  position: { x: 0, y: 0 },
  ...overrides
});

const relationship = (id: string, overrides: Partial<WorkspaceRelationship> = {}): WorkspaceRelationship => ({
  id,
  kind: "data",
  sourceId: "alpha",
  targetId: "beta",
  direction: "forward",
  enabled: true,
  createdAt: "2026-07-01T10:00:00Z",
  updatedAt: "2026-07-01T10:00:00Z",
  ...overrides
});

describe("buildDesignNodes", () => {
  it("passes stored positions through untouched and derives counts", () => {
    const models = buildDesignNodes([
      node("alpha", { position: { x: 560, y: 180 }, assignedSkills: ["s1", "s2"], allowedTools: ["t1"], dependsOn: ["beta"] })
    ]);
    expect(models[0].position).toEqual({ x: 560, y: 180 });
    expect(models[0].counts).toEqual({ skills: 2, tools: 1, dependsOn: 1 });
  });
});

describe("buildDesignEdges", () => {
  const nodes = [
    node("gamma", { dependsOn: ["alpha", "beta"] }),
    node("alpha"),
    node("beta", { dependsOn: ["alpha"] })
  ];

  it("derives execution edges from dependsOn (dependency → dependent), never a linear chain", () => {
    const edges = buildDesignEdges(nodes, [], defaultDesignLayers);
    expect(edges.map((edge) => edge.id).sort()).toEqual(["dep:alpha->beta", "dep:alpha->gamma", "dep:beta->gamma"]);
    // Array order (gamma first) must not fabricate gamma→alpha or alpha→beta-by-adjacency edges.
    expect(edges.every((edge) => edge.kind === "execution" && !edge.readonly)).toBe(true);
  });

  it("drops execution edges whose dependency is not a known node", () => {
    const edges = buildDesignEdges([node("alpha", { dependsOn: ["ghost"] })], [], defaultDesignLayers);
    expect(edges).toEqual([]);
  });

  it("filters stored relationships by layer, enabled flag, and endpoint existence", () => {
    const relationships = [
      relationship("r1"),
      relationship("r2", { enabled: false }),
      relationship("r3", { kind: "policy", sourceId: "beta", targetId: "gamma", label: "requires approval" }),
      relationship("r4", { sourceId: "ghost" }),
      relationship("r5", { kind: "memory" })
    ];
    expect(buildDesignEdges(nodes, relationships, defaultDesignLayers)).toHaveLength(3); // execution only
    const withData = buildDesignEdges(nodes, relationships, { execution: false, data: true, policy: false });
    expect(withData.map((edge) => edge.id)).toEqual(["rel:r1"]);
    expect(withData[0].readonly).toBe(true);
    const withPolicy = buildDesignEdges(nodes, relationships, { execution: false, data: false, policy: true });
    expect(withPolicy.map((edge) => edge.id)).toEqual(["rel:r3"]);
    expect(withPolicy[0].label).toBe("requires approval");
  });
});

describe("connectDependencyPatch", () => {
  const nodes = [node("alpha"), node("beta", { dependsOn: ["alpha"] }), node("gamma", { dependsOn: ["beta"] })];

  it("appends the new dependency to the target's list", () => {
    const result = connectDependencyPatch(nodes, "alpha", "gamma");
    expect(result).toEqual({ patch: { gamma: ["beta", "alpha"] } });
  });

  it("refuses self-loops, duplicates, and unknown nodes", () => {
    expect(connectDependencyPatch(nodes, "alpha", "alpha")).toHaveProperty("refusal");
    expect(connectDependencyPatch(nodes, "alpha", "beta")).toHaveProperty("refusal");
    expect(connectDependencyPatch(nodes, "ghost", "beta")).toHaveProperty("refusal");
    expect(connectDependencyPatch(nodes, "alpha", "ghost")).toHaveProperty("refusal");
  });

  it("refuses two-node and three-node cycles", () => {
    // beta depends on alpha; alpha→beta edge means beta would become alpha's dependency: cycle.
    expect(connectDependencyPatch(nodes, "beta", "alpha")).toHaveProperty("refusal");
    // gamma depends on beta depends on alpha; alpha depending on gamma closes a 3-cycle.
    expect(connectDependencyPatch(nodes, "gamma", "alpha")).toHaveProperty("refusal");
  });

  it("removeDependencyPatch removes exactly one id", () => {
    expect(removeDependencyPatch(nodes, "gamma", "beta")).toEqual({ gamma: [] });
    expect(removeDependencyPatch(nodes, "beta", "ghost")).toEqual({ beta: ["alpha"] });
  });
});

describe("positions", () => {
  it("detects identical positions only on exact duplicates", () => {
    expect(hasIdenticalPositions([node("a"), node("b")])).toBe(true); // both {0,0}
    expect(hasIdenticalPositions([node("a"), node("b", { position: { x: 280, y: 0 } })])).toBe(false);
    expect(hasIdenticalPositions([node("a")])).toBe(false);
  });

  it("arranges a deterministic 5-column grid", () => {
    const nodes = Array.from({ length: 7 }, (_, index) => node(`n${index}`));
    const positions = arrangeGridPositions(nodes);
    expect(positions.n0).toEqual({ x: 0, y: 0 });
    expect(positions.n4).toEqual({ x: 1120, y: 0 });
    expect(positions.n5).toEqual({ x: 0, y: 180 });
    expect(positions.n6).toEqual({ x: 280, y: 180 });
  });
});

describe("layerAvailability", () => {
  it("marks memory and evaluation honestly unavailable and counts enabled stored rows", () => {
    const options = layerAvailability([
      relationship("r1"),
      relationship("r2", { enabled: false }),
      relationship("r3", { kind: "policy" })
    ]);
    const byKind = new Map(options.map((option) => [option.kind, option]));
    expect(byKind.get("execution")).toMatchObject({ available: true });
    expect(byKind.get("data")).toMatchObject({ available: true, count: 1 });
    expect(byKind.get("policy")).toMatchObject({ available: true, count: 1 });
    expect(byKind.get("memory")).toMatchObject({ available: false });
    expect(byKind.get("memory")?.note).toMatch(/not stored/);
    expect(byKind.get("evaluation")).toMatchObject({ available: false });
  });
});

describe("describeMutationError", () => {
  it("classifies conflicts and refusals, preserving the verbatim message", () => {
    const conflict = describeMutationError("workspace_version_conflict: expected 3, current 5");
    expect(conflict.kind).toBe("workspace_version_conflict");
    expect(conflict.message).toBe("workspace_version_conflict: expected 3, current 5");
    expect(describeMutationError("revision_conflict: expected rev_a, current rev_b").kind).toBe("revision_conflict");
    expect(describeMutationError("Missing required canonical node: research").kind).toBe("refused");
    expect(describeMutationError("Cannot delete referenced node: alpha").kind).toBe("refused");
    expect(describeMutationError("anything else").kind).toBe("other");
  });
});

describe("graphListEntries", () => {
  it("renders nodes and enabled stored relationships as text", () => {
    const entries = graphListEntries(
      [node("alpha", { riskLevel: "publish" }), node("beta", { dependsOn: ["alpha"] })],
      [relationship("r1", { label: "brief" }), relationship("r2", { enabled: false })]
    );
    expect(entries.map((entry) => entry.id)).toEqual(["alpha", "beta", "rel:r1"]);
    expect(entries[0].text).toContain("risk publish");
    expect(entries[0].text).toContain("no dependencies");
    expect(entries[1].text).toContain("depends on: alpha");
    expect(entries[2].text).toContain("data relationship: alpha → beta (brief)");
  });
});
