// workflowId -> the builder that turns a DISPATCHED CATALOG OPERATION's own flat input into the
// nested initialInput that workflow's entry node actually reads. Applied in ONE place, startDryRun
// (executor.ts), BEFORE the run record exists — so a refusal costs nothing and a success is visible
// in run.initialInput for every later read (dispatch, retry, reset: resetRun rebuilds from the run's
// own stored initialInput, which is already built, and every builder here is idempotent anyway).
//
// WHY THIS EXISTS AT ALL. operationWorkflowBindings.ts's `inputMapping` is documented, deliberately,
// as a FLAT FIELD-RENAME TABLE — never structural nesting. Two of this codebase's entry nodes
// (pdf_template_intake, image_revision_intake) read a single NESTED brief object instead of flat
// fields, which a rename table cannot express; both bindings therefore carried an empty inputMapping
// and neither operation could ever run from chat (A10-D1). This module is the missing half: the
// binding still says WHICH workflow implements an operation, and a builder here says HOW that
// operation's input becomes that workflow's initialInput. It is NOT a second workflow engine and NOT
// a second dispatch path — it builds a plain object and hands it back.
//
// NOT A GUESS AND NOT A SILENT TRANSFORM:
//   * keyed by the workflow's own registered id constant, never a string literal typed twice;
//   * IDEMPOTENT — an initialInput that ALREADY carries the field(s) a builder provides is returned
//     untouched, so an operator/test caller that hand-built a brief (every existing A9 test does),
//     and a reset of an already-built run, behave exactly as before this module existed;
//   * a builder REFUSES with a named code rather than emitting a partial brief, and startDryRun
//     turns that into a WorkspaceToolError before a run is minted;
//   * `requiredOperationFields` / `providesInitialInputFields` are DECLARED so
//     bindingInputContract.ts can check the declaration against the operation descriptor's own
//     guaranteed fields and the entry node's own inputSchema — a preflight `executable:true` for a
//     builder-backed binding is therefore a verified statement about delivery, not a relaxed check.
import { IMAGE_TEMPLATE_REVISION_WORKFLOW_ID } from "./imageTemplateRevisionWorkflow.js";
import {
  buildImageTemplateRevisionBrief,
  IMAGE_TEMPLATE_REVISION_BRIEF_BUILDER_ID,
  IMAGE_TEMPLATE_REVISION_BRIEF_KEY,
  IMAGE_TEMPLATE_REVISION_BRIEF_REQUIRED_OPERATION_FIELDS
} from "../capture/imageTemplateRevisionBriefBuilder.js";

export type WorkflowInitialInputBuildResult =
  | { ok: true; initialInput: Record<string, unknown> }
  | { ok: false; code: string; reason: string };

