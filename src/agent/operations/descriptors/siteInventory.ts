// site_inventory — CONTRACT ONLY, no implementation here. Covers reading a tenant's current object
// inventory and its change history. Read-only by declared effect (riskLevel "read"): this
// descriptor's own contract never proposes a write.
//
// Implementing task: A4. This operation is the read surface over the versioned site snapshot A4
// builds (siteContext.ts's SiteSnapshot/SiteContextSource, candidates.ts, changeSet.ts) — an
// executor for this descriptor is expected to assemble its response from a captured SiteSnapshot's
// `objects` (and, for history, a later task's own change-event read) rather than inventing a second
// way to enumerate a tenant's objects.
import type { OperationDescriptor } from "../operationTypes.js";

export const siteInventoryOperationV1: OperationDescriptor = {
  operationId: "site_inventory",
  version: 1,
  title: "Site inventory and history",
  summary: "Reads the tenant's current object inventory (what exists, its type and status) and its change history. Performs no write.",
  surface: null,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tenantId"],
    properties: {
      tenantId: { type: "string", minLength: 1 },
      objectType: { type: "string", minLength: 1, description: "Restrict the inventory to one object type; omit to list every type." },
      includeRetired: { type: "boolean", default: false },
      since: { type: "string", format: "date-time", description: "Only include history events at or after this timestamp." }
    }
  },
  defaults: { includeRetired: false },
  requiredCapabilities: ["site_inventory_read"],
  effects: [
    {
      kind: "read_site_inventory",
      targetType: "site_object_index",
      riskLevel: "read",
      description: "Reads the tenant's current object inventory and its recorded change history. Writes nothing."
    }
  ],
  completion: [
    { id: "inventory_snapshot_returned", description: "An inventory snapshot for the requested scope was returned to the caller.", evidenceKind: "inventory_snapshot" }
  ],
  intentKeywords: ["site inventory", "what's on the site", "site history", "list pages", "site map", "inventory"]
};
