// MCP surface over the operation catalog (A2): operation.list, operation.get, operation.preflight —
// all read-only, no execution. A4 adds ONE execution entrypoint, operation.execute, GATED to
// read-only operations only — see checkOperationIsReadOnly's own header below for the gate itself,
// and operationExecuteTool's header for the full refusal chain. Canonical (dotted) names below; the
// transport serves the underscore wire form via canonicalToolName, same as every other tool module.
import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import { getOperation, listOperations, listOperationVersions } from "../../operations/operationCatalog.js";
import { preflightOperation } from "../../operations/operationPreflight.js";
import { loadTenantCapabilityFacts } from "../../operations/capabilityFactsLoader.js";
import { recordGenuineCapabilityGaps } from "../../operations/capabilityGapRecorder.js";
import { getOperationExecutorRunner } from "../../operations/operationExecutorBindings.js";
import { createSiteContextSourceAdapter } from "../../operations/siteContextSourceAdapter.js";
import type { OperationDescriptor, OperationEffect } from "../../operations/operationTypes.js";
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

// THE READ-ONLY GATE (A4) — the most important check in this file, enforced HERE IN CODE, not by
// convention and not by trusting a descriptor's own summary prose. operation.execute refuses ANY
// operation that declares an effect whose `riskLevel` is not exactly "read" — write- and
// publish-capable operations reaching this entrypoint (asset_lookup_adopt, document_render,
// image_template_revision, pdf_template_family, visual_identity_review_change — every one of the
// five non-site_inventory catalog operations today) is a SEPARATE, REVIEWED OPERATOR DECISION this
// task deliberately does not make. There is no flag, option, or env var anywhere in this module that
// relaxes this gate — a future task opens it deliberately, by changing this function (and its own
// review), or not at all.
//
// Checked against `descriptor.effects` — the SAME array preflightOperation() already echoes back and
// every operation descriptor already declares — never against a hardcoded allowlist of operationIds,
// so a future operation added to the catalog with a non-read effect is refused by construction,
// without anyone having to remember to add it anywhere. operationExecuteAllOperationsGate.test.ts (in
// this repository's test suite) asserts this for every currently-registered non-read operation by
// iterating listOperations() — proving a newly added write operation cannot silently become
// executable here.
export type OperationReadOnlyGateResult =
  | { readOnly: true }
  | { readOnly: false; reason: "non_read_effects" | "no_declared_effects"; offendingEffects: OperationEffect[] };

