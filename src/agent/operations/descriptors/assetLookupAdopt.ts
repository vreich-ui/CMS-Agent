// asset_lookup_adopt — CONTRACT ONLY, no implementation here. Covers typed asset search, resolving
// one candidate from the results, and adopting it into a content object. Implementing task: A5.
import type { OperationDescriptor } from "../operationTypes.js";

export const assetLookupAdoptOperationV1: OperationDescriptor = {
  operationId: "asset_lookup_adopt",
  version: 1,
  title: "Asset lookup and adopt",
  summary: "Searches for existing typed assets (capture artifacts, stored media, content-linked assets) matching a query, resolves one candidate, and adopts its reference into a content object.",
  surface: null,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "query"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      query: { type: "string", minLength: 1 },
      assetKind: { type: "string", enum: ["capture_artifact", "stored_media", "content_linked_asset"], description: "Restrict the search to one asset kind; omit to search all three." },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      // A5 (Milestone A remainder, runner 3c) — ADDITIVE and OPTIONAL, the same way A7's descriptor
      // grew useCase/sourceUrl: this operation's second effect (adopt_asset, riskLevel "write") is
      // "adopts one resolved asset reference INTO A CONTENT OBJECT", and nothing in the original
      // input named that object — so the write half was undispatchable. A dispatch that omits it is
      // still a complete, legitimate search: the run resolves (or refuses to pick) and reports
      // asset_adopt_target_unspecified without writing anything. `nodeId` names the EXISTING node
      // the asset is recorded on; this operation never invents a node in someone's document.
      adoptInto: {
        type: "object",
        additionalProperties: false,
        required: ["objectType", "objectId", "tenantId"],
        properties: {
          objectType: { type: "string", minLength: 1 },
          objectId: { type: "string", minLength: 1 },
          tenantId: { type: "string", minLength: 1 },
          nodeId: { type: "string", minLength: 1 }
        },
        description: "The existing content object (and node on it) to record the resolved asset on. Omit to search without adopting."
      }
    }
  },
  defaults: { maxResults: 20 },
  requiredCapabilities: ["asset_search"],
  effects: [
    { kind: "search_assets", targetType: "asset", riskLevel: "read", description: "Searches for existing typed assets matching a query." },
    { kind: "adopt_asset", targetType: "asset", riskLevel: "write", description: "Adopts one resolved asset reference into a content object, recording the association." }
  ],
  completion: [
    { id: "asset_resolved", description: "Exactly one asset reference was resolved from the search results and adopted.", evidenceKind: "asset_resolution" }
  ],
  intentKeywords: ["find an image", "asset search", "reuse an existing asset", "adopt this asset", "look up asset", "find media"]
};
