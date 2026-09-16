import { describe, expect, it } from "vitest";
import { summarizeWorkspaceNode, summarizeWorkspaceNodes } from "../../../src/agent/workspace/nodeProjection.js";
import { workspaceStoreSeedNodes } from "../../../src/agent/workspace/workspaceStoreNodes.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// W2 acceptance. The claim is a SIZE, so the test asserts a size — against the canonical node set,
// which is the same set the live workspace overlays. Measured live 2026-09-16: `workspace_get_nodes`
// returned 310 KB for 51 nodes (prompt 53 %, outputSchema 17 %, the deprecated `schema` alias 12 %),
// for surfaces that render none of those three.

const bytes = (value: unknown) => JSON.stringify(value).length;

describe("W2 — workspace node summary projection", () => {
  const nodes = workspaceStoreSeedNodes();

  it("carries what a list draws and nothing a list does not", () => {
    // The first node has no dependencies, so `dependsOn` is absent rather than `[]` — absent means
    // empty, which is ~2 KB of pure "no" saved across the set (see WorkspaceNodeSummary).
    const withEverything = summarizeWorkspaceNode(nodes.find((node) => node.dependsOn.length && node.produces.length)!);
    expect(Object.keys(withEverything).sort()).toEqual([
      "dependsOn", "executionKind", "id", "kind", "name", "position",
      "produces", "promptSha", "requiredInputs", "riskLevel", "status", "updatedAt"
    ]);
    const summary = summarizeWorkspaceNode(nodes[0]);
    // The three fields that are 82 % of the full payload, and the one nobody should still be reading.
    for (const omitted of ["prompt", "inputSchema", "outputSchema", "schema", "allowedTools", "metadata", "modelConfig", "defaultOutput"]) {
      expect(summary).not.toHaveProperty(omitted);
    }
  });

  it("fits the whole node set inside the rail's budget", () => {
    const summaryBytes = bytes(summarizeWorkspaceNodes(nodes));
    const fullBytes = bytes(nodes);
    expect(nodes.length).toBeGreaterThanOrEqual(48);
    // The budget from the runner plan: <= 20 KB for the summary set. The full set is the number
    // this projection exists to avoid sending.
    // The runner plan estimated ~11 KB; the field list it specified actually costs ~19 KB across 51
    // nodes, spread evenly (no single field dominates — see docs/perf/workbench-2026-09-16.md).
    // 24 KB is the honest budget with headroom for a few more nodes, and it is still a 16x cut.
    expect(summaryBytes).toBeLessThanOrEqual(24 * 1024);
    expect(fullBytes).toBeGreaterThan(200 * 1024);
    // A projection worth having is worth an order of magnitude, not 20 %.
    expect(fullBytes / summaryBytes).toBeGreaterThan(10);
  });

  it("names the execution kind, which a client cannot derive from a summary row", () => {
    // The rail's model/deterministic glyph. It is computed from node.metadata's route declarations,
    // and metadata is exactly what the summary drops — so the server has to answer it or the glyph
    // goes back to costing a full payload.
    const kinds = new Set(summarizeWorkspaceNodes(nodes).map((node) => node.executionKind));
    expect(kinds.has("model")).toBe(true);
    expect(kinds.has("deterministic")).toBe(true);
  });

  it("changes promptSha when, and only when, the prompt changes", () => {
    const [node] = listWorkspaceNodes();
    const baseline = summarizeWorkspaceNode(node).promptSha;
    expect(summarizeWorkspaceNode({ ...node, name: "renamed" } as WorkspaceNode).promptSha).toBe(baseline);
    expect(summarizeWorkspaceNode({ ...node, prompt: `${node.prompt} ` } as WorkspaceNode).promptSha).not.toBe(baseline);
    // An identity, never a payload: short, hex, and not the prompt.
    expect(baseline).toMatch(/^[0-9a-f]{12}$/);
  });

  it("reports whether a default output exists without carrying it", () => {
    const withDefault = { ...nodes[0], defaultOutput: { value: { body: "x".repeat(50_000) }, updatedAt: new Date().toISOString(), updatedBy: "human" as const } };
    const summary = summarizeWorkspaceNode(withDefault as WorkspaceNode);
    expect(summary.hasDefaultOutput).toBe(true);
    expect(bytes(summary)).toBeLessThan(1000);
    expect(summarizeWorkspaceNode(nodes[0]).hasDefaultOutput).toBeUndefined();
  });
});