export type WorkflowInitialInputBuilder = {
  builderId: string;
  workflowId: string;
  // The initialInput keys this builder constructs. Read by bindingInputContract.ts as the target
  // fields the binding GUARANTEES the entry node, and by applyWorkflowInitialInput below as the
  // "already built" signal that makes application idempotent.
  providesInitialInputFields: readonly string[];
  // The operation fields the builder cannot work without. Checked against the operation descriptor's
  // own required ∪ defaults set (bindingInputContract.ts) — a builder needing a field the operation
  // does not guarantee makes the binding's input contract UNSATISFIED, never a silent runtime hope.
  requiredOperationFields: readonly string[];
  build: (input: unknown) => WorkflowInitialInputBuildResult;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const BUILDERS: readonly WorkflowInitialInputBuilder[] = [
  {
    builderId: IMAGE_TEMPLATE_REVISION_BRIEF_BUILDER_ID,
    workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID,
    providesInitialInputFields: [IMAGE_TEMPLATE_REVISION_BRIEF_KEY],
    requiredOperationFields: [...IMAGE_TEMPLATE_REVISION_BRIEF_REQUIRED_OPERATION_FIELDS],
    build: (input) => {
      const built = buildImageTemplateRevisionBrief(input);
      if (!built.ok) return built;
      const source = isRecord(input) ? input : {};
      return {
        ok: true,
        initialInput: {
          // The operation's own dispatched fields are KEPT, not replaced: the run record should show
          // what was actually asked for alongside what was built from it.
          ...source,
          // cloneConductorRoutes.ts's resolveRunFacts reads this and REFUSES a run whose declared
          // target differs from the run's own projectId (clone_target_mismatch) — stating it here
          // from the brief's own tenant makes that existing guard check the dispatched tenant
          // against the run's project instead of having nothing to compare.
          targetProjectId: built.brief.tenantId,
          [IMAGE_TEMPLATE_REVISION_BRIEF_KEY]: built.brief
        }
      };
    }
  }
];

const buildersByWorkflowId = new Map<string, WorkflowInitialInputBuilder>();
for (const builder of BUILDERS) {
  if (buildersByWorkflowId.has(builder.workflowId)) {
    throw new Error(`workflowInitialInput: duplicate initial-input builder for workflow "${builder.workflowId}".`);
  }
  buildersByWorkflowId.set(builder.workflowId, builder);
}

// null (never a throw, never a guess) when this workflow has no registered builder — which is the
// case for every workflow whose entry node reads flat fields and needs no construction at all.
export function getWorkflowInitialInputBuilder(workflowId: string | null | undefined): WorkflowInitialInputBuilder | null {
  if (!workflowId) return null;
  return buildersByWorkflowId.get(workflowId) ?? null;
}

export type AppliedWorkflowInitialInput =
  | { ok: true; input: unknown; builderId: string | null; applied: boolean }
  | { ok: false; code: string; reason: string; builderId: string };

/**
 * The one transform startDryRun applies. Returns the input UNCHANGED (applied:false) when there is
 * no builder for this workflow, when the input is not an object, when every field the builder
 * provides is already present (idempotence — see this module's header), or when the input is not a
 * dispatch of this builder's operation at all (see the comment on `looksLikeDispatch` below).
 */
export function applyWorkflowInitialInput(workflowId: string | null | undefined, input: unknown): AppliedWorkflowInitialInput {
  const builder = getWorkflowInitialInputBuilder(workflowId);
  if (!builder) return { ok: true, input, builderId: null, applied: false };
  if (!isRecord(input)) return { ok: true, input, builderId: builder.builderId, applied: false };
  const alreadyBuilt = builder.providesInitialInputFields.every((field) => input[field] !== undefined);
  if (alreadyBuilt) return { ok: true, input, builderId: builder.builderId, applied: false };
  // NOT AN OPERATION DISPATCH AT ALL -> pass through, unchanged and unrefused. A builder builds; it
  // is not a second gate on who may start a run of this workflow. An input carrying none (or only
  // some) of the operation fields the builder requires is not a malformed dispatch to name a
  // refusal for — it is an operator, a test, or a future caller starting this workflow some other
  // way, and the entry node's OWN dispatch-boundary refusal
  // (image_template_revision_brief_missing) is already the honest answer for it, unchanged by this
  // module. publishAutonomyEveryWorkflow.test.ts starts a run of EVERY registered workflow with a
  // generic {targetProjectId, note} input purely to assert the project's publishing-policy snapshot
  // reaches it: that run must still be created, exactly as before.
  //
  // Once EVERY required operation field is present, the input IS a dispatch of this operation, and a
  // problem with it gets a named refusal here rather than a generic "no brief" three steps later.
  // (The operation's own inputSchema is still the authority on whether those fields are required at
  // all — preflightOperation refuses a request missing one before dispatch ever happens.)
  const looksLikeDispatch = builder.requiredOperationFields.every((field) => input[field] !== undefined);
  if (!looksLikeDispatch) return { ok: true, input, builderId: builder.builderId, applied: false };
  const built = builder.build(input);
  if (!built.ok) return { ok: false, code: built.code, reason: built.reason, builderId: builder.builderId };
  return { ok: true, input: built.initialInput, builderId: builder.builderId, applied: true };
}
