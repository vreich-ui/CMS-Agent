// Read-only discovery preflight (A2; capability derivation hardened R1). preflightOperation() answers
// "what would running this operation need, and what — if anything — already blocks it", entirely from
// the operation's own registered descriptor plus the caller's input and (for capability gaps) trusted
// facts the caller already loaded. It never runs the operation.
//
// PERFORMS ZERO WRITES AND ZERO PROBES, BY CONSTRUCTION: this module holds no repository, no
// tenant MCP adapter, no network client, and no clock-dependent state. It cannot mutate the
// workspace or call a tenant because it is never handed anything capable of doing either — there is
// no "try the write and see if it works" path available to reach for. `deps.repository` below exists
// only so a test can hand this function a repository double (with every write method throwing) and
// prove the double records zero calls: the function never references it at all. `deps.capabilitySource`
// (R1, below) is likewise never awaited or fetched from — it is a plain SYNCHRONOUS function call over
// data the caller already holds in memory, not a new I/O path.
//
// R1 — CAPABILITY GAPS ARE DERIVED, NEVER ASSERTED. This used to diff descriptor.requiredCapabilities
// against `request.configuredCapabilities` — a caller-supplied array of strings accepted at face
// value. A caller (a model turn reaching operation.preflight over MCP included) could claim
// `configuredCapabilities: ["pdf_render", "asset_search", ...]` and make every capability gap for
// those ids vanish, whether or not the tenant could do any of it: a forged claim WIDENED apparent
// readiness. That is now structurally impossible. Availability is computed by
// capabilityReadiness.ts's deriveTenantCapabilityAvailability() from `deps.capabilitySource(tenantId)`
// — TRUSTED facts the caller already loaded from the project repository (an async read the CALLER
// performs; this module only reads the synchronous result handed to it). `configuredCapabilities` is
// DEPRECATED and may only NARROW that derived result, never widen it: effective availability =
// derived-available AND (configuredCapabilities, when supplied, names it). When no capabilitySource is
// supplied, or it returns nothing for this tenantId, the conservative result is that NOTHING is
// assumed available — this module does NOT fall back to trusting the caller's configuredCapabilities
// array as a substitute for real facts. See capabilityReadiness.ts's own header for what counts as a
// trusted fact and why deriving from it is still zero I/O.
import { getOperation } from "./operationCatalog.js";
import { validateReference } from "./operationReferences.js";
import type { OperationBlocker, OperationCapabilityGap, OperationCompletionCheck, OperationEffect } from "./operationTypes.js";
import { validateOutput } from "../execution/outputValidator.js";
import { deriveTenantCapabilityAvailability, type TenantCapabilityFacts } from "./capabilityReadiness.js";
import {
  getOperationWorkflowBinding,
  UNBOUND_OPERATION_IMPLEMENTING_TASK,
  type OperationWorkflowBinding
} from "./operationWorkflowBindings.js";
import { getOperationExecutorBinding, checkExecutorInputContract, type PublicOperationExecutorBinding } from "./operationExecutorBindings.js";
import { getWorkflowDefinition } from "../workspace/workflowRegistry.js";
import { checkBindingInputContract, resolveWorkflowEntryNodes, type OperationInputContractSource } from "./bindingInputContract.js";

export type PreflightRequest = {
  operationId: string;
  version?: number;
  tenantId: string;
  input: unknown;
  /**
   * @deprecated Caller-supplied capability claims may only NARROW, never widen, the derived
   * availability computed from trusted facts (see `PreflightDeps.capabilitySource`). Effective
   * availability = derived-available AND (configuredCapabilities, when supplied, names it). This
   * field can never make an otherwise-unavailable capability appear available — see this module's own
   * header (R1) for why that used to be possible and no longer is.
   */
  configuredCapabilities?: string[];
};

