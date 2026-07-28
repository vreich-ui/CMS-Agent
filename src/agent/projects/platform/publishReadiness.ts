// Platform publish-readiness policy. The platform site is OBJECT-NATIVE: it was born on the object
// substrate (content_item objects through /mcp), has no legacy save_json_blob article path at all
// (those tools throw on its server), and separates publish (commit the export) from release (deploy)
// as two explicit gates. This hook is the project's GO / NO-GO gate over a publish request,
// evaluated by the generic publisher through the project-hook registry — mirroring Dr. Lurie's hook
// in shape (same checklist keys, same three hard-constraint keys) so the generic readiness surface
// renders both identically, while the constants say what is true for THIS client.
//
// Deliberately standalone rather than shared with Dr. Lurie's evaluator: per-project folders own
// their policy (see ../projectHooks.ts) so one client's rule change can never silently move another
// client's gate.

import { articleBodySchema } from "../../mcp/workspace/store.js";
import type { PublishReadinessCheck, PublishReadinessInput, PublishReadinessResult } from "../drLurie/publishReadiness.js";

export const PLATFORM_REQUIRED_CONTENT_PATH = "article_body.v1";
// The per-site pdf-tool tenancy (get_pdf_tool_storage_grant) is the only sanctioned artifact path
// fleet-wide; platform's protocol id follows the same naming convention as Dr. Lurie's.
export const PLATFORM_REQUIRED_ARTIFACT_PROTOCOL = "pdf_tool_platform_blob.v1";
// Object-substrate behaviors. publish_now = object_publish + an approved release_to_production;
// publish_only = commit the export, defer the release; build_only = validate/dry-run, no side
// effects. There is NO "schedule" (object_publish has no scheduling — that was the legacy
// publish_by_time dialect) and NO "unpublish" (governed removal is object_retire, a separate
// approval-held verb, never a publish behavior).
export const PLATFORM_RELEASE_BEHAVIORS = ["publish_now", "publish_only", "build_only"] as const;

// A Blob-shaped artifact pointer that LOOKS materialized but must be proven so for this request.
const blobShapedRef = /^(?:images?|pdfs?|documents?)\/[^\s/]+\/[^\s/]+\.[a-z0-9]{2,5}$/i;

const mediaSrcsOf = (body: { nodes: Array<{ public: { media?: { src?: string } } }> }): string[] =>
  body.nodes.map((node) => node.public.media?.src).filter((src): src is string => typeof src === "string");

