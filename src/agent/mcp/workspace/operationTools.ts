// Read-only MCP surface over the operation catalog (A2): operation.list, operation.get,
// operation.preflight. None of these mutate anything — there is no operation.run here and none is
// planned for this task; execution lands in A6-A9. Canonical (dotted) names below; the transport
// serves the underscore wire form via canonicalToolName, same as every other tool module.
import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import { getOperation, listOperations, listOperationVersions } from "../../operations/operationCatalog.js";
import { preflightOperation } from "../../operations/operationPreflight.js";
import "../../operations/registerOperations.js";

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
  configuredCapabilities: { type: "array", items: { type: "string", minLength: 1 }, description: "Capabilities the caller already knows are configured for this tenant; diffed against requiredCapabilities. Never fetched by this tool." }
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
      description: "Read-only discovery preflight for one operation: resolves and reports every default it would apply, validates input against the operation's inputSchema and every typed reference within it (including cross-tenant refusal), and reports capability gaps against configuredCapabilities. Performs zero writes and zero probes — no repository mutation, no tenant call.",
      zodSchema: operationPreflightInput,
      inputSchema: operationPreflightJsonSchema,
      execute: async (input) => ok(preflightOperation(operationPreflightInput.parse(input)))
    })
  ];
}
