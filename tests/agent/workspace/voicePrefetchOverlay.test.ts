import { describe, expect, it } from "vitest";
import { __test__ } from "../../../src/agent/workspace/executor.js";
import { declaresVoicePrefetch, declaresContractPrefetch, gatedMetadata } from "../../../src/agent/workspace/nodeGatingSeed.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// S1 (chat-path engine fixes). The live store overlays canonical nodes. A stored brief_architect row
// whose metadata was written as `{ approvalRequired: false }` used to REPLACE the canonical metadata
// wholesale, dropping `voicePrefetch: true` — so the brief was written with no editorial voice in
// hand and nothing warned. Two fixes, both covered here: the overlay merges metadata, and the
// prefetch declaration itself now lives in the gating seed so even a metadata-less row keeps it.

describe("voicePrefetch survives the store overlay", () => {
  const canonical = getWorkspaceNode("brief_architect")!;

  it("a stored row that only sets approvalRequired keeps the canonical voicePrefetch", () => {
    const stored = { ...canonical, metadata: { approvalRequired: false } } as WorkspaceNode;
    const overlaid = __test__.overlayStoreNode(canonical, stored);
    expect(overlaid.metadata).toMatchObject({ approvalRequired: false, voicePrefetch: true });
    expect(declaresVoicePrefetch(overlaid)).toBe(true);
    expect(declaresContractPrefetch(overlaid)).toBe(true);
  });

  it("a stored key still wins where both declare it", () => {
    const stored = { ...canonical, metadata: { voicePrefetch: false } } as WorkspaceNode;
    const overlaid = __test__.overlayStoreNode(canonical, stored);
    // The store row explicitly turned it off — an operator decision the seed must respect.
    expect(overlaid.metadata?.voicePrefetch).toBe(false);
    expect(declaresVoicePrefetch(overlaid)).toBe(false);
  });

  it("the gating seed declares voicePrefetch for brief_architect even with no metadata at all", () => {
    expect(declaresVoicePrefetch({ id: "brief_architect", metadata: undefined })).toBe(true);
    expect(gatedMetadata({ id: "brief_architect", metadata: { approvalRequired: false } })).toMatchObject({ voicePrefetch: true, contractPrefetch: true });
    // A node with no seed entry and no metadata declares nothing.
    expect(declaresVoicePrefetch({ id: "publish_executor", metadata: undefined })).toBe(false);
  });
});
