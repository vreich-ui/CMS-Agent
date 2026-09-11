// Registers the six initial operation descriptors (A2) with the catalog. Mirrors how
// captureConductorNodes.ts / cloneConductorNodes.ts each call registerWorkflow: importing this
// module for its side effects makes the catalog complete. operationTools.ts (the MCP surface) and
// the test suite both import it for exactly that reason.
//
// Every descriptor registered here is a CONTRACT, not an implementation — see each descriptor
// file's own header for which later task (A5-A9) is expected to implement it.
import { registerOperation } from "./operationCatalog.js";
import { siteInventoryOperationV1 } from "./descriptors/siteInventory.js";
import { visualIdentityReviewChangeOperationV1 } from "./descriptors/visualIdentityReviewChange.js";
import { pdfTemplateFamilyOperationV1 } from "./descriptors/pdfTemplateFamily.js";
import { documentRenderOperationV1 } from "./descriptors/documentRender.js";
import { assetLookupAdoptOperationV1 } from "./descriptors/assetLookupAdopt.js";
import { imageTemplateRevisionOperationV1 } from "./descriptors/imageTemplateRevision.js";

// Re-runnable on purpose (no internal "already done" guard): a plain `import "./registerOperations.js"`
// only ever runs this once anyway (ESM module caching), and the test suite deliberately calls
// __resetOperationCatalogForTests() then this function again to restore the six built-ins into a
// freshly-cleared catalog — a guard here would leave that second call silently a no-op.
export function registerBuiltInOperations(): void {
  registerOperation(siteInventoryOperationV1);
  registerOperation(visualIdentityReviewChangeOperationV1);
  registerOperation(pdfTemplateFamilyOperationV1);
  registerOperation(documentRenderOperationV1);
  registerOperation(assetLookupAdoptOperationV1);
  registerOperation(imageTemplateRevisionOperationV1);
}

registerBuiltInOperations();
