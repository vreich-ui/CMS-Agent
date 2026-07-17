// Dr. Lurie publish-readiness policy. This is the project's own GO / NO-GO gate over a publish
// request, evaluated by the generic publisher through the project-hook registry — it is NOT baked
// into the generic publish_payload / publication_controller nodes, so other projects hosted by this
// workspace are never subject to Dr. Lurie's rules.
//
// It refuses to treat a Blob-shaped media reference as trusted unless pdf-tool materialization is
// verified (the caller supplies the confirmed refs), and it enforces Dr. Lurie's hard constraints
// (contentPath article_body.v1, artifactProtocol pdf_tool_dr_lurie_blob.v1, legacyFallbacksUsed
// false), taxonomy resolution, a pinned approval, and a selected release/build behavior. A NO-GO is
// an expected safety state (blocked_for_publish_execution), not a generic failure.

import { articleBodySchema } from "../../mcp/workspace/store.js";

export const DR_LURIE_REQUIRED_CONTENT_PATH = "article_body.v1";
export const DR_LURIE_REQUIRED_ARTIFACT_PROTOCOL = "pdf_tool_dr_lurie_blob.v1";
export const DR_LURIE_RELEASE_BEHAVIORS = ["publish_now", "schedule", "build_only", "unpublish"] as const;

// A Blob-shaped artifact pointer, e.g. image/{requestId}/{sha}.png or pdf/{requestId}/{sha}.pdf. These
// look materialized but must be proven so (present in verifiedMediaRefs) before they can be trusted.
const blobShapedRef = /^(?:images?|pdfs?|documents?)\/[^\s/]+\/[^\s/]+\.[a-z0-9]{2,5}$/i;

export type PublishReadinessCheckStatus = "pass" | "fail" | "accepted_empty";
export type PublishReadinessCheck = { key: string; label: string; status: PublishReadinessCheckStatus; detail?: string };

export type PublishReadinessInput = {
  articleBody?: unknown;
  // Artifact references confirmed materialized by pdf-tool for THIS request (e.g. via
  // list_artifacts_for_request / verify_article_images). A Blob-shaped media src not listed here is
  // treated as unverified and blocks readiness.
  verifiedMediaRefs?: string[];
  taxonomy?: { tags?: string[]; acceptedEmpty?: boolean };
  approval?: { pinned?: boolean; approvedBy?: string; approvedAt?: string };
  releaseBehavior?: string;
  hardConstraints?: { contentPath?: string; artifactProtocol?: string; legacyFallbacksUsed?: boolean };
};

export type PublishReadinessResult = {
  status: "go" | "no_go";
  state: "ready_for_publish_execution" | "blocked_for_publish_execution";
  checklist: PublishReadinessCheck[];
  blockers: string[];
  requiredAction?: string;
  hardConstraints: { contentPath: string; artifactProtocol: string; legacyFallbacksUsed: false };
};

const mediaSrcsOf = (body: { nodes: Array<{ public: { media?: { src?: string } } }> }): string[] =>
  body.nodes.map((node) => node.public.media?.src).filter((src): src is string => typeof src === "string");

