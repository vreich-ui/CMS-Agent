import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";

// §2.23 multi-workflow seam. The executor stamps a workflowId on every run and resolves the run's
// canonical node array through this registry, so a second workflow (money_page, advertorial — a
// different upstream composed with the SAME publishing tail via composeWorkflowNodes in
// publishingTail.ts) plugs in by registering here, without touching the executor.
//
// Four workflows are registered: publishing_conductor (DTC articles), capture_conductor (site
// crawl → emission), clone_conductor (structure + theme authoring), and visual_identity (the brand
// imagery pair — see visualIdentityWorkflow.ts). The registry seam lets each tail-composing workflow
// reach the shared publishing tail without refactoring every tail node. The store overlay in
// resolveConductorNodes keys by NODE id, so an authoring edit to a tail node (prompt, schema, tools,
// model config) reaches every registered workflow at once — the point of sharing the tail.
//
// R1b (2026-09) SUPERSEDES this header's former claim that "an unknown workflowId falls back to
// publishing_conductor for backward compatibility with existing runs" — that was true for one case
// and silently, dangerously true for a second, unrelated one it never distinguished from the first:
//   * GENUINELY ABSENT (undefined/null/""): a run record persisted before this field existed, or a
//     caller that never supplied one. THIS is the legacy adapter the sentence above used to describe,
//     and it is real and intentional — resolveConductorNodes' default parameter (and, for the "no run
//     in hand" caller, nodeResolution.ts's registration-order scan) still resolve it to
//     publishing_conductor, unchanged from every run's behaviour before the registry existed.
//   * PRESENT BUT UNREGISTERED: a caller (a model turn included — platform's run_workspace_workflow
//     passes args.workflow_id straight through to workflow_start_dry_run with no catalog check) or a
//     persisted run names a SPECIFIC id this build does not know. Treating that the same as "absent"
//     silently substitutes a completely different, unrelated workflow's node array for whatever the
//     caller actually named — and for line ~381's old code, ALWAYS the full publishing_conductor set,
//     tail included, regardless of what was asked for. That is refused now, not substituted: see
//     executor.ts's startDryRun (refuses before a run record exists) and resolveConductorNodes
//     (refuses even for an already-persisted run carrying one), and nodeResolution.ts's
//     findCanonicalNodeById (an explicit id is resolved against ONLY that one workflow, never widened
//     into scanning every registered workflow the way the "no run in hand" case legitimately does).
export type WorkflowDefinition = {
  workflowId: string;
  // The canonical (code-defined) node array for the workflow. For publishing_conductor this is
  // exactly listWorkspaceNodes(); a composed workflow supplies () => composeWorkflowNodes(...). A
  // function rather than a frozen array so each resolution gets fresh copies, matching
  // listWorkspaceNodes' contract.
  canonicalNodes: () => WorkspaceNode[];
};

const registry = new Map<string, WorkflowDefinition>();

export const registerWorkflow = (definition: WorkflowDefinition): void => {
  if (registry.has(definition.workflowId)) throw new Error(`Workflow already registered: ${definition.workflowId}`);
  registry.set(definition.workflowId, definition);
};

export const getWorkflowDefinition = (workflowId: string): WorkflowDefinition | undefined => registry.get(workflowId);

export const listRegisteredWorkflowIds = (): string[] => [...registry.keys()];

export type WorkflowLookupResult =
  | { found: true; definition: WorkflowDefinition }
  | { found: false; workflowId: string; registeredWorkflowIds: string[] };

// R1b — mirrors operationCatalog.ts's getOperation() exactly, and for the identical reason (see that
// file's header): an id nobody registered comes back as STRUCTURED data naming the real registered
// alternatives, never a thrown error and never a silent substitute for a different workflow. Whether
// and how to refuse is the CALLER's decision (executor.ts's startDryRun boundary check throws before
// a run exists; resolveConductorNodes throws as defense-in-depth for an already-persisted run) — this
// function only reports the truth about what is registered, same split as
// operationCatalog/operationPreflight.
export function lookupWorkflow(workflowId: string): WorkflowLookupResult {
  const definition = registry.get(workflowId);
  if (!definition) return { found: false, workflowId, registeredWorkflowIds: listRegisteredWorkflowIds() };
  return { found: true, definition };
}

// publishing_conductor: the original DTC article workflow. Its node array is the canonical
// literal in nodes.ts, whose tail slice is drift-guarded against publishingTail.ts by test and by
// the re-seed script. (capture_conductor and clone_conductor are registered separately in their
// own files; all three converge on the shared publishing tail.)
registerWorkflow({ workflowId: "publishing_conductor", canonicalNodes: listWorkspaceNodes });
