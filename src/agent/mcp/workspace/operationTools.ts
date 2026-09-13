// Read-only MCP surface over the operation catalog (A2): operation.list, operation.get,
// operation.preflight. None of these mutate anything — there is no operation.run here and none is
// planned for this task; execution lands in A6-A9. Canonical (dotted) names below; the transport
// serves the underscore wire form via canonicalToolName, same as every other tool module.
import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import { getOperation, listOperations, listOperationVersions } from "../../operations/operationCatalog.js";
import { preflightOperation } from "../../operations/operationPreflight.js";
import { loadTenantCapabilityFacts } from "../../operations/capabilityFactsLoader.js";
import { recordGenuineCapabilityGaps } from "../../operations/capabilityGapRecorder.js";
import { repositoryManager } from "../../runtime/repositories.js";
import "../../operations/registerOperations.js";

// R1: operation.preflight's capability gaps must be derived from the TENANT'S OWN project record —
// never from the wire request's (deprecated) configuredCapabilities alone — so this call turns an
// async repository read into the synchronous `capabilitySource` operationPreflight.ts expects.
// loadTenantCapabilityFacts (R2, capabilityFactsLoader.ts) is the shared loader — this module used to
// carry its own copy; see that module's header for why it is now the one place this read happens.
// Absent project (unregistered tenantId), or a disabled/misconfigured one, all flow through
// naturally: deriveTenantCapabilityAvailability (capabilityReadiness.ts) reads a disabled project as
// every capability "unavailable", and an absent project makes the loader return undefined, which
// operationPreflight.ts reads as "no trusted facts — nothing assumed available" (its own conservative
// default), never as an error.

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

const capabilityGapListInput = z.object({
  tenantId: z.string().min(1)
}).strict();
const capabilityGapListJsonSchema = objectSchema({
  tenantId: { type: "string", minLength: 1 }
}, ["tenantId"]);

const operationPreflightInput = z.object({
  operationId: z.string().min(1),
  version: z.number().int().positive().optional(),
  tenantId: z.string().min(1),
  input: z.unknown(),
  configuredCapabilities: z.array(z.string().min(1)).optional(),
  // R2 Piece 2. A runId or short correlation string for THIS preflight call, threaded into any
  // capability-gap record it discovers (CapabilityGapRecord.sourceRefs) — purely a debugging/evidence
  // aid, never part of a record's identity (see capabilityGapTypes.ts). Optional: a bare, exploratory
  // preflight call (no run behind it yet) legitimately has nothing to name.
  sourceRef: z.string().min(1).optional()
}).strict();
const operationPreflightJsonSchema = objectSchema({
  operationId: { type: "string", minLength: 1 },
  version: { type: "integer", minimum: 1 },
  tenantId: { type: "string", minLength: 1 },
  input: { description: "The operation's own input, validated against its inputSchema." },
  configuredCapabilities: { type: "array", items: { type: "string", minLength: 1 }, description: "Deprecated. Can only NARROW a capability that was already derived as available from the tenant's own project record for this one call — never widen an unavailable one into appearing available." },
  sourceRef: { type: "string", minLength: 1, description: "Optional runId or short correlation string recorded against any durable capability-gap record this call discovers." }
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
      description: "Read-only discovery preflight for one operation: resolves and reports every default it would apply, validates input against the operation's inputSchema and every typed reference within it (including cross-tenant refusal), and reports capability gaps derived from the tenant's own project record (its status, object dialect, and registered tool policy) — never from a caller's claim. configuredCapabilities is deprecated and can only narrow a derived-available capability out for this one call; it can never make an unavailable capability appear available. Also reports executable (whether a registered workflow genuinely implements this operation today) and binding (that resolved workflow binding, or null) — an operation with no registered implementing workflow reports executable:false plus a capability gap (reason not_supported) naming the task expected to add one. Performs one read-only repository lookup of the tenant's project record to derive capability facts; a genuine gap (reason not_configured or not_supported, for a vocabulary-known capability) is also recorded into a durable, deduplicated per-tenant ledger (best-effort — a ledger write failure never turns this read-only response into an error); otherwise zero writes and zero tenant calls.",
      zodSchema: operationPreflightInput,
      inputSchema: operationPreflightJsonSchema,
      execute: async (input) => {
        const data = operationPreflightInput.parse(input);
        const tenantFacts = await loadTenantCapabilityFacts(data.tenantId, repositoryManager.getProjectRepository());
        const result = preflightOperation(data, { capabilitySource: (tenantId) => (tenantId === data.tenantId ? tenantFacts : undefined) });
        // R2 Piece 2 — best-effort durable recording. Deliberately outside preflightOperation itself
        // (which stays zero-I/O per its own header): a write failure here must never turn a
        // successful, read-only preflight response into an error, so it is swallowed after being
        // attempted — never awaited-and-thrown. See capabilityGapRecorder.ts's own header.
        try {
          await recordGenuineCapabilityGaps({
            tenantId: data.tenantId,
            operationId: result.operationId,
            operationVersion: result.selectedVersion,
            capabilityGaps: result.capabilityGaps,
            repository: repositoryManager.getCapabilityGapRepository(),
            sourceRef: data.sourceRef
          });
        } catch {
          // best-effort — see comment above.
        }
        return ok(result);
      }
    }),
    // R2 Piece 2 — the read side of the durable capability-gap ledger operation.preflight writes to.
    // TENANT-REQUIRED and scoped by construction: both repository implementations partition storage by
    // tenantId first (see CapabilityGapRepository.listForTenant's own header), so this can only ever
    // return the caller-named tenant's own records — there is no unfiltered/cross-tenant variant to
    // omit a filter from. Operator/test surface, same status as workflow.retry_node and friends:
    // deliberately NOT added to siteGenesis.ts's SITE_CLIENT_MANAGER_TOOLS allowlist, so a tenant's own
    // scoped chat bearer cannot read another tenant's ledger through this endpoint by construction —
    // full-bearer callers (operators, tests) only.
    tool({
      name: "operation.list_capability_gaps",
      description: "Wrong-path notice: operator/test surface, not part of a tenant's scoped chat bearer's allowlist. List the durable, deduplicated capability-gap records operation.preflight has recorded for one tenant (occurrenceCount, first/lastSeenAt, bounded sourceRefs, the operation considered, already-redacted evidence, and a proposed remedy) — one record per (tenant, operationId@version, missing capability), most-recently-seen first. Never returns another tenant's records.",
      zodSchema: capabilityGapListInput,
      inputSchema: capabilityGapListJsonSchema,
      execute: async (input) => {
        const data = capabilityGapListInput.parse(input);
        const records = await repositoryManager.getCapabilityGapRepository().listForTenant(data.tenantId);
        return ok({ capabilityGaps: records });
      }
    })
  ];
}