export function evaluateDrLuriePublishReadiness(input: PublishReadinessInput): PublishReadinessResult {
  const checklist: PublishReadinessCheck[] = [];
  const blockers: string[] = [];
  const pass = (key: string, label: string, detail?: string) => checklist.push({ key, label, status: "pass", detail });
  const acceptedEmpty = (key: string, label: string, detail?: string) => checklist.push({ key, label, status: "accepted_empty", detail });
  const fail = (key: string, label: string, detail: string) => { checklist.push({ key, label, status: "fail", detail }); blockers.push(key); };

  // 1. article_body.v1 valid.
  const body = articleBodySchema.safeParse(input.articleBody);
  if (body.success) pass("article_body_valid", "article_body.v1 valid");
  else fail("article_body_valid", "article_body.v1 valid", `invalid article body: ${body.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);

  // 2. Blob artifacts verified — no Blob-shaped media trusted unless pdf-tool materialization confirmed.
  const verified = new Set((input.verifiedMediaRefs ?? []).map((ref) => String(ref)));
  const mediaSrcs = body.success ? mediaSrcsOf(body.data) : [];
  const unverified = mediaSrcs.filter((src) => blobShapedRef.test(src) && !verified.has(src));
  if (mediaSrcs.length === 0) pass("media_artifacts_verified", "Blob artifacts verified", "no media artifacts");
  else if (unverified.length === 0) pass("media_artifacts_verified", "Blob artifacts verified", `${mediaSrcs.length} media reference(s) confirmed`);
  else fail("media_artifacts_verified", "Blob artifacts verified", `unverified Blob-shaped media (pdf-tool materialization not confirmed): ${unverified.join(", ")}`);

  // 3. Taxonomy resolved, or explicitly accepted empty.
  const tags = input.taxonomy?.tags ?? [];
  if (tags.length > 0) pass("taxonomy", "Taxonomy resolved", `${tags.length} tag(s)`);
  else if (input.taxonomy?.acceptedEmpty === true) acceptedEmpty("taxonomy", "Taxonomy resolved", "explicitly accepted empty");
  else fail("taxonomy", "Taxonomy resolved", "taxonomy missing and not explicitly accepted empty");

  // 4. Pinned approval present.
  if (input.approval?.pinned === true && input.approval.approvedBy) pass("pinned_approval", "Pinned approval present", `pinned by ${input.approval.approvedBy}`);
  else fail("pinned_approval", "Pinned approval present", "no pinned approval on the publish request");

  // 5. Release / build behavior selected.
  if (input.releaseBehavior && (DR_LURIE_RELEASE_BEHAVIORS as readonly string[]).includes(input.releaseBehavior)) pass("release_behavior", "Release/build behavior selected", input.releaseBehavior);
  else fail("release_behavior", "Release/build behavior selected", `select one of: ${DR_LURIE_RELEASE_BEHAVIORS.join(", ")}`);

  // 6. Hard constraints. contentPath defaults to the canonical path when the body validates; the
  // artifact protocol and legacy-fallback flag must be declared on the request and must match exactly.
  const declared = input.hardConstraints ?? {};
  const contentPath = declared.contentPath ?? (body.success ? DR_LURIE_REQUIRED_CONTENT_PATH : undefined);
  if (contentPath === DR_LURIE_REQUIRED_CONTENT_PATH) pass("hard_content_path", `contentPath = ${DR_LURIE_REQUIRED_CONTENT_PATH}`);
  else fail("hard_content_path", `contentPath = ${DR_LURIE_REQUIRED_CONTENT_PATH}`, `got ${contentPath ?? "(none)"}`);
  if (declared.artifactProtocol === DR_LURIE_REQUIRED_ARTIFACT_PROTOCOL) pass("hard_artifact_protocol", `artifactProtocol = ${DR_LURIE_REQUIRED_ARTIFACT_PROTOCOL}`);
  else fail("hard_artifact_protocol", `artifactProtocol = ${DR_LURIE_REQUIRED_ARTIFACT_PROTOCOL}`, `got ${declared.artifactProtocol ?? "(none)"}`);
  if (declared.legacyFallbacksUsed === false) pass("hard_legacy_fallbacks", "legacyFallbacksUsed = false");
  else fail("hard_legacy_fallbacks", "legacyFallbacksUsed = false", `got ${String(declared.legacyFallbacksUsed ?? "(none)")}`);

  const status = blockers.length === 0 ? "go" : "no_go";
  return {
    status,
    state: status === "go" ? "ready_for_publish_execution" : "blocked_for_publish_execution",
    checklist,
    blockers,
    requiredAction: status === "go" ? undefined : `Resolve: ${blockers.join(", ")}.`,
    hardConstraints: { contentPath: DR_LURIE_REQUIRED_CONTENT_PATH, artifactProtocol: DR_LURIE_REQUIRED_ARTIFACT_PROTOCOL, legacyFallbacksUsed: false }
  };
}
