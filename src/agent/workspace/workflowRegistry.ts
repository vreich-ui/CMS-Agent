import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";

// §2.23 multi-workflow seam. The executor stamps a workflowId on every run and resolves the run's
// canonical node array through this registry, so a second workflow (money_page, advertorial — a
// different upstream composed with the SAME publishing tail via composeWorkflowNodes in
// publishingTail.ts) plugs in by registering here, without touching the executor.
//
// Today publishing_conductor is the only entry, and an unknown workflowId falls back to the
// publishing_conductor canonical set — exactly what every caller got before this registry existed, so
// existing runs (whatever workflowId a caller stamped on them) behave byte-identically. Activating a
// second workflow means: register it here with its composed node array, and have its callers pass its
// workflowId to workflow.start_dry_run. The store overlay in resolveConductorNodes keys by NODE id,
// so an authoring edit to a tail node (prompt, schema, tools, model config) reaches every registered
// workflow at once — the point of sharing the tail.
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

// The only workflow that exists today. Its node array is the canonical literal in nodes.ts, whose
// tail slice is drift-guarded against publishingTail.ts by test and by the re-seed script.
registerWorkflow({ workflowId: "publishing_conductor", canonicalNodes: listWorkspaceNodes });
