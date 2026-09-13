// operationId -> real implementing EXECUTOR (A4). Sibling of operationWorkflowBindings.ts, holding
// the SAME discipline that module documents for itself: code-defined, module-level, validated at
// import, lookup returns null/structured rather than guessing, and NEVER accepts a caller-supplied
// id. An operation is implemented by EITHER a registered workflow (operationWorkflowBindings.ts) OR a
// registered executor (this module) — never both; asserted at import below, against the OTHER
// module's own table, so the two registries can never silently disagree about who owns an operation.
//
// WHY A SEPARATE REGISTRY RATHER THAN A ROW IN operationWorkflowBindings.ts's OWN TABLE. A workflow
// binding names a `workflowId` — an entry into workflowRegistry.ts's run-graph machinery
// (executor.ts's dispatch, node-by-node, through a real WorkflowExecutionRecord). An executor is not
// that: it is a single, direct, in-process function this task wires straight to `operation_execute`,
// with no run record, no node graph, and no dispatch loop — composing siteContext.ts's snapshot
// machinery (and, for A6-A9, whatever reused pieces THEIR own executors compose) the same way
// visualIdentityReviewChangeExecutor.ts already does for visual_identity_review_change (still unbound
// to either registry today — see that operation's own row in
// operationWorkflowBindings.UNBOUND_OPERATION_IMPLEMENTING_TASK, unchanged by this task). Reusing
// OperationWorkflowBinding's shape for this would mean either inventing a fake workflowId nothing
// registers (exactly the "second workflow engine" operationWorkflowBindings.ts's own header refuses
// to build) or overloading one field to mean two different things depending on a reader's guess. A
// second, narrower table says plainly which kind of implementation an operation has.
//
// THE EXECUTOR-SIDE EQUIVALENT OF R1c's INPUT-CONTRACT CHECK. bindingInputContract.ts's
// checkBindingInputContract answers "can this operation's own guaranteed input, after a FIELD-RENAME
// table, satisfy a DIFFERENT node's differently-named required fields?" — necessary because a
// workflow's entry node speaks its own vocabulary (`projectId`, `apply`, ...), not the operation's.
// An executor has no second vocabulary to translate into: it is written FOR this operation and
// consumes the operation's OWN input directly, under the SAME field names (see
// siteInventoryExecutor.ts's own params type — `tenantId`/`objectType`/`includeRetired`/`since`,
// copied verbatim from siteInventoryOperationV1.inputSchema, never renamed). So the equivalent
// guarantee here is narrower and simpler, and is spelled out by `checkExecutorInputContract` below:
// an executor declares the input schema it accepts (`OperationExecutorBinding.inputSchema`, the SAME
// plain-JSON-Schema shape an operation descriptor's own inputSchema uses), and every field that
// schema's own top-level `required` names must already be guaranteed present on the OPERATION's own
// merged input — required, or defaulted — under the IDENTICAL name. No inputMapping, no anyOf/rename
// machinery: a field with no equivalent is not "left out", because there is no second name to leave
// it under — it is either the operation's own field, guaranteed or not, or it does not exist for this
// binding at all.
import type { OperationId } from "./operationTypes.js";
import { getOperation } from "./operationCatalog.js";
import { listOperationWorkflowBindings } from "./operationWorkflowBindings.js";
import type { OperationInputContractSource } from "./bindingInputContract.js";
import { SITE_INVENTORY_EXECUTOR_INPUT_SCHEMA, SITE_INVENTORY_EXECUTOR_ID, runSiteInventoryExecutor, type OperationExecutorFn } from "./siteInventoryExecutor.js";

export type OperationExecutorBinding = {
  operationId: OperationId;
  executorId: string;
  // The input schema THIS EXECUTOR accepts — see module header. A plain JSON Schema, evaluated ONLY
  // for its top-level `required` array by checkExecutorInputContract below (the same narrow,
  // explicitly-bounded evaluation bindingInputContract.ts uses — an unsupported top-level keyword
  // makes the check UNSATISFIABLE rather than silently passing; see that module's own header for why
  // an unevaluated "maybe" must read as "no").
  inputSchema: Record<string, unknown>;
  // The actual function `operation_execute` invokes. Kept OUT of the plain data shape
  // listOperationExecutorBindings() returns to callers (a caller that only wants to know "is this
  // bound" should never receive a live function reference to hold onto) — see
  // getOperationExecutorRunner() below, the one accessor that returns it.
  run: OperationExecutorFn;
};

const BINDINGS: readonly OperationExecutorBinding[] = [
  {
    operationId: "site_inventory",
    executorId: SITE_INVENTORY_EXECUTOR_ID,
    inputSchema: SITE_INVENTORY_EXECUTOR_INPUT_SCHEMA,
    run: runSiteInventoryExecutor
  }
];

