// operationId -> real implementing workflow (operation-workflow-binding task). Mirrors
// operationCatalog.ts's own registry discipline: a module-level table, validated at import time,
// with lookup helpers that return null/structured results rather than falling back to a caller's
// guess. LOOKUP IS BY BOUND OPERATION ID ONLY — nothing here accepts a caller-supplied workflowId.
//
// AN OPERATION IS NOT A WORKFLOW. Platform's A3 resolves a chat intent to a catalog operation
// (operationCatalog.ts) and starts it by passing the operation's own id as a `workflowId` to
// workflow_start_dry_run — a DIFFERENT registry (workflowRegistry.ts) that only the workflows
// actually registered there resolve. Six operations exist in A2's catalog; this module is the ONLY
// place that says which of them a REGISTERED workflow can genuinely run today. It never invents a
// synthetic workflow for an operation that has none — that would be exactly the "second workflow
// engine" the programme forbids (AGENTS.md, §2.23's own multi-workflow seam) — and it never binds
// on naming similarity alone ("sounds related" is not evidence; see the header comment on each
// unbound operationId below and in tests/agent/operations/operationWorkflowBindings.test.ts).
//
// EVIDENCE — read from workflowRegistry.ts and every register*Workflow call, not assumed:
// registered today are publishing_conductor (workflowRegistry.ts), capture_conductor
// (captureConductorWorkflow.ts), clone_conductor (cloneConductorWorkflow.ts), visual_identity
// (visualIdentityWorkflow.ts), and pdf_template_studio (pdfTemplateStudioWorkflow.ts). Of the six
// catalog operations:
//
//   visual_identity_review_change -> visual_identity — BOUND. visualIdentityWorkflow.ts registers
//     exactly the two nodes (visualIdentityNodes.ts) this operation's own declared `effects`
//     describe: brand_imagery_writer performs read_visual_identity_standard (riskLevel "read", no
//     writes, no tools) and visual_standard_materializer performs propose_visual_identity_change
//     (files the proposal as a draft `visual_standard` object; applies only behind its own gate).
//     The two share this operation's exact requiredCapabilities vocabulary
//     (visual_identity_read/visual_identity_propose) and the workflow's own header comment states
//     the identical contract this descriptor states.
//
//   pdf_template_family -> pdf_template_studio — BOUND (A7). pdfTemplateStudioWorkflow.ts registers
//     the six-node graph (pdfTemplateStudioNodes.ts) this operation's own declared `effects`
//     describe: design_pdf_template_family (pdf_template_intake/pdf_template_designer/
//     pdf_template_mint) and publish_pdf_template_family (pdf_template_publish +
//     pdf_template_library_deposit, the studio's own two-step publication). See the binding entry
//     below for why its inputMapping is deliberately empty.
//
//   asset_lookup_adopt (A5), document_render (A8) — UNBOUND to any WORKFLOW. Each descriptor file
//   (src/agent/operations/descriptors/*.ts) says "CONTRACT ONLY, no implementation here".
//   Concretely: capture_conductor performs a site CRAWL and emission (captureConductorNodes.ts),
//   which is not a read of the CURRENT inventory no matter how related the vocabulary sounds. No
//   registered workflow's node array performs a search_assets/adopt_asset or renders an existing
//   document to PDF. An honest unbound here is what lets preflightOperation() report
//   executable:false with a named remedy instead of a run that fails at workflow_start_dry_run with
//   no explanation.
//
//   image_template_revision -> image_template_revision_studio — BOUND (A9). Its own binding entry,
//   below, still names an EMPTY inputMapping (a real executor constructing the brief is future
//   work) — the identical, deliberate posture pdf_template_family's own binding already holds
//   itself to; see that binding's own comment.
//
//   site_inventory (A4) — NOT in this module's table, and deliberately NOT in
//   UNBOUND_OPERATION_IMPLEMENTING_TASK below either: A4 shipped it as a registered EXECUTOR
//   (operationExecutorBindings.ts), not a workflow. It is implemented — just not by THIS registry.
//   getOperationWorkflowBinding("site_inventory") correctly still returns null (there genuinely is
//   no workflow binding for it); operationPreflight.ts checks operationExecutorBindings.ts as a
//   sibling source of "genuinely implemented" before falling back to this module's unbound-gap path.
//
// Every workflowId below is checked against workflowRegistry.ts's OWN registry at import time
// (assertBindingIsSound) — a binding naming an id nobody registered fails loudly at import, the same
// discipline registerOperation() already enforces for the operation catalog itself.
import { listRegisteredWorkflowIds, getWorkflowDefinition } from "../workspace/workflowRegistry.js";
import { VISUAL_IDENTITY_WORKFLOW_ID } from "../workspace/visualIdentityWorkflow.js";
import { PDF_TEMPLATE_STUDIO_WORKFLOW_ID } from "../workspace/pdfTemplateStudioWorkflow.js";
import { IMAGE_TEMPLATE_REVISION_WORKFLOW_ID } from "../workspace/imageTemplateRevisionWorkflow.js";
import { getOperation } from "./operationCatalog.js";
import type { OperationId } from "./operationTypes.js";
import { checkBindingInputContract, type BindingInputContractResult, type OperationInputContractSource } from "./bindingInputContract.js";