export function checkOperationIsReadOnly(descriptor: OperationDescriptor): OperationReadOnlyGateResult {
  // AN EMPTY `effects` ARRAY IS NOT EVIDENCE OF SAFETY — it is the ABSENCE of a declaration, and a
  // gate must never read a missing claim as a permissive one. Filtering alone would return
  // readOnly:true for a descriptor that says nothing at all about what running it would do, which is
  // precisely the "a field nobody sent must not be read as true" failure platform's own
  // `pf.executable === false` check exists to avoid. Every descriptor registered today declares at
  // least one effect (operationTypes.ts requires the array, not its contents), so this branch is
  // unreachable from the live catalog — it is here so it STAYS unreachable, and so a future
  // descriptor that forgets its effects is refused rather than silently executed.
  if (descriptor.effects.length === 0) return { readOnly: false, reason: "no_declared_effects", offendingEffects: [] };
  const offendingEffects = descriptor.effects.filter((effect) => effect.riskLevel !== "read");
  return offendingEffects.length === 0 ? { readOnly: true } : { readOnly: false, reason: "non_read_effects", offendingEffects };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const operationExecuteInput = z.object({
  operationId: z.string().min(1),
  version: z.number().int().positive().optional(),
  tenantId: z.string().min(1),
  input: z.unknown(),
  sourceRef: z.string().min(1).optional()
}).strict();
const operationExecuteJsonSchema = objectSchema({
  operationId: { type: "string", minLength: 1 },
  version: { type: "integer", minimum: 1 },
  tenantId: { type: "string", minLength: 1 },
  input: { description: "The operation's own input, validated against its inputSchema before the executor runs." },
  sourceRef: { type: "string", minLength: 1, description: "Optional runId or short correlation string recorded against any durable capability-gap record this call discovers." }
}, ["operationId", "tenantId", "input"]);

// The executor-side dependency bag this task builds for the ONE executor registered today
// (site_inventory_executor). A future executor's own dependency needs are added here as additional
// OPTIONAL fields on OperationExecutorDeps (siteInventoryExecutor.ts) and populated here the same
// way — this function stays the one place operation.execute builds executor dependencies, so a
// dependency's construction (and any I/O it needs, e.g. the project repository read
// createSiteContextSourceAdapter's adapter performs per tenant call) is never duplicated per
// executor.
function buildOperationExecutorDeps() {
  return {
    siteContextSource: createSiteContextSourceAdapter({ projectRepository: repositoryManager.getProjectRepository() })
  };
}

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
    // A4 — the one execution entrypoint. READ-ONLY GATED: see checkOperationIsReadOnly above, the
    // enforcement itself. Operator/test surface, same status as operation.list_capability_gaps below
    // — deliberately NOT added to siteGenesis.ts's SITE_CLIENT_MANAGER_TOOLS allowlist. Platform
    // dispatch (routing an admin-chat turn to this tool) is explicitly OUT of this task's scope —
    // see this file's own report for what that means for the live admin-chat path.
    //
    // THE FULL REFUSAL CHAIN, IN ORDER, EACH ONE A STRUCTURED RESULT (never a throw for an expected
    // refusal — see AGENTS.md's "return structured JSON from endpoints"):
    //   1. unknown_operation — operationId/version names nothing registered.
    //   2. not_read_only — THE GATE. Any declared effect with riskLevel other than "read" refuses,
    //      naming every offending effect.
    //   3. input_invalid — preflightOperation's own blocking blockers (schema validation, a typed
    //      reference that fails cross-tenant/shape checks).
    //   4. no_executor_binding — the operation has no registered EXECUTOR (it may still have a
    //      WORKFLOW binding — operation.execute never runs one; only a registered executor), or one
    //      exists but preflightOperation's fresh, trusted-facts-derived capability/input-contract
    //      check did not clear it (a missing capability is recorded through capabilityGapRecorder.ts,
    //      the SAME R2 ledger operation.preflight already writes to, and reported here — never
    //      attempted blindly).
    //   5. executor_failed — the executor itself reported a structured failure (e.g. a real tenant
    //      read failure — see siteContextSourceAdapter.ts).
    // Anything that reaches none of the five returns `executed:true` with the executor's own result
    // and its projected completion evidence.
    tool({
      name: "operation.execute",
      description: "Runs a bound operation's registered EXECUTOR — READ-ONLY OPERATIONS ONLY. Refuses (structured result, never a throw) any operation declaring an effect whose riskLevel is not \"read\", naming the offending effect(s); today that means only site_inventory can run here. Re-derives capability readiness fresh from the tenant's own project record (never trusts a caller or an earlier preflight call) and refuses with a named capability gap, recorded into the same durable ledger operation.preflight writes to, rather than attempting a read blindly. An operation with no registered executor (including one implemented only by a WORKFLOW) is refused by name, not silently run as something else.",
      zodSchema: operationExecuteInput,
      inputSchema: operationExecuteJsonSchema,
      execute: async (input) => {
        const data = operationExecuteInput.parse(input);
        const emptyRefusal = { operationId: data.operationId, tenantId: data.tenantId, executed: false as const, result: null, completion: [] as const };

        const lookup = getOperation(data.operationId, data.version);
        if (!lookup.found) {
          return ok({
            ...emptyRefusal,
            refusal: { code: "unknown_operation", message: `No operation is registered as "${data.operationId}"${data.version !== undefined ? `@${data.version}` : ""}.`, evidence: { registeredOperationIds: lookup.registeredOperationIds } }
          });
        }
        const descriptor = lookup.descriptor;

        // THE GATE. Enforced before any repository read, any capability derivation, and any executor
        // lookup — a write/publish-capable operation is refused here by construction, never reaching
        // a point where this tool would even report whether it COULD run.
        const gate = checkOperationIsReadOnly(descriptor);
        if (!gate.readOnly) {
          return ok({
            ...emptyRefusal,
            operationId: descriptor.operationId,
            refusal: {
              code: "not_read_only",
              message: gate.reason === "no_declared_effects"
                ? `"${descriptor.operationId}" declares no effects at all. operation.execute runs an operation only when every declared effect is riskLevel "read"; a descriptor that declares nothing has made no claim this gate can check, and an absent claim is never read as a safe one. Declare the operation's real effects, then re-run.`
                : `"${descriptor.operationId}" declares ${gate.offendingEffects.length} non-read effect(s); operation.execute only runs operations whose every declared effect is riskLevel "read". Reaching write- or publish-capable operations through this entrypoint is a separate, reviewed operator decision — not made by this task.`,
              evidence: { reason: gate.reason, offendingEffects: gate.offendingEffects }
            }
          });
        }

        // R1, re-checked fresh — never trusted from the caller or from an earlier preflight call.
        const tenantFacts = await loadTenantCapabilityFacts(data.tenantId, repositoryManager.getProjectRepository());
        const preflight = preflightOperation(
          { operationId: descriptor.operationId, version: descriptor.version, tenantId: data.tenantId, input: data.input },
          { capabilitySource: (tenantId) => (tenantId === data.tenantId ? tenantFacts : undefined) }
        );
        // Best-effort durable recording — the SAME R2 ledger operation.preflight writes to. See that
        // tool's own comment for why this is swallowed rather than thrown.
        try {
          await recordGenuineCapabilityGaps({
            tenantId: data.tenantId,
            operationId: preflight.operationId,
            operationVersion: preflight.selectedVersion,
            capabilityGaps: preflight.capabilityGaps,
            repository: repositoryManager.getCapabilityGapRepository(),
            sourceRef: data.sourceRef
          });
        } catch {
          // best-effort — see comment above.
        }

        const blockingBlockers = preflight.blockers.filter((blocker) => blocker.blocking);
        if (blockingBlockers.length) {
          return ok({ ...emptyRefusal, operationId: descriptor.operationId, refusal: { code: "input_invalid", message: `Input for "${descriptor.operationId}" did not pass preflight.`, evidence: { blockers: blockingBlockers } } });
        }

        if (!preflight.executorBinding) {
          return ok({
            ...emptyRefusal,
            operationId: descriptor.operationId,
            refusal: {
              code: "no_executor_binding",
              message: `"${descriptor.operationId}" has no registered EXECUTOR that operation.execute can run today (it may have a workflow binding instead — operation.execute never runs a workflow), or its executor binding's capability readiness / input contract did not clear preflight.`,
              evidence: { capabilityGaps: preflight.capabilityGaps, workflowBinding: preflight.binding }
            }
          });
        }

        const runner = getOperationExecutorRunner(descriptor.operationId);
        if (!runner) {
          // Unreachable in practice — preflight.executorBinding and getOperationExecutorRunner read
          // the SAME table (operationExecutorBindings.ts). Failing closed, never a null-deref, if
          // that invariant is ever violated.
          return ok({ ...emptyRefusal, operationId: descriptor.operationId, refusal: { code: "no_executor_binding", message: `Internal: "${descriptor.operationId}" resolved an executor binding but no runner is registered for it.`, evidence: {} } });
        }

        const rawInput = isPlainObject(data.input) ? data.input : {};
        const mergedInput = { ...rawInput, ...preflight.appliedDefaults };
        const runResult = await runner({ tenantId: data.tenantId, input: mergedInput, deps: buildOperationExecutorDeps() });
        if (!runResult.ok) {
          return ok({ ...emptyRefusal, operationId: descriptor.operationId, refusal: { code: "executor_failed", message: `Executor for "${descriptor.operationId}" reported a failure.`, evidence: { blockers: runResult.blockers } } });
        }

        return ok({ operationId: descriptor.operationId, tenantId: data.tenantId, executed: true, refusal: null, result: runResult.data, completion: runResult.completion });
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