export type PreflightDeps = {
  // Reserved for a later task's read-only lookup; never referenced by this module today. See header
  // comment — its whole purpose is to be handed a repository double a test can prove was never called.
  repository?: unknown;
  /**
   * R1. A SYNCHRONOUS accessor for trusted, already-loaded capability facts about one tenant. The
   * CALLER (e.g. operationTools.ts's operation.preflight) performs the async repository read and
   * hands this function a plain closure over the result — this module never awaits it, never retries
   * it, and never treats its absence as license to trust `request.configuredCapabilities` instead.
   * Returning `undefined` (including because the whole field was omitted, or the tenantId is unknown
   * to the caller) is read as "no trusted facts for this tenant" and produces the conservative
   * result: nothing is assumed available. See capabilityReadiness.ts for what these facts mean.
   */
  capabilitySource?: (tenantId: string) => TenantCapabilityFacts | undefined;
};

export type PreflightResult = {
  operationId: string;
  selectedVersion: number;
  appliedDefaults: Record<string, unknown>;
  missingRequired: string[];
  blockers: OperationBlocker[];
  capabilityGaps: OperationCapabilityGap[];
  effects: OperationEffect[];
  completion: OperationCompletionCheck[];
  // ADDITIVE (operation-workflow-binding task; hardened R1c). Whether a REGISTERED workflow
  // genuinely implements this operation today AND can actually be reached with this operation's own
  // input — never inferred from the operation merely being registered in the catalog, never from a
  // binding merely existing in operationWorkflowBindings.ts's table (R1c: a binding row is necessary
  // but not sufficient — see this function's own EXECUTABILITY comment below for why), and never from
  // a caller-supplied field (see the note on `request` below: only
  // operationId/version/tenantId/input/configuredCapabilities are ever read). false means starting
  // this operation (e.g. via workflow_start_dry_run) would fail or run the wrong thing; the
  // accompanying capabilityGap (reason "not_supported") names why and what would fix it.
  executable: boolean;
  // The resolved WORKFLOW binding when executable is true via a workflow; null otherwise —
  // including when a binding EXISTS but R1c's input-contract check finds it cannot be satisfied (a
  // known-incomplete binding is not offered as usable), and including when this operation is
  // implemented by an EXECUTOR instead (see `executorBinding` below) — an operation is bound to
  // exactly one of the two (operationExecutorBindings.ts asserts this at import), so the two fields
  // are never both non-null. Never a caller-supplied binding — always exactly what
  // operationWorkflowBindings.ts's own table resolves for this operationId.
  binding: OperationWorkflowBinding | null;
  // ADDITIVE (A4). The resolved EXECUTOR binding when executable is true via a registered executor
  // (operationExecutorBindings.ts) — site_inventory is the one example today. null otherwise,
  // including when a binding exists but its own input-contract check (checkExecutorInputContract)
  // cannot be satisfied, or its required capabilities are not (yet) derived-available for this
  // tenant — see the EXECUTOR EXECUTABILITY comment below for exactly what gates this to true.
  executorBinding: PublicOperationExecutorBinding | null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// A candidate reference carries a tenantId AND at least one of the three id fields a real
// ObjectRef/AssetRef/TemplateRef would have — that pair is what distinguishes "this is an attempted
// typed reference" from "this is just some record that happens to carry a tenantId field" (the
// operation's own top-level input, most commonly, which legitimately carries tenantId but is not
// itself a reference).
const REFERENCE_ID_FIELDS = ["objectId", "assetId", "templateId"] as const;
const looksLikeReference = (record: Record<string, unknown>): boolean =>
  typeof record.tenantId === "string" && REFERENCE_ID_FIELDS.some((field) => field in record);

// Depth-bounded scan for reference-shaped values nested anywhere in the (already-merged) input.
// Bounded so a pathological input cannot make this loop unbounded; operation inputs are shallow
// records, not deep trees.
const MAX_REFERENCE_SCAN_DEPTH = 4;
function findCandidateReferences(value: unknown, depth = MAX_REFERENCE_SCAN_DEPTH): unknown[] {
  if (depth < 0 || (!isPlainObject(value) && !Array.isArray(value))) return [];
  if (Array.isArray(value)) return value.flatMap((item) => findCandidateReferences(item, depth - 1));
  const record = value as Record<string, unknown>;
  const found: unknown[] = looksLikeReference(record) ? [record] : [];
  for (const nested of Object.values(record)) found.push(...findCandidateReferences(nested, depth - 1));
  return found;
}

const unknownOperationResult = (request: PreflightRequest, registeredOperationIds: string[]): PreflightResult => ({
  operationId: request.operationId,
  selectedVersion: request.version ?? 0,
  appliedDefaults: {},
  missingRequired: [],
  blockers: [{
    code: "unknown_operation",
    message: `No operation is registered as "${request.operationId}"${request.version !== undefined ? `@${request.version}` : ""}.`,
    remedy: registeredOperationIds.length
      ? `Use one of the registered operation ids: ${registeredOperationIds.join(", ")}.`
      : "No operations are registered in this catalog.",
    blocking: true,
    evidence: { requestedOperationId: request.operationId, requestedVersion: request.version ?? null, registeredOperationIds }
  }],
  capabilityGaps: [],
  effects: [],
  completion: [],
  executable: false,
  binding: null,
  executorBinding: null
});

// Prose remedy for a derived (not asserted) capability gap, keyed by the same real reason
// deriveTenantCapabilityAvailability() produced — never a blanket "configure it" string, since what
// would actually close the gap differs by reason (capabilityVocabulary.ts names the evidence).
function capabilityGapRemedy(capability: string, reason: OperationCapabilityGap["reason"], tenantId: string): string {
  switch (reason) {
    case "not_configured":
      return `Grant tenant "${tenantId}" the tool/verb (or object dialect) this capability's vocabulary entry names as its evidence — see capabilityVocabulary.ts and capabilityReadiness.ts for "${capability}" — then re-run preflight to confirm the gap is closed.`;
    case "not_supported":
      return `No tenant dialect or hook in this codebase can provide "${capability}" today (see capabilityVocabulary.ts); this is a systemic gap tenant configuration alone cannot close.`;
    case "unavailable":
      return `Tenant "${tenantId}" is currently disabled. Re-enable the project record, then re-run preflight to confirm "${capability}" is available again.`;
    default:
      return `Re-run preflight once "${capability}" is available for tenant "${tenantId}".`;
  }
}

export function preflightOperation(request: PreflightRequest, deps: PreflightDeps = {}): PreflightResult {
  const lookup = getOperation(request.operationId, request.version);
  if (!lookup.found) return unknownOperationResult(request, lookup.registeredOperationIds);
  const descriptor = lookup.descriptor;

  // A MODEL-PROPOSED PLAN MAY CARRY ANYTHING — an arbitrary tool name, approved:true, a principal,
  // a widened scope. None of it is read here. The only fields ever consulted from `request` are
  // operationId, version, tenantId, input, and configuredCapabilities; every other property a
  // caller supplies (including ones matching field names on OTHER records, like `approved`) is
  // ignored, not merely unused — this function's return value is fully determined by the
  // descriptor plus those five fields.
  const rawInput = isPlainObject(request.input) ? request.input : {};
  const appliedDefaults: Record<string, unknown> = {};
  const mergedInput: Record<string, unknown> = { ...rawInput };
  for (const [key, value] of Object.entries(descriptor.defaults)) {
    if (!(key in rawInput)) {
      mergedInput[key] = value;
      appliedDefaults[key] = value;
    }
  }

  const requiredFields = Array.isArray((descriptor.inputSchema as { required?: unknown }).required)
    ? ((descriptor.inputSchema as { required: unknown[] }).required.filter((field): field is string => typeof field === "string"))
    : [];
  const missingRequired = requiredFields.filter((field) => !(field in mergedInput));

  const blockers: OperationBlocker[] = [];
  const schemaValidation = validateOutput(mergedInput, descriptor.inputSchema);
  if (!schemaValidation.ok) {
    blockers.push({
      code: "input_schema_invalid",
      message: `Input for ${descriptor.operationId}@${descriptor.version} does not satisfy its inputSchema: ${schemaValidation.errors.join("; ")}`,
      remedy: "Correct the listed fields to match the operation's inputSchema (see operation.get) and re-run preflight.",
      blocking: true,
      evidence: { errors: schemaValidation.errors }
    });
  }

  for (const candidate of findCandidateReferences(mergedInput)) {
    const validation = validateReference(candidate, { tenantId: request.tenantId });
    if (!validation.ok) blockers.push(validation.blocker);
  }

  // R1: derive first, narrow second — see module header. `tenantFacts` is undefined whenever the
  // caller supplied no capabilitySource, or supplied one that has nothing for this tenantId; either
  // way `derivedAvailability` stays null and every requiredCapability is reported as a gap below,
  // regardless of what `configuredCapabilities` claims.
  const tenantFacts = deps.capabilitySource?.(request.tenantId);
  const derivedAvailability = tenantFacts ? deriveTenantCapabilityAvailability(tenantFacts) : null;
  const narrowingSupplied = Array.isArray(request.configuredCapabilities);
  const narrowedToCapabilities = new Set(
    narrowingSupplied ? request.configuredCapabilities!.filter((entry): entry is string => typeof entry === "string") : []
  );

  const capabilityGaps: OperationCapabilityGap[] = [];
  for (const capability of descriptor.requiredCapabilities) {
    if (!derivedAvailability) {
      capabilityGaps.push({
        capability,
        requiredBy: descriptor.operationId,
        reason: "not_configured",
        evidence: { capability, tenantId: request.tenantId, capabilitySourceSupplied: false },
        remedy: `No trusted capability facts were supplied for tenant "${request.tenantId}" (no capabilitySource was configured for this call, or it returned none for this tenant), so nothing is assumed available regardless of configuredCapabilities. Supply deps.capabilitySource backed by the tenant's real project record, then re-run preflight.`
      });
      continue;
    }
    const derived = derivedAvailability[capability];
    if (!derived || !derived.available) {
      const reason = derived && !derived.available ? derived.reason : "not_configured";
      const evidence = derived ? derived.evidence : { capability, tenantId: request.tenantId };
      capabilityGaps.push({ capability, requiredBy: descriptor.operationId, reason, evidence, remedy: capabilityGapRemedy(capability, reason, request.tenantId) });
      continue;
    }
    // Derived as available. The caller's (deprecated) configuredCapabilities may still NARROW it out
    // for this one call — it can never do the reverse (see PreflightRequest.configuredCapabilities).
    if (narrowingSupplied && !narrowedToCapabilities.has(capability)) {
      capabilityGaps.push({
        capability,
        requiredBy: descriptor.operationId,
        reason: "not_configured",
        evidence: { ...derived.evidence, narrowedOutByConfiguredCapabilities: true },
        remedy: `Tenant "${request.tenantId}" is derived as having "${capability}" available, but this request's configuredCapabilities narrowed it out for this call. Include "${capability}" in configuredCapabilities (or omit the deprecated field entirely) to use the derived availability, then re-run preflight.`
      });
    }
  }

  // EXECUTABILITY (operation-workflow-binding task, hardened R1c). Resolved purely from
  // operationWorkflowBindings.ts's own table, keyed by the REGISTERED descriptor.operationId — never
  // from any field on `request` (a caller-supplied `binding`/`executable`/`workflowId` on the input
  // object is not a field this function reads at all; see the header comment above on `request`).
  //
  // R1c — A BINDING EXISTING IS NOT ENOUGH. Before R1c, `executable` was simply `binding !== null`:
  // any operation with a row in operationWorkflowBindings.ts's table was reported executable, even
  // though nothing checked that the operation's OWN input, after the binding's inputMapping rename,
  // could ever satisfy what the target workflow's entry node(s) actually require. Concretely,
  // visual_identity_review_change's mapped input ({projectId, apply}) supplies NONE of
  // brand_imagery_writer's required `mode` or its `references`/`brief` anyOf — so a caller trusting
  // `executable:true` would register a request and start a run that dies at the entry node's own
  // input validation, after a run record already exists. checkBindingInputContract() (a pure,
  // schema-only check — see bindingInputContract.ts's own header) is what closes that: a binding now
  // counts as executable only when it ALSO clears this check, computed fresh every call from the
  // descriptor and the target workflow's live canonical node array (never cached, never assumed from
  // the binding merely existing).
  const binding = getOperationWorkflowBinding(descriptor.operationId);
  let inputContractSatisfied = false;
  if (binding) {
    const workflowDefinition = getWorkflowDefinition(binding.workflowId);
    // workflowDefinition is always found in practice (assertBindingIsSound already refused an
    // unregistered workflowId at import time — see operationWorkflowBindings.ts); the `undefined`
    // branch exists only so this never throws if that invariant is ever violated, and it fails
    // closed (unsatisfied), never open.
    if (workflowDefinition) {
      const source: OperationInputContractSource = { requiredFields, defaultedFields: Object.keys(descriptor.defaults) };
      // A10 — the binding's declared initial-input builder is passed through and CHECKED (never
      // assumed): a binding whose builder needs an operation field the descriptor does not guarantee
      // is reported unsatisfied, exactly like an unmapped required field. See
      // bindingInputContract.ts's BindingInitialInputBuilderContract.
      const contract = checkBindingInputContract(binding.workflowId, binding.inputMapping, source, workflowDefinition.canonicalNodes(), binding.initialInputBuilder);
      inputContractSatisfied = contract.satisfied;
      if (!contract.satisfied) {
        const entryNodes = resolveWorkflowEntryNodes(workflowDefinition.canonicalNodes());
        const unsatisfiedNodeIds = contract.entryNodeChecks.filter((check) => !check.satisfied).map((check) => check.nodeId);
        // Name the EXACT fields that cannot be satisfied — a plain required field that's missing, and
        // (separately) every anyOf branch that's unmet — so the gap is actionable without a reader
        // having to re-derive it from the raw contract result.
        const unmetRequiredFields = [...new Set(contract.entryNodeChecks.flatMap((check) => check.unsatisfiedRequired))];
        const unmetAnyOfBranches = contract.entryNodeChecks
          .filter((check) => check.anyOfBranches !== null && check.satisfiedAnyOfBranchIndex === null)
          .flatMap((check) => check.anyOfBranches ?? []);
        const unsupportedConstructs = [...new Set(contract.entryNodeChecks.flatMap((check) => check.unsupportedConstructs))];
        capabilityGaps.push({
          capability: "workflow_binding",
          requiredBy: descriptor.operationId,
          reason: "not_supported",
          evidence: {
            operationId: descriptor.operationId,
            workflowId: binding.workflowId,
            entryNodeIds: entryNodes.map((node) => node.id),
            unsatisfiedEntryNodeIds: unsatisfiedNodeIds,
            guaranteedTargetFields: contract.guaranteedTargetFields,
            // A10 — present (and empty) for every binding; non-empty only when a declared
            // initial-input builder needs an operation field the descriptor does not guarantee.
            builderId: contract.builderId,
            unsatisfiedBuilderOperationFields: contract.unsatisfiedBuilderOperationFields,
            unmetRequiredFields,
            unmetAnyOfBranches,
            unsupportedConstructs
          },
          remedy: `The binding from "${descriptor.operationId}" to workflow "${binding.workflowId}" cannot satisfy entry node ${unsatisfiedNodeIds.join(", ") || "(none resolved)"}'s own input contract: it never supplies ${
            [
              unmetRequiredFields.length ? `required field(s) ${unmetRequiredFields.join(", ")}` : null,
              unmetAnyOfBranches.length ? `any of ${unmetAnyOfBranches.map((branch) => `[${branch.join(", ")}]`).join(" or ")}` : null,
              unsupportedConstructs.length ? `— and cannot even evaluate schema construct(s) ${unsupportedConstructs.join(", ")}` : null
            ]
              .filter(Boolean)
              .join(", ")
          }. Close this by either (1) extending "${descriptor.operationId}"'s own inputSchema/defaults and operationWorkflowBindings.ts's inputMapping to actually supply the missing field(s), or (2) binding "${descriptor.operationId}" to a different, already-accepting implementation. Re-run preflight once the binding is repaired to confirm the gap is closed.`
        });
      }
    }
  }
  const workflowExecutable = binding !== null && inputContractSatisfied;

  // EXECUTOR EXECUTABILITY (A4). Sibling of the workflow check above, for an operation implemented
  // by a registered EXECUTOR (operationExecutorBindings.ts) instead of a workflow — site_inventory is
  // the one example today. The equivalent guarantee checkExecutorInputContract gives is narrower than
  // R1c's workflow check (no entry-node graph, no field-rename table — see that module's own header):
  // it asks only whether every field the executor's OWN declared inputSchema requires is already
  // guaranteed present on this operation's own merged input, under the identical name.
  //
  // UNLIKE THE WORKFLOW BRANCH ABOVE, this is ALSO gated on capability readiness
  // (`capabilityReadinessPassed`, read from `capabilityGaps` as it stands right here — after the
  // requiredCapabilities loop above, and after the workflow-binding block above it, which only ever
  // pushes its OWN "workflow_binding" gap when `binding` is non-null; an operation with a workflow
  // binding never also has an executor binding — asserted mutually exclusive at import
  // (operationExecutorBindings.ts) — so that gap and this executor branch are never both live for the
  // same operation, and `capabilityReadinessPassed` means exactly "every requiredCapability derived
  // available" for the one case that reaches here) — this task's own requirement is that
  // site_inventory reports executable:true only "once its capability readiness passes", not merely
  // "the input contract could work in principle". The workflow branch does not carry the same
  // requirement (visual_identity_review_change's own test pins its current, capability-independent
  // behavior) and is left exactly as it was.
  const capabilityReadinessPassed = capabilityGaps.length === 0;
  const executorBinding = getOperationExecutorBinding(descriptor.operationId);
  let executorInputContractSatisfied = false;
  if (executorBinding) {
    const source: OperationInputContractSource = { requiredFields, defaultedFields: Object.keys(descriptor.defaults) };
    const contract = checkExecutorInputContract(executorBinding, source);
    executorInputContractSatisfied = contract.satisfied;
    if (!contract.satisfied) {
      capabilityGaps.push({
        capability: "executor_binding",
        requiredBy: descriptor.operationId,
        reason: "not_supported",
        evidence: {
          operationId: descriptor.operationId,
          executorId: executorBinding.executorId,
          guaranteedFields: contract.guaranteedFields,
          unsatisfiedRequired: contract.unsatisfiedRequired,
          unsupportedConstructs: contract.unsupportedConstructs
        },
        remedy: `The executor "${executorBinding.executorId}" bound to "${descriptor.operationId}" declares an inputSchema requiring ${contract.unsatisfiedRequired.join(", ") || "construct(s) this check cannot evaluate"}, which "${descriptor.operationId}"'s own inputSchema/defaults do not guarantee. Close this by extending the operation's own inputSchema/defaults, or the executor's declared inputSchema, to agree. Re-run preflight once repaired to confirm the gap is closed.`
      });
    }
  }
  const executorExecutable = executorBinding !== null && executorInputContractSatisfied && capabilityReadinessPassed;

  const executable = workflowExecutable || executorExecutable;
  const effectiveBinding = workflowExecutable ? binding : null;
  const effectiveExecutorBinding = executorExecutable ? executorBinding : null;

  if (!binding && !executorBinding) {
    const implementingTask = UNBOUND_OPERATION_IMPLEMENTING_TASK[descriptor.operationId];
    const taskPhrase = implementingTask ? `Task ${implementingTask}` : "A later task";
    capabilityGaps.push({
      capability: "workflow_binding",
      requiredBy: descriptor.operationId,
      reason: "not_supported",
      evidence: { operationId: descriptor.operationId, implementingTask: implementingTask ?? null },
      remedy: `${taskPhrase} has not yet shipped a registered workflow or executor that implements "${descriptor.operationId}"; this operation cannot be started today. Re-run preflight once ${implementingTask ? `${implementingTask} ships` : "an implementing workflow or executor is registered"} to confirm the gap is closed.`
    });
  }

  return {
    operationId: descriptor.operationId,
    selectedVersion: descriptor.version,
    appliedDefaults,
    missingRequired,
    blockers,
    capabilityGaps,
    effects: descriptor.effects,
    completion: descriptor.completion,
    executable,
    binding: effectiveBinding,
    executorBinding: effectiveExecutorBinding
  };
}
