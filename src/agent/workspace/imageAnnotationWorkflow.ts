import { registerWorkflow } from "./workflowRegistry.js";
import { listImageAnnotationNodes } from "./imageAnnotationNodes.js";

// T5 (2026-09-16 annotate-bridge plan) — image_annotation_studio's registration through the §2.23
// multi-workflow seam, exactly as assetLookupWorkflow.ts and documentRenderWorkflow.ts do. This is
// what closes the gap T3 (#368) opened deliberately and T4 left open: T3 registered the
// image_annotation DESCRIPTOR and parked it in UNBOUND_OPERATION_IMPLEMENTING_TASK, and T4 shipped a
// SKILL teaching an agent the manual four-tool sequence but registered no workflow or executor, so
// operation_preflight honestly reported executable:false with a workflow_binding gap. The workflow
// registered here is the implementation that gap named.
//
// Imported for its side effect from nodeResolution.ts alongside the other workflow registrations,
// and from cloneConductorRoutes.ts — the module that owns this workflow's three stage cases — so the
// route and the registration can never arrive on a plane separately (executor.ts imports that module
// to dispatch a deterministic stage at all).
export const IMAGE_ANNOTATION_WORKFLOW_ID = "image_annotation_studio";

registerWorkflow({ workflowId: IMAGE_ANNOTATION_WORKFLOW_ID, canonicalNodes: listImageAnnotationNodes });
