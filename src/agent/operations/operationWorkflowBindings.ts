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
// (captureConductorWorkflow.ts), clone_conductor (cloneConductorWorkflow.ts), and visual_identity
// (visualIdentityWorkflow.ts). Of the six catalog operations:
//
//   visual_identity_review_change -> visual_identity — BOUND. visualIdentityWorkflow.ts registers
//     exactly the two nodes (visualIdentityNodes.ts) this operation's own declared `effects`
//     describe: brand_imagery_writer performs read_visual_identity_standard (riskLevel "read", no
//     writes, no tools) and visual_standard_materializer performs propose_visual_identity_change
//     (files the proposal as a draft `visual_standard` object; applies only behind its own gate).
//     The two share this operation's exact requiredCapabilities vocabulary
//     (visual_identity_read/visual_identity_propose) and the workflow's own header comment states
//     the identical contract this descriptor states. This is the one operation with a real,
//     wired-into-the-executor implementation today.
//
//   site_inventory (A4), asset_lookup_adopt (A5), pdf_template_family (A7), document_render (A8),
//   image_template_revision (A9) — UNBOUND. Each descriptor file
//   (src/agent/operations/descriptors/*.ts) says "CONTRACT ONLY, no implementation here". Concretely:
//   siteContext.ts's own header states its SiteContextSource implementation "is reserved for a
//   later task"; capture_conductor performs a site CRAWL and emission (captureConductorNodes.ts),
//   which is not a read of the CURRENT inventory no matter how related the vocabulary sounds — it is
//   deliberately NOT bound to site_inventory. No registered workflow's node array performs a
//   search_assets/adopt_asset, designs or publishes a PDF template family, renders an existing
//   document to PDF, or revises a batch of web template images. An honest unbound here is what lets
//   preflightOperation() report executable:false with a named remedy instead of a run that fails at
//   workflow_start_dry_run with no explanation.
//
// Every workflowId below is checked against workflowRegistry.ts's OWN registry at import time
// (assertBindingIsSound) — a binding naming an id nobody registered fails loudly at import, the same
// discipline registerOperation() already enforces for the operation catalog itself.
import { listRegisteredWorkflowIds } from "../workspace/workflowRegistry.js";
import { VISUAL_IDENTITY_WORKFLOW_ID } from "../workspace/visualIdentityWorkflow.js";
import type { OperationId } from "./operationTypes.js";

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
  }
];

// Which task is expected to give an unbound operation a real workflow/executor — read by
// preflightOperation() to name a concrete remedy instead of a bare "not supported". Kept beside the
// binding table because both describe the same operation -> execution-status axis: when a task
// below actually ships a real implementing workflow, move that operationId out of this map and into
// BINDINGS above (with its own evidence comment) rather than editing preflightOperation.ts.
export const UNBOUND_OPERATION_IMPLEMENTING_TASK: Readonly<Record<string, string>> = {
  site_inventory: "A4",
  asset_lookup_adopt: "A5",
  pdf_template_family: "A7",
  document_render: "A8",
  image_template_revision: "A9"
};

function assertBindingIsSound(binding: OperationWorkflowBinding): void {
  if (!listRegisteredWorkflowIds().includes(binding.workflowId)) {
    throw new Error(
      `operationWorkflowBindings: operation "${binding.operationId}" is bound to workflow "${binding.workflowId}", which workflowRegistry.ts has not registered. Register the workflow first, or remove this binding.`
    );
  }
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
