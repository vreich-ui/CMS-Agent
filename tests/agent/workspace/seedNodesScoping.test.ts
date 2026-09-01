// #195 regression net for scripts/seedNodesFromWorkspace.ts.
//
// T15.16 (#195) seeded capture_conductor's and clone_conductor's own upstream nodes into the SAME
// workspace store document as publishing_conductor's (workspaceStoreNodes.ts), so `workspace.get_nodes`
// with no arguments — which is what the re-seed generator reads when it has no --from — now returns all
// three workflows' nodes, not publishing_conductor's alone.
//
// The generator assumed the store held publishing only. Unscoped, that store set both (a) tripped
// refuseUnsafe's REQUIRED_FIELDS check on every capture/clone node, because they correctly omit the
// @deprecated `schema` alias, taking the LIVE drift gate offline while `nodes:check:offline` stayed
// green, and (b) would have folded 24 foreign nodes into publishingConductorNodes on the next write.
//
// These tests run against the REAL node sets (not synthetic fixtures) so they fail the day a capture or
// clone node is added without the exclusion following it.
import { describe, expect, it } from "vitest";
import { REQUIRED_FIELDS, scopeToPublishingConductor } from "../../../scripts/seedNodesFromWorkspace.js";
import { captureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { cloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// The store document's own composition, in the order workspaceStoreNodes.ts unions it: publishing's
// canonical set, then capture's raw upstream, then clone's. Deliberately built the same way the store
// is rather than read from a fixture, so this cannot drift from what the generator actually receives.
const storeShapedUnion = (): WorkspaceNode[] =>
  JSON.parse(JSON.stringify([...listWorkspaceNodes(), ...captureConductorNodes, ...cloneConductorNodes])) as WorkspaceNode[];

const missingRequiredFields = (node: WorkspaceNode): string[] =>
  REQUIRED_FIELDS.filter((field) => (node as unknown as Record<string, unknown>)[field] === undefined);

describe("scopeToPublishingConductor", () => {
  it("returns publishing_conductor's own nodes from a whole-store read, and nothing else", () => {
    const publishingIds = listWorkspaceNodes().map((node) => node.id);
    const { scoped, excluded } = scopeToPublishingConductor(storeShapedUnion());

    expect(scoped.map((node) => node.id)).toEqual(publishingIds);
    expect(excluded.sort()).toEqual([...captureConductorNodes, ...cloneConductorNodes].map((node) => node.id).sort());
  });

  it("is a no-op on a source that is already publishing_conductor only", () => {
    const { scoped, excluded } = scopeToPublishingConductor(listWorkspaceNodes());

    // --from-canonical and a publishing-only --from snapshot must behave exactly as they did before
    // scoping existed, or `nodes:check:offline`'s byte-identical round-trip stops meaning anything.
    expect(scoped.map((node) => node.id)).toEqual(listWorkspaceNodes().map((node) => node.id));
    expect(excluded).toEqual([]);
  });

  it("keeps a node authored in the store that canonical does not have yet", () => {
    // Scoping is by exclusion, not by an allowlist of publishing's current ids: adding a node in the
    // workspace and re-seeding it into nodes.ts is a supported act the script reports as `nodes added`.
    // An inclusion list would silently swallow exactly that, which is a worse bug than the one fixed.
    const newcomer = { ...listWorkspaceNodes()[0], id: "brand_new_publishing_node" } as WorkspaceNode;
    const { scoped, excluded } = scopeToPublishingConductor([...storeShapedUnion(), newcomer]);

    expect(scoped.map((node) => node.id)).toContain("brand_new_publishing_node");
    expect(excluded).not.toContain("brand_new_publishing_node");
  });

  it("removes exactly the nodes that would have tripped the REQUIRED_FIELDS refusal", () => {
    const union = storeShapedUnion();
    const offendersBefore = union.filter((node) => missingRequiredFields(node).length > 0);

    // The bug, stated: the whole-store read carries nodes the generator refuses on, and every one of
    // them is missing `schema` — nodeTypes.ts's @deprecated alias — and nothing else.
    expect(offendersBefore.length).toBeGreaterThan(0);
    expect([...new Set(offendersBefore.flatMap(missingRequiredFields))]).toEqual(["schema"]);

    const { scoped } = scopeToPublishingConductor(union);
    expect(scoped.filter((node) => missingRequiredFields(node).length > 0)).toEqual([]);
  });

  it("never excludes a publishing_conductor node (no id collision with the raw capture/clone arrays)", () => {
    // scopeToPublishingConductor die()s on a collision rather than deleting a publishing node from
    // nodes.ts. This asserts the precondition that makes exclusion safe, so the day someone reuses a
    // tail id in a raw capture/clone array the test says so instead of the generator exiting mid-run.
    const foreignIds = new Set([...captureConductorNodes, ...cloneConductorNodes].map((node) => node.id));
    expect(listWorkspaceNodes().filter((node) => foreignIds.has(node.id)).map((node) => node.id)).toEqual([]);
  });
});