export type OperationWorkflowBinding = {
  operationId: OperationId;
  workflowId: string;
  // Renames a field on the OPERATION's own input to the field name the workflow's entry node(s)
  // actually declare in their inputSchema. Deliberately just a field-name table: this module is
  // discovery, not execution — a real executor (a later task) is the thing that would apply it.
  // A field with no equivalent on the target node is left OUT rather than guessed at.
  inputMapping: Record<string, string>;
};

const BINDINGS: readonly OperationWorkflowBinding[] = [
  {
    operationId: "visual_identity_review_change",
    workflowId: VISUAL_IDENTITY_WORKFLOW_ID,
    inputMapping: {
      // brand_imagery_writer's own inputSchema names the tenant-scoped site "projectId" ("The
      // client project whose site this standard belongs to" — visualIdentityNodes.ts); this
      // catalog's own reference types (operationReferences.ts) and every project record
      // (projectTypes.ts) use the client project id and its tenant id interchangeably for the same
      // single-tenant-per-site identity.
      tenantId: "projectId",
      // visual_standard_materializer's own input names the identical intent this operation calls
      // autoApply ("Ask for the standard to be applied to the live site. Default false — creating a
      // standard and going live are separate acts." — visualIdentityNodes.ts) `apply`, matching this
      // operation's own doc comment that autoApply only "states intent for the executor that
      // eventually runs it" (descriptors/visualIdentityReviewChange.ts).
      autoApply: "apply"
      // `focus` has no equivalent field on either node today and is deliberately left unmapped.
    }
  },
  {
    // A7 — pdf_template_family -> pdf_template_studio — BOUND. pdfTemplateStudioWorkflow.ts
    // registers exactly the graph this operation's own declared `effects` describe:
    // design_pdf_template_family (pdf_template_intake/pdf_template_designer/pdf_template_mint,
    // riskLevel up to "write") and publish_pdf_template_family (pdf_template_publish +
    // pdf_template_library_deposit, riskLevel "publish"). This is the operation name bound to the
    // WORKFLOW id "pdf_template_studio" — never the operation's own id "pdf_template_family" passed
    // as a workflowId, which is exactly the confusion this binding table exists to prevent (see this
    // module's header).
    operationId: "pdf_template_family",
    workflowId: PDF_TEMPLATE_STUDIO_WORKFLOW_ID,
    // Deliberately EMPTY, not a guess: this operation's flat input fields (tenantId, familyId,
    // locale — descriptors/pdfTemplateFamily.ts) have no flat equivalent on the entry node
    // (pdf_template_intake). The entry node reads a NESTED
    // initialInput.pdfTemplateFamilyBrief {siteId, familyId, useCase, variants, revise, sourceUrl}
    // (pdfTemplateFamilyEngine.ts's pdfTemplateFamilyPlanStep) — inputMapping is documented
    // (this module's header) as a flat field-rename table only, never structural nesting, so
    // expressing "wrap these three fields into a brief object" here would be exactly the kind of
    // guess this table exists to avoid. The node's own inputSchema is the permissive openInput
    // shape (no declared `required`) — A10-D1: an empty mapping into a fully open schema used to
    // trivially (and wrongly) satisfy resolveBindingInputContract/checkBindingInputContract, since
    // neither half of the check had anything to evaluate; bindingInputContract.ts's checkEntryNode
    // now treats "open schema + zero guaranteed fields" as itself unsatisfied (nothing was checked
    // AND nothing was guaranteed), so resolveBindingInputContract correctly reports this binding
    // UNSATISFIED until a real executor (a later task, same posture as visual_identity_review_change
    // today) either constructs the brief or the entry node's schema is taught to name it.
    inputMapping: {}
  },
  {
    // A9 — image_template_revision -> image_template_revision_studio — BOUND.
    // imageTemplateRevisionWorkflow.ts registers exactly the four-node graph
    // (imageTemplateRevisionNodes.ts) this operation's own declared `effects` describe:
    // revise_image_template_batch (image_revision_intake/image_revision_compile_preview,
    // riskLevel up to "read", plus image_revision_apply at riskLevel "publish"). This is the
    // operation name bound to the WORKFLOW id "image_template_revision_studio" — never the
    // operation's own id "image_template_revision" passed as a workflowId.
    operationId: "image_template_revision",
    workflowId: IMAGE_TEMPLATE_REVISION_WORKFLOW_ID,
    // Deliberately EMPTY, same posture as pdf_template_family's own binding above: this operation's
    // flat input fields (tenantId, templateRefs, batchSize — descriptors/imageTemplateRevision.ts)
    // have no flat equivalent on the entry node (image_revision_intake), which reads a NESTED
    // initialInput.imageTemplateRevisionBrief {tenantId, sourceAsset, templateRefs, placement,
    // approve} (imageTemplateRevisionEngine.ts's imageRevisionIntakeStep) — inputMapping is a flat
    // field-rename table only, never structural nesting. The entry node's own inputSchema is the
    // permissive openInput shape (no declared `required`), so — A10-D1 — this empty mapping used to
    // be read as "trivially satisfies checkBindingInputContract"; it was actually a VACUOUS pass:
    // neither half of the check had anything to evaluate. bindingInputContract.ts's checkEntryNode
    // now treats "open schema + zero guaranteed fields" as itself unsatisfied, so
    // resolveBindingInputContract correctly reports this binding UNSATISFIED until a real executor
    // constructs the brief or the entry node's schema is taught to name it — same posture as
    // pdf_template_family's binding above. (cloneConductorRoutes.ts's own "image_revision_intake"
    // case also refuses outright, by name, if a run ever reaches dispatch without a brief anyway —
    // belt and suspenders against this exact class of defect.)
    inputMapping: {}
  }
];

