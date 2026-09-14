// T2 regression net for scripts/seedNodesFromWorkspace.ts's source normalisation.
//
// THE BUG. The generator copied the store's whole row into nodes.ts, including the fields
// overlayStoreNode (executor.ts) pins to canonical on every dispatch. A store copy of
// id/kind/dependsOn/requiredInputs/produces/riskLevel/position/status can never reach a run, so
// transcribing it into canonical is not a re-seed — it is writing down a value the runtime already
// ignores, and then asking the tail-conformance check to ratify it. Measured against the live store
// on 2026-09-13: 11 of 14 refusals, every one a `tail:` line about topology the store cannot deliver.
//
// THE FIX, and why it is a normalisation and not a flag: correct the SOURCE, then let refuseUnsafe run
// completely unchanged over the result. A flag that scoped the tail check to "the fields being written"
// would have emitted the store's stale topology into nodes.ts with the check silenced — a silently
// forked tail, which is what publishingTail.ts exists to prevent.
import { describe, expect, it } from "vitest";
import { pinCanonicalOwnedFields } from "../../../scripts/seedNodesFromWorkspace.js";
import { CANONICAL_OWNED_FIELDS, __test__ } from "../../../src/agent/workspace/executor.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("CANONICAL_OWNED_FIELDS", () => {
  it("is exactly the set of fields overlayStoreNode does NOT let a store row override", () => {
    // The whole premise of pinning is that these fields cannot reach a run from the store. Proven
    // against the function itself rather than against a second hand-kept list, so the day someone adds
    // a field to overlayStoreNode's override list without removing it from the constant, this fails.
    const canonical = clone(listWorkspaceNodes()[0]);
    const stored: WorkspaceNode = {
      ...clone(canonical),
      id: canonical.id, // overlayStoreNode is keyed by id; a different id is a different node, not an override
      name: "stored name",
      kind: "stored_kind",
      description: "stored description",
      prompt: "stored prompt",
      schema: { stored: true },
      inputSchema: { stored: true },
      outputSchema: { stored: true },
      allowedTools: ["stored.tool"],
      assignedSkills: ["stored_skill"],
      requiredInputs: ["stored_input"],
      produces: ["stored.v1"],
      riskLevel: canonical.riskLevel === "read" ? "write" : "read",
      dependsOn: ["stored_dependency"],
      status: canonical.status === "active" ? "draft" : "active",
      position: { x: -9999, y: -9999 },
      updatedAt: "2099-01-01T00:00:00.000Z",
      metadata: { storedOnly: true },
      modelConfig: { stored: true },
      executionConfig: { stored: true }
    };

    const resolved = __test__.overlayStoreNode(canonical, stored) as unknown as Record<string, unknown>;
    const canonicalRecord = canonical as unknown as Record<string, unknown>;
    const storedRecord = stored as unknown as Record<string, unknown>;

    const keptFromCanonical = Object.keys(storedRecord).filter(
      (field) => JSON.stringify(resolved[field]) === JSON.stringify(canonicalRecord[field])
        && JSON.stringify(storedRecord[field]) !== JSON.stringify(canonicalRecord[field])
    );

    // `id` cannot appear here: overlayStoreNode is keyed by id, so the two sides are identical by
    // construction and the "stored differs from canonical" half of the filter never fires for it.
    expect(keptFromCanonical.sort()).toEqual(CANONICAL_OWNED_FIELDS.filter((field) => field !== "id").sort());
    expect(CANONICAL_OWNED_FIELDS).toContain("id");
  });
});

describe("pinCanonicalOwnedFields", () => {
  it("replaces every canonical-owned field with canonical's value and reports each one", () => {
    const target = clone(listWorkspaceNodes().find((node) => node.dependsOn.length > 0)!);
    const drifted = { ...clone(target), dependsOn: ["nothing_upstream"], riskLevel: "admin" } as WorkspaceNode;

    const { pinned, changed } = pinCanonicalOwnedFields([drifted]);

    expect(pinned[0].dependsOn).toEqual(target.dependsOn);
    expect(pinned[0].riskLevel).toEqual(target.riskLevel);
    expect(changed.some((entry) => entry.startsWith(`${target.id}.dependsOn `))).toBe(true);
    expect(changed.some((entry) => entry.startsWith(`${target.id}.riskLevel `))).toBe(true);
  });

  it("leaves every store-owned field alone — a re-seed still carries the store's prompts and schemas", () => {
    // This is the direction the script EXISTS for. Pinning must not become a way to lose a promoted
    // prompt, which is the erosion the 2026-08-10 incident was about.
    const target = clone(listWorkspaceNodes()[0]);
    const promoted = {
      ...clone(target),
      dependsOn: ["nothing_upstream"],
      prompt: "a promoted prompt from the live store",
      outputSchema: { promoted: true },
      allowedTools: ["promoted.tool"],
      assignedSkills: ["promoted_skill"],
      metadata: { promoted: true }
    } as WorkspaceNode;

    const { pinned } = pinCanonicalOwnedFields([promoted]);

    expect(pinned[0].prompt).toBe("a promoted prompt from the live store");
    expect(pinned[0].outputSchema).toEqual({ promoted: true });
    expect(pinned[0].allowedTools).toEqual(["promoted.tool"]);
    expect(pinned[0].assignedSkills).toEqual(["promoted_skill"]);
    expect(pinned[0].metadata).toEqual({ promoted: true });
    expect(pinned[0].dependsOn).toEqual(target.dependsOn);
  });

  it("is a no-op when the source already agrees with canonical", () => {
    // What keeps `npm run nodes:check:offline`'s byte-identical round-trip meaningful: --from-canonical
    // must pass through pinning completely unchanged.
    const { pinned, changed } = pinCanonicalOwnedFields(clone(listWorkspaceNodes()));

    expect(changed).toEqual([]);
    expect(pinned).toEqual(listWorkspaceNodes());
  });

  it("leaves a store-authored node canonical does not know entirely alone", () => {
    // Adding a node in the store and re-seeding it into nodes.ts is a supported act the script reports
    // as `nodes added` — there is nothing to pin from, so its own topology travels.
    const newcomer = { ...clone(listWorkspaceNodes()[0]), id: "brand_new_publishing_node", dependsOn: ["input_triage"] } as WorkspaceNode;

    const { pinned, changed } = pinCanonicalOwnedFields([newcomer]);

    expect(pinned[0]).toEqual(newcomer);
    expect(changed).toEqual([]);
  });
});