export function evaluatePlatformPublishReadiness(input: PublishReadinessInput): PublishReadinessResult {
  const checklist: PublishReadinessCheck[] = [];
  const blockers: string[] = [];
  const pass = (key: string, label: string, detail?: string) => checklist.push({ key, label, status: "pass", detail });
  const acceptedEmpty = (key: string, label: string, detail?: string) => checklist.push({ key, label, status: "accepted_empty", detail });
  const fail = (key: string, label: string, detail: string) => { checklist.push({ key, label, status: "fail", detail }); blockers.push(key); };

  // 1. article_body.v1 valid — the canonical workspace body contract; the client-side content_item
  // shape is validated by the CLIENT's own validator (object_validate), which the publication
  // controller requires as separate evidence. This check gates only the workspace-side contract.
  const body = articleBodySchema.safeParse(input.articleBody);
  if (body.success) pass("article_body_valid", "article_body.v1 valid");
  else fail("article_body_valid", "article_body.v1 valid", `invalid article body: ${body.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);

  // 2. Blob artifacts verified — no Blob-shaped media trusted unless pdf-tool materialization for
  // THIS request is confirmed by the caller.
  const verified = new Set((input.verifiedMediaRefs ?? []).map((ref) => String(ref)));
  const mediaSrcs = body.success ? mediaSrcsOf(body.data) : [];
  const unverified = mediaSrcs.filter((src) => blobShapedRef.test(src) && !verified.has(src));
  if (mediaSrcs.length === 0) pass("media_artifacts_verified", "Blob artifacts verified", "no media artifacts");
  else if (unverified.length === 0) pass("media_artifacts_verified", "Blob artifacts verified", `${mediaSrcs.length} media reference(s) confirmed`);
  else fail("media_artifacts_verified", "Blob artifacts verified", `unverified Blob-shaped media (pdf-tool materialization not confirmed): ${unverified.join(", ")}`);

  // 3. Taxonomy resolved against the site's registry, or explicitly accepted empty. Platform's
  // registry is reachable through registry_get; unknown terms block at the client's own publish gate,
  // so a silently-missing taxonomy here would only defer the failure — surface it now.
  const tags = input.taxonomy?.tags ?? [];
  if (tags.length > 0) pass("taxonomy", "Taxonomy resolved", `${tags.length} tag(s)`);
  else if (input.taxonomy?.acceptedEmpty === true) acceptedEmpty("taxonomy", "Taxonomy resolved", "explicitly accepted empty");
  else fail("taxonomy", "Taxonomy resolved", "taxonomy missing and not explicitly accepted empty");

  // 4. Pinned approval present.
  if (input.approval?.pinned === true && input.approval.approvedBy) pass("pinned_approval", "Pinned approval present", `pinned by ${input.approval.approvedBy}`);
  else fail("pinned_approval", "Pinned approval present", "no pinned approval on the publish request");

  // 5. Release / build behavior selected — publish and release are SEPARATE gates on this client;
  // the behavior states which of the two the approval covers.
  if (input.releaseBehavior && (PLATFORM_RELEASE_BEHAVIORS as readonly string[]).includes(input.releaseBehavior)) pass("release_behavior", "Release/build behavior selected", input.releaseBehavior);
  else fail("release_behavior", "Release/build behavior selected", `select one of: ${PLATFORM_RELEASE_BEHAVIORS.join(", ")}`);

  // 6. Hard constraints — same three keys as every readiness surface renders; platform's values.
  const declared = input.hardConstraints ?? {};
  const contentPath = declared.contentPath ?? (body.success ? PLATFORM_REQUIRED_CONTENT_PATH : undefined);
  if (contentPath === PLATFORM_REQUIRED_CONTENT_PATH) pass("hard_content_path", `contentPath = ${PLATFORM_REQUIRED_CONTENT_PATH}`);
  else fail("hard_content_path", `contentPath = ${PLATFORM_REQUIRED_CONTENT_PATH}`, `got ${contentPath ?? "(none)"}`);
  if (declared.artifactProtocol === PLATFORM_REQUIRED_ARTIFACT_PROTOCOL) pass("hard_artifact_protocol", `artifactProtocol = ${PLATFORM_REQUIRED_ARTIFACT_PROTOCOL}`);
  else fail("hard_artifact_protocol", `artifactProtocol = ${PLATFORM_REQUIRED_ARTIFACT_PROTOCOL}`, `got ${declared.artifactProtocol ?? "(none)"}`);
  // Structurally true on this client (it has no legacy path), but the caller must still DECLARE it —
  // an undeclared flag usually means the payload was assembled from another client's conventions.
  if (declared.legacyFallbacksUsed === false) pass("hard_legacy_fallbacks", "legacyFallbacksUsed = false");
  else fail("hard_legacy_fallbacks", "legacyFallbacksUsed = false", `got ${String(declared.legacyFallbacksUsed ?? "(none)")}`);

  const status = blockers.length === 0 ? "go" : "no_go";
  return {
    status,
    state: status === "go" ? "ready_for_publish_execution" : "blocked_for_publish_execution",
    checklist,
    blockers,
    requiredAction: status === "go" ? undefined : `Resolve: ${blockers.join(", ")}.`,
    hardConstraints: { contentPath: PLATFORM_REQUIRED_CONTENT_PATH, artifactProtocol: PLATFORM_REQUIRED_ARTIFACT_PROTOCOL, legacyFallbacksUsed: false }
  };
}
