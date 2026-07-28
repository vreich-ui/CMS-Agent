// Platform's contribution to the generic project-hook registry (../projectHooks.ts). Object-native
// client: readiness gate + knowledge only. No enforceCallToolPolicy is needed here — the legacy
// fallback tools Dr. Lurie's executable policy blocks do not exist on this client's server (they
// throw), and the config permission model (deny-by-default + explicit toolPolicies) is the access
// control layer.

import { evaluatePlatformPublishReadiness } from "./publishReadiness.js";
import { platformProjectKnowledge } from "./knowledge.js";

export const platformProjectHooks = {
  // GO/NO-GO publish-readiness gate: workspace body contract, pdf-tool-verified media, taxonomy,
  // pinned approval, release/build behavior, and platform's hard constraints (contentPath /
  // artifactProtocol / legacyFallbacksUsed).
  evaluatePublishReadiness: evaluatePlatformPublishReadiness,
  knowledge: platformProjectKnowledge
};