// R1c-equivalent check (see module header). `unsupportedConstructs` mirrors
// bindingInputContract.ts's own UNEVALUATED_REQUIREDNESS_KEYWORDS list — any of these present at the
// executor's inputSchema's top level makes this check refuse to call the binding satisfied, because
// this function does not evaluate what they might additionally require.
const UNEVALUATED_REQUIREDNESS_KEYWORDS = ["oneOf", "allOf", "anyOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "$ref"] as const;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

export type ExecutorInputContractResult = {
  executorId: string;
  // Every operation-side field the operation's own schema guarantees present (required, or
  // defaulted) — sorted, deterministic. No rename: these are the field names the executor actually
  // receives.
  guaranteedFields: string[];
  unsatisfiedRequired: string[];
  unsupportedConstructs: string[];
  satisfied: boolean;
};

// Accepts the PUBLIC (run-less) shape — the only thing this check ever reads is executorId/
// inputSchema, so a caller holding what getOperationExecutorBinding() returned (never the live
// `run` function) can call this directly, as operationPreflight.ts does.
export function checkExecutorInputContract(binding: Pick<OperationExecutorBinding, "executorId" | "inputSchema">, source: OperationInputContractSource): ExecutorInputContractResult {
  const guaranteedFields = [...new Set([...source.requiredFields, ...source.defaultedFields])].sort((left, right) => left.localeCompare(right));
  const guaranteedSet = new Set(guaranteedFields);
  const schema = (binding.inputSchema && typeof binding.inputSchema === "object" ? binding.inputSchema : {}) as Record<string, unknown>;
  const unsupportedConstructs = UNEVALUATED_REQUIREDNESS_KEYWORDS.filter((keyword) => keyword in schema);
  const requiredFields = isStringArray(schema.required) ? schema.required : [];
  const unsatisfiedRequired = requiredFields.filter((field) => !guaranteedSet.has(field));
  const satisfied = unsupportedConstructs.length === 0 && unsatisfiedRequired.length === 0;
  return { executorId: binding.executorId, guaranteedFields, unsatisfiedRequired, unsupportedConstructs, satisfied };
}

function operationInputContractSource(inputSchema: Record<string, unknown>, defaults: Record<string, unknown>): OperationInputContractSource {
  const requiredFields = Array.isArray(inputSchema.required) ? inputSchema.required.filter((field): field is string => typeof field === "string") : [];
  return { requiredFields, defaultedFields: Object.keys(defaults) };
}

export type ExecutorInputContractStatus = {
  operationId: OperationId;
  executorId: string;
  resolved: boolean;
  contract: ExecutorInputContractResult | null;
};

export function resolveExecutorInputContract(binding: OperationExecutorBinding): ExecutorInputContractStatus {
  const operation = getOperation(binding.operationId);
  if (!operation.found) return { operationId: binding.operationId, executorId: binding.executorId, resolved: false, contract: null };
  const source = operationInputContractSource(operation.descriptor.inputSchema as Record<string, unknown>, operation.descriptor.defaults);
  return { operationId: binding.operationId, executorId: binding.executorId, resolved: true, contract: checkExecutorInputContract(binding, source) };
}

const bindingsByOperationId = new Map<string, OperationExecutorBinding>();
for (const binding of BINDINGS) {
  if (bindingsByOperationId.has(binding.operationId)) {
    throw new Error(`operationExecutorBindings: duplicate binding for operation "${binding.operationId}".`);
  }
  bindingsByOperationId.set(binding.operationId, binding);
}

// AN OPERATION IS NEVER BOTH — checked against operationWorkflowBindings.ts's OWN table at import
// time, the same "fail loudly at import, not silently at read time" discipline that module's own
// assertBindingIsSound already holds itself to. This import runs operationWorkflowBindings.ts's
// module-level registration first (ESM evaluates an imported module before the importer's own
// top-level code that depends on it), so `listOperationWorkflowBindings()` here already reflects
// that module's complete table.
for (const binding of BINDINGS) {
  const workflowBound = listOperationWorkflowBindings().some((workflowBinding) => workflowBinding.operationId === binding.operationId);
  if (workflowBound) {
    throw new Error(
      `operationExecutorBindings: operation "${binding.operationId}" is bound to BOTH a workflow (operationWorkflowBindings.ts) and an executor (this module) — an operation may be implemented by exactly one of the two.`
    );
  }
}

// The shape every caller OUTSIDE this module and siteInventoryExecutor.ts ever sees — never the live
// `run` function (see getOperationExecutorRunner below for the one accessor that returns it).
export type PublicOperationExecutorBinding = Omit<OperationExecutorBinding, "run">;

// inputSchema is a nested JSON-Schema object (not a flat string map, unlike operationWorkflowBindings'
// inputMapping) — a shallow copy would still share the SAME inner object with BINDINGS, letting a
// caller mutate this module's own table through, e.g., `binding.inputSchema.required.push(...)`.
// structuredClone (used the same way elsewhere in this codebase for defensive copies — see
// skillRegistry.ts, projectAdmin.ts) breaks that reference entirely.
const cloneBindingPublic = (binding: OperationExecutorBinding): PublicOperationExecutorBinding => ({
  operationId: binding.operationId,
  executorId: binding.executorId,
  inputSchema: structuredClone(binding.inputSchema)
});

// Sorted, deterministic — same discipline as listOperationWorkflowBindings(). Never carries the live
// `run` function: a caller that wants to actually run the binding uses getOperationExecutorRunner().
export function listOperationExecutorBindings(): PublicOperationExecutorBinding[] {
  return [...bindingsByOperationId.values()].map(cloneBindingPublic).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

// null (never a guess, never a throw) when this operationId has no registered executor binding.
export function getOperationExecutorBinding(operationId: string): PublicOperationExecutorBinding | null {
  const binding = bindingsByOperationId.get(operationId);
  return binding ? cloneBindingPublic(binding) : null;
}

// The one accessor that returns a live, callable function — used only by operation_execute (the
// tool that actually runs a bound operation), never by preflight/discovery surfaces.
export function getOperationExecutorRunner(operationId: string): OperationExecutorFn | null {
  return bindingsByOperationId.get(operationId)?.run ?? null;
}
