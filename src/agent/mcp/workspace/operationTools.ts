// Read-only MCP surface over the operation catalog (A2): operation.list, operation.get,
// operation.preflight. None of these mutate anything — there is no operation.run here and none is
// planned for this task; execution lands in A6-A9. Canonical (dotted) names below; the transport
// serves the underscore wire form via canonicalToolName, same as every other tool module.
import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import { getOperation, listOperations, listOperationVersions } from "../../operations/operationCatalog.js";
import { preflightOperation } from "../../operations/operationPreflight.js";
import { CAPABILITY_EVIDENCE_TOOL_NAMES, type TenantCapabilityFacts } from "../../operations/capabilityReadiness.js";
import { effectiveToolPermission } from "../../projects/projectTypes.js";
import { repositoryManager } from "../../runtime/repositories.js";
import "../../operations/registerOperations.js";

// R1: operation.preflight's capability gaps must be derived from the TENANT'S OWN project record —
// never from the wire request's (deprecated) configuredCapabilities alone — so this is the one place
// that turns an async repository read into the synchronous `capabilitySource` operationPreflight.ts
// expects. Absent project (unregistered tenantId), or a disabled/misconfigured one, all flow through
// naturally: deriveTenantCapabilityAvailability (capabilityReadiness.ts) reads a disabled project as
// every capability "unavailable", and an absent project makes this function return undefined, which
// operationPreflight.ts reads as "no trusted facts — nothing assumed available" (its own conservative
// default), never as an error.
async function loadTenantCapabilityFacts(tenantId: string): Promise<TenantCapabilityFacts | undefined> {
  const config = await repositoryManager.getProjectRepository().get(tenantId);
  if (!config) return undefined;
  return {
    tenantId: config.projectId,
    projectStatus: config.status,
    objectDialectConfigured: Boolean(config.objectDialect),
    registeredToolNames: CAPABILITY_EVIDENCE_TOOL_NAMES.filter((toolName) => effectiveToolPermission(config, toolName) === "allowed")
  };
}

const emptyInput = z.object({}).strict();
const emptyJsonSchema = objectSchema();

const operationGetInput = z.object({
  operationId: z.string().min(1),
  version: z.number().int().positive().optional()
}).strict();
const operationGetJsonSchema = objectSchema({
  operationId: { type: "string", minLength: 1 },
  version: { type: "integer", minimum: 1, description: "Pin a specific registered version; omit for the latest." }
}, ["operationId"]);

const operationPreflightInput = z.object({
  operationId: z.string().min(1),
  version: z.number().int().positive().optional(),
  tenantId: z.string().min(1),
  input: z.unknown(),
  configuredCapabilities: z.array(z.string().min(1)).optional()
}).strict();
const operationPreflightJsonSchema = objectSchema({
  operationId: { type: "string", minLength: 1 },
  version: { type: "integer", minimum: 1 },
  tenantId: { type: "string", minLength: 1 },
  input: { description: "The operation's own input, validated against its inputSchema." },
  configuredCapabilities: { type: "array", items: { type: "string", minLength: 1 }, description: "Deprecated. Can only NARROW a capability that was already derived as available from the tenant's own project record for this one call — never widen an unavailable one into appearing available." }
}, ["operationId", "tenantId", "input"]);

export function createOperationTools(): WorkspaceTool[] {
  return [
    tool({
      name: "operation.list",
      description: "List the registered operation catalog (latest version of each, sorted by operationId). Read-only. Descriptors are contracts describing what an operation WOULD do; nothing here executes an operation, and declaring an effect grants no authority.",
      zodSchema: emptyInput,
      inputSchema: emptyJsonSchema,
      execute: async (input) => {
        emptyInput.parse(input);
        return ok({ operations: listOperations() });
      }
    }),
    tool({
      name: "operation.get",
      description: "Get one registered operation descriptor by operationId (latest version, or a pinned version). An unregistered operationId returns a structured unknown-operation result naming the registered alternatives — never a pass-through, and the caller's string is never echoed back as though it were now a usable id.",
      zodSchema: operationGetInput,
      inputSchema: operationGetJsonSchema,
      execute: async (input) => {
        const data = operationGetInput.parse(input);
        const lookup = getOperation(data.operationId, data.version);
        if (!lookup.found) return ok({ descriptor: null, known: false, registeredOperationIds: lookup.registeredOperationIds });
        return ok({ descriptor: lookup.descriptor, known: true, registeredVersions: listOperationVersions(data.operationId).map((descriptor) => descriptor.version) });
      }
    }),
    tool({
      name: "operation.preflight",
      description: "Read-only discovery preflight for one operation: resolves and reports every default it would apply, validates input against the operation's inputSchema and every typed reference within it (including cross-tenant refusal), and reports capability gaps derived from the tenant's own project record (its status, object dialect, and registered tool policy) — never from a caller's claim. configuredCapabilities is deprecated and can only narrow a derived-available capability out for this one call; it can never make an unavailable capability appear available. Also reports executable (whether a registered workflow genuinely implements this operation today) and binding (that resolved workflow binding, or null) — an operation with no registered implementing workflow reports executable:false plus a capability gap (reason not_supported) naming the task expected to add one. Performs one read-only repository lookup of the tenant's project record to derive capability facts; otherwise zero writes and zero tenant calls.",
      zodSchema: operationPreflightInput,
      inputSchema: operationPreflightJsonSchema,
      execute: async (input) => {
        const data = operationPreflightInput.parse(input);
        const tenantFacts = await loadTenantCapabilityFacts(data.tenantId);
        return ok(preflightOperation(data, { capabilitySource: (tenantId) => (tenantId === data.tenantId ? tenantFacts : undefined) }));
      }
    })
  ];
}
