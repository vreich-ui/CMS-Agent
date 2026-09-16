import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_ROUTE_METADATA_KEYS,
  deriveRouteFromMetadata,
  deriveStoredExecutionFields,
  resolveNodeExecution,
  routeEraOf,
  routeFromEra
} from "../../../src/agent/workspace/nodeExecution.js";
import { resolveExecutionKind, resolveRouteEra, resolveRouteId } from "../../../src/agent/workspace/routeRegistry.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { workspaceStoreSeedNodes } from "../../../src/agent/workspace/workspaceStoreNodes.js";
import { parseWorkspaceDocumentTolerant, createDefaultWorkspaceDocument } from "../../../src/agent/mcp/workspace/store.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// ACCEPTANCE — K-A9 / W5 T1 (2026-09-16). How a node runs is a stored FIELD, not a metadata flag.
//
// Two claims, and the second one is the load-bearing one:
//
//   1. A metadata-only write can no longer change a node's executionKind. That is the defect K-A9
//      names: `workspace.update_node_metadata` REPLACES the metadata object, so one write that
//      omitted `releaseExecutorDeterministic` — or set it `false` — turned the release step into a
//      model turn holding project.call_tool, and `npm run store:update` could not undo it.
//   2. NOTHING ELSE MOVED. A store row with no stored field resolves exactly as it did before, for
//      every canonical node in the workspace. This is the fail-open half of the house rules, and it
//      is asserted as a snapshot over the whole node set rather than on a hand-picked example,
//      because "identical for the nodes I thought to check" is not the claim being made.

const asNode = (partial: Partial<WorkspaceNode>): WorkspaceNode => ({
  id: "n", name: "n", kind: "workspace", description: "", prompt: "p",
  inputSchema: { type: "object" }, outputSchema: { type: "object" },
  allowedTools: [], requiredInputs: [], produces: [], riskLevel: "read",
  dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: new Date().toISOString(),
  ...partial
});

// The pre-K-A9 resolution, transcribed from the code this change replaced. Everything below that
// claims "identical to today" is measured against THIS, not against a remembered intention.
const legacyRouteEra = (node: WorkspaceNode): string => {
  for (const key of DETERMINISTIC_ROUTE_METADATA_KEYS) {
    const declared = node.metadata?.[key];
    if (declared === undefined || declared === false) continue;
    return typeof declared === "string" ? `${key}:${declared}` : key;
  }
  return "model";
};

describe("K-A9 — a store row with no stored field resolves exactly as it did before", () => {
  const everyNode = [...listWorkspaceNodes(), ...workspaceStoreSeedNodes()];

  it("resolves the identical routeEra for every canonical node", () => {
    expect(everyNode.length).toBeGreaterThan(50);
    const before = everyNode.map((node) => `${node.id}=${legacyRouteEra(node)}`);
    const after = everyNode.map((node) => `${node.id}=${resolveRouteEra(node)}`);
    expect(after).toEqual(before);
  });

  it("resolves the identical executionKind for every canonical node", () => {
    const before = everyNode.map((node) => `${node.id}=${legacyRouteEra(node) === "model" ? "model" : "deterministic"}`);
    const after = everyNode.map((node) => `${node.id}=${resolveExecutionKind(node)}`);
    expect(after).toEqual(before);
  });

  it("still maps a staged route to its manifest, and a model node to none", () => {
    const captureCrawl = everyNode.find((node) => node.metadata?.captureStageDeterministic === "crawl");
    expect(captureCrawl && resolveRouteId(captureCrawl)).toBe("capture_stage");
    expect(resolveRouteId(asNode({}))).toBeUndefined();
  });

  it("treats a key present but false as declaring no route, exactly as the flag scan did", () => {
    const off = asNode({ metadata: { releaseExecutorDeterministic: false } });
    expect(resolveNodeExecution(off)).toEqual({ executionKind: "model" });
    expect(deriveStoredExecutionFields(off)).toEqual({});
  });
});

describe("K-A9 — a metadata-only write cannot change executionKind", () => {
  // The store fills the field on load from the row's OWN metadata (derive-on-load), which is what
  // makes the next metadata write unable to take the route with it.
  const stored = deriveStoredExecutionFields(asNode({ id: "release_executor", metadata: { releaseExecutorDeterministic: true } }));

  it("derives the field from the row's own route metadata", () => {
    expect(stored).toEqual({ executionKind: "deterministic", route: { id: "releaseExecutorDeterministic" } });
  });

  it("keeps the route when a metadata write drops the key entirely", () => {
    // Exactly what workspace.update_node_metadata does: metadata is replaced, the node's other
    // fields are untouched.
    const afterWrite = asNode({ id: "release_executor", ...stored, metadata: { approvalRequired: false } });
    expect(resolveExecutionKind(afterWrite)).toBe("deterministic");
    expect(resolveRouteEra(afterWrite)).toBe("releaseExecutorDeterministic");
  });

  it("keeps the route when a metadata write sets the old flag false — the K-A9 scenario verbatim", () => {
    const afterWrite = asNode({ id: "release_executor", ...stored, metadata: { releaseExecutorDeterministic: false } });
    expect(resolveExecutionKind(afterWrite)).toBe("deterministic");
  });

  it("but an EXPLICIT executionKind:\"model\" wins over route metadata, because that is a decision", () => {
    const off = asNode({ id: "release_executor", executionKind: "model", metadata: { releaseExecutorDeterministic: true } });
    expect(resolveExecutionKind(off)).toBe("model");
    expect(resolveRouteEra(off)).toBe("model");
  });
});

describe("K-A9 — derive-on-load through the store's own parse", () => {
  it("fills the fields on a row that declares a route, and adds nothing to a row that does not", () => {
    const base = createDefaultWorkspaceDocument();
    const raw = {
      ...base,
      nodes: [
        asNode({ id: "release_executor", metadata: { releaseExecutorDeterministic: true } }),
        asNode({ id: "capture_crawl", metadata: { captureStageDeterministic: "crawl" } }),
        asNode({ id: "article_body" })
      ]
    };
    const { document } = parseWorkspaceDocumentTolerant(raw);
    const byId = new Map(document.nodes.map((node) => [node.id, node]));

    expect(byId.get("release_executor")).toMatchObject({ executionKind: "deterministic", route: { id: "releaseExecutorDeterministic" } });
    expect(byId.get("capture_crawl")).toMatchObject({ executionKind: "deterministic", route: { id: "captureStageDeterministic", mode: "crawl" } });
    // A model node gains NOTHING. Storing "model" would be a positive claim the row never made, and
    // it would then suppress a route key a later canonical change adds.
    expect(byId.get("article_body")?.executionKind).toBeUndefined();
    expect(byId.get("article_body")?.route).toBeUndefined();
  });
});

describe("K-A9 — route/era round trip", () => {
  it("is the inverse of the era string every timing sample is keyed on", () => {
    for (const era of ["releaseExecutorDeterministic", "captureStageDeterministic:crawl", "cloneStageDeterministic:pdf_mint"]) {
      expect(routeEraOf(routeFromEra(era))).toBe(era);
    }
  });

  it("reads the declaring keys in list order, so a node carrying two resolves the same way every time", () => {
    const both = asNode({ metadata: { cloneStageDeterministic: "pdf_intake", publishPayloadDeterministic: true } });
    // publishPayloadDeterministic comes first in DETERMINISTIC_ROUTE_METADATA_KEYS.
    expect(deriveRouteFromMetadata(both.metadata)).toEqual({ id: "publishPayloadDeterministic" });
  });
});
