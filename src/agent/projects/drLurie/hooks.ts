// Dr. Lurie's contribution to the generic project-hook registry (../projectHooks.ts). This is the
// architecturally correct home for client rules: policy as a plugin the workspace invokes through
// project.validate_handoff / project.get — never prose baked into generic prompts or tools.

import { summarizeArtifactPolicyWarnings, validateNoRawImageArtifactPublicUrls, type ArtifactPolicyWarning } from "./artifactPolicy.js";
import { evaluateDrLurieCallToolPolicy } from "./executablePolicy.js";
import { evaluateDrLuriePublishReadiness } from "./publishReadiness.js";
import { drLurieProjectKnowledge } from "./knowledge.js";

const validateHandoffPolicy = (payload: { contentSource?: unknown; articleBody?: unknown }): ArtifactPolicyWarning[] => [
  // Article bodies get the full artifact policy: inline image placement + raw artifact URL rules
  // + the PDF fallback advisory.
  ...(payload.articleBody !== undefined ? summarizeArtifactPolicyWarnings(payload.articleBody) : []),
  // Content-source envelopes are scanned for raw image artifact references leaking into
  // public-facing fields.
  ...(payload.contentSource !== undefined ? validateNoRawImageArtifactPublicUrls(payload.contentSource) : [])
];

export const drLurieProjectHooks = {
  validateHandoffPolicy,
  // Blocks legacy artifact fallback tools and fallback artifact-source arguments at call_tool time.
  enforceCallToolPolicy: evaluateDrLurieCallToolPolicy,
  // GO/NO-GO publish-readiness gate: pdf-tool-verified media, taxonomy, pinned approval, and hard
  // constraints (contentPath / artifactProtocol / legacyFallbacksUsed) before any live publish.
  evaluatePublishReadiness: evaluateDrLuriePublishReadiness,
  knowledge: drLurieProjectKnowledge
};