// Which task is expected to give an unbound operation a real workflow/executor — read by
// preflightOperation() to name a concrete remedy instead of a bare "not supported". Kept beside the
// binding table because both describe the same operation -> execution-status axis: when a task
// below actually ships a real implementing workflow, move that operationId out of this map and into
// BINDINGS above (with its own evidence comment) rather than editing preflightOperation.ts. An
// operation whose implementing task shipped an EXECUTOR instead (operationExecutorBindings.ts) is
// also removed from here — site_inventory (A4) is the one example; see this module's header.
export const UNBOUND_OPERATION_IMPLEMENTING_TASK: Readonly<Record<string, string>> = {
  asset_lookup_adopt: "A5",
  document_render: "A8"
};

function assertBindingIsSound(binding: OperationWorkflowBinding): void {
  if (!listRegisteredWorkflowIds().includes(binding.workflowId)) {
    throw new Error(
      `operationWorkflowBindings: operation "${binding.operationId}" is bound to workflow "${binding.workflowId}", which workflowRegistry.ts has not registered. Register the workflow first, or remove this binding.`
    );
  }
}

// R1c — THE GAP assertBindingIsSound NEVER CLOSED. assertBindingIsSound (above) only checks that
// `workflowId` names something workflowRegistry.ts registered; it never checks that this OPERATION'S
// OWN INPUT, after `inputMapping`'s rename, can satisfy what the target workflow's entry node(s)
// actually require. A binding can pass assertBindingIsSound at import time and still be a binding to
// a workflow that will refuse its input at the very first node, every single run — exactly what the
// real binding below currently is (see the test file for the evidence: visual_identity_review_change
// maps to {projectId, apply}, but brand_imagery_writer requires `mode` and one of `references`/`brief`
// — none of which the mapped input ever supplies).
//
// resolveBindingInputContract() is that missing check, made an INSPECTABLE, EXPORTED RESULT rather
// than a second import-time assertion. It is DELIBERATELY NOT CALLED from the BINDINGS registration
// loop below, and DELIBERATELY NEVER THROWS: the one real binding today IS incomplete by this check
// (see above), and this module's own registration loop running at import time must still succeed —
// throwing here would take the whole service down on every boot, for a gap that operationPreflight.ts
// (R1c) already reports honestly at request time via `executable:false` and a named capabilityGap.
// A binding failing this check is a KNOWN-INCOMPLETE BINDING, not a broken one: it still passes
// assertBindingIsSound (the workflow genuinely exists and is genuinely the right one to eventually
// bind to), it is simply not yet WIRED to accept this operation's actual input. Closing that gap means
// either extending the operation's own input contract + inputMapping, or repairing/replacing the
// target node's inputSchema — not throwing at import, and not silently pretending here that it's fine.
//
// Call this (or listBindingInputContractStatuses() below) from a test or an operator tool to SEE the
// gap in code; operationPreflight.ts calls the same underlying checkBindingInputContract() (with the
// descriptor and canonical nodes it already has in hand) to make the gap REFUSE a run before it starts
// — see that module's own header (R1c) for why that is the behavior that actually matters.
export type BindingInputContractStatus = {
  operationId: OperationId;
  workflowId: string;
  // false only when the operation itself, or the workflow it is bound to, is not currently registered
  // (e.g. this is called before registerOperations.ts's side effects have run) — a caller-environment
  // fact, not a verdict about the binding's own soundness. `contract` is null in that case: there is
  // nothing to report a verdict about yet.
  resolved: boolean;
  contract: BindingInputContractResult | null;
};

