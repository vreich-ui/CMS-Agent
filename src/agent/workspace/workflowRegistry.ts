import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";

// §2.23 multi-workflow seam. The executor stamps a workflowId on every run and resolves the run's
// canonical node array through this registry, so a second workflow (money_page, advertorial — a
// different upstream composed with the SAME publishing tail via composeWorkflowNodes in
// publishingTail.ts) plugs in by registering here, without touching the executor.
//
// Three workflows are registered: publishing_conductor (DTC articles), capture_conductor (site
// crawl → emission), and clone_conductor (structure + theme authoring). An unknown workflowId falls
// back to publishing_conductor for backward compatibility with existing runs. The registry seam
// lets each workflow reach the shared publishing tail without refactoring every tail node. The store
// overlay in resolveConductorNodes keys by NODE id, so an authoring edit to a tail node (prompt,
// schema, tools, model config) reaches every registered workflow at once — the point of sharing the tail.
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

// publishing_conductor: the original DTC article workflow. Its node array is the canonical
// literal in nodes.ts, whose tail slice is drift-guarded against publishingTail.ts by test and by
// the re-seed script. (capture_conductor and clone_conductor are registered separately in their
// own files; all three converge on the shared publishing tail.)
registerWorkflow({ workflowId: "publishing_conductor", canonicalNodes: listWorkspaceNodes });