function operationInputContractSource(inputSchema: Record<string, unknown>, defaults: Record<string, unknown>): OperationInputContractSource {
  const requiredFields = Array.isArray(inputSchema.required) ? inputSchema.required.filter((field): field is string => typeof field === "string") : [];
  return { requiredFields, defaultedFields: Object.keys(defaults) };
}

export function resolveBindingInputContract(binding: OperationWorkflowBinding): BindingInputContractStatus {
  const operation = getOperation(binding.operationId);
  const workflow = getWorkflowDefinition(binding.workflowId);
  if (!operation.found || !workflow) {
    return { operationId: binding.operationId, workflowId: binding.workflowId, resolved: false, contract: null };
  }
  const source = operationInputContractSource(operation.descriptor.inputSchema as Record<string, unknown>, operation.descriptor.defaults);
  const contract = checkBindingInputContract(binding.workflowId, binding.inputMapping, source, workflow.canonicalNodes());
  return { operationId: binding.operationId, workflowId: binding.workflowId, resolved: true, contract };
}

// Every registered binding's input-contract status, sorted by operationId (same determinism
// discipline as listOperationWorkflowBindings()). Requires registerOperations.ts's side effects to
// have already run for `resolved:true` on any entry — callers that need that (this module's own test
// file included) import it first, same as every other test that needs the operation catalog populated.
export function listBindingInputContractStatuses(): BindingInputContractStatus[] {
  return listOperationWorkflowBindings().map(resolveBindingInputContract);
}

const bindingsByOperationId = new Map<string, OperationWorkflowBinding>();
for (const binding of BINDINGS) {
  if (bindingsByOperationId.has(binding.operationId)) {
    throw new Error(`operationWorkflowBindings: duplicate binding for operation "${binding.operationId}".`);
  }
  assertBindingIsSound(binding);
  bindingsByOperationId.set(binding.operationId, binding);
}

// Deep-enough clone that a caller mutating a returned binding's inputMapping cannot reach the
// module's own table — same defensive-copy posture listWorkspaceNodes()/listOperations() already
// take on their own arrays/objects.
const cloneBinding = (binding: OperationWorkflowBinding): OperationWorkflowBinding => ({
  operationId: binding.operationId,
  workflowId: binding.workflowId,
  inputMapping: { ...binding.inputMapping }
});

// Sorted by operationId — deterministic, no clock, no randomness, safe to snapshot for a diff (same
// discipline as operationCatalog.ts's listOperations()).
export function listOperationWorkflowBindings(): OperationWorkflowBinding[] {
  return [...bindingsByOperationId.values()].map(cloneBinding).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

// null (never a throw, never a guessed fallback) when this operationId has no registered binding —
// the caller (preflightOperation) reads that absence as executable:false.
export function getOperationWorkflowBinding(operationId: string): OperationWorkflowBinding | null {
  const binding = bindingsByOperationId.get(operationId);
  return binding ? cloneBinding(binding) : null;
}
