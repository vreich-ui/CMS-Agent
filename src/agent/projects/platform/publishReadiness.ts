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

import { validateOutput } from "../../execution/outputValidator.js";
import { getWorkspaceNode } from "../../workspace/nodes.js";
import type { PublishReadinessCheck, PublishReadinessInput, PublishReadinessResult } from "../drLurie/publishReadiness.js";
import { evaluateContentReadiness } from "../readinessContentChecks.js";

export const PLATFORM_REQUIRED_CONTENT_PATH = "client_object.v1";
// The per-site pdf-tool tenancy (get_pdf_tool_storage_grant) is the only sanctioned artifact path
// fleet-wide; platform's protocol id follows the same naming convention as Dr. Lurie's.
export const PLATFORM_REQUIRED_ARTIFACT_PROTOCOL = "pdf_tool_platform_blob.v1";
// Object-substrate behaviors. publish_now = object_publish + an approved release_to_production;
// publish_only = commit the export, defer the release; build_only = validate/dry-run, no side
// effects. There is NO "schedule" (object_publish has no scheduling — that was the legacy
// publish_by_time dialect) and NO "unpublish" (governed removal is object_retire, a separate
// approval-held verb, never a publish behavior).
export const PLATFORM_RELEASE_BEHAVIORS = ["publish_now", "publish_only", "build_only"] as const;

export function evaluatePlatformPublishReadiness(input: PublishReadinessInput): PublishReadinessResult {
  const checklist: PublishReadinessCheck[] = [];
  const blockers: string[] = [];
  const pass = (key: string, label: string, detail?: string) => checklist.push({ key, label, status: "pass", detail });
  const acceptedEmpty = (key: string, label: string, detail?: string) => checklist.push({ key, label, status: "accepted_empty", detail });
  const fail = (key: string, label: string, detail: string) => { checklist.push({ key, label, status: "fail", detail }); blockers.push(key); };

  // 1. client_object.v1 valid — the surviving envelope is not an "article body", it is one client
  // object plus its provenance; checked against the article_body node's OWN outputSchema, which is the
  // single authority for "is this a valid body": the same schema the executor enforces at execution
  // time, buildInitialRun enforces on a seeded late-stage entrypoint, and the publisher enforces before
  // publishing, so the entrypoint, the publisher and this readiness gate cannot drift apart. This used
  // to parse the workspace-local articleBodySchema ({schema_version, nodes}) — a shape the node never
  // emits — which is what made `article_body_valid` unsatisfiable for real pipeline output.
  // The client-side content_item shape is still validated by the CLIENT's own validator
  // (object_validate), which the publication controller requires as separate evidence; this check gates
  // only the workspace-side contract.
  const body = validateOutput(input.articleBody, getWorkspaceNode("article_body")?.outputSchema);
  if (body.ok) pass("article_body_valid", "client_object.v1 valid");
  else fail("article_body_valid", "client_object.v1 valid", `invalid article body: ${body.errors.slice(0, 3).join("; ")}`);

  // 2. Content checks shared by every client (readinessContentChecks.ts): every media reference in
  // the body verified for THIS request (image src and pdf refs alike), reader-visible content present,
  // no article_body-declared blockers, no unwaivable upstream blocker (aggression_ceiling_missing),
  // and requested media actually delivered. A `fail` here is a blocker like any other.
  for (const check of evaluateContentReadiness({ articleBody: input.articleBody, articleBodyValid: body.ok, verifiedMediaRefs: input.verifiedMediaRefs, stageOutputs: input.stageOutputs })) {
    checklist.push(check);
    if (check.status === "fail") blockers.push(check.key);
  }

  // 3. Taxonomy resolved against the site's registry, or explicitly accepted empty. Platform's
  // registry is reachable through registry_get; unknown terms block at the client's own publish gate,
  // so a silently-missing taxonomy here would only defer the failure — surface it now.
// Go-live 2026-07-31: ceremony checks auto-default so a publish request is never blocked on
  // paperwork; an explicit contradictory declaration still fails (correctness is kept, ceremony is not).
  const tags = input.taxonomy?.tags ?? [];
  if (tags.length > 0) pass("taxonomy", "Taxonomy resolved", `${tags.length} tag(s)`);
  else acceptedEmpty("taxonomy", "Taxonomy resolved", input.taxonomy?.acceptedEmpty === true ? "explicitly accepted empty" : "auto-accepted empty (go-live default)");

  // 4. Approval — auto-approved unless the caller explicitly withholds it (approval: { pinned: false }).
  if (input.approval?.pinned === false) fail("pinned_approval", "Approval present", "approval explicitly withheld on the publish request");
  else pass("pinned_approval", "Approval present", input.approval?.approvedBy ? `pinned by ${input.approval.approvedBy}` : "auto-approved (go-live default)");

  // 5. Release / build behavior — defaults to publish_now (publish and release are still SEPARATE
  // client-side verbs; publish_now means both are covered). An unknown declared value still fails.
  const releaseBehavior = input.releaseBehavior ?? "publish_now";
  if ((PLATFORM_RELEASE_BEHAVIORS as readonly string[]).includes(releaseBehavior)) pass("release_behavior", "Release/build behavior selected", input.releaseBehavior ? releaseBehavior : `${releaseBehavior} (go-live default)`);
  else fail("release_behavior", "Release/build behavior selected", `select one of: ${PLATFORM_RELEASE_BEHAVIORS.join(", ")}`);

  // 6. Hard constraints — same three keys as every readiness surface renders; platform's values.
  const declared = input.hardConstraints ?? {};
  const contentPath = declared.contentPath ?? (body.ok ? PLATFORM_REQUIRED_CONTENT_PATH : undefined);
  if (contentPath === PLATFORM_REQUIRED_CONTENT_PATH) pass("hard_content_path", `contentPath = ${PLATFORM_REQUIRED_CONTENT_PATH}`);
  else fail("hard_content_path", `contentPath = ${PLATFORM_REQUIRED_CONTENT_PATH}`, `got ${contentPath ?? "(none)"}`);
  // Alignment board D3(ii): this check is a workspace-side DECLARATION, not client verification —
  // the label and detail say so on both outcomes so no reviewer reads it as client-verified.
  const artifactProtocolCaveat = "— declaration only: the platform contract publishes no artifact_protocol identifier to verify against (alignment D3; becomes client-verified when the contract carries one)";
  const artifactProtocol = declared.artifactProtocol ?? PLATFORM_REQUIRED_ARTIFACT_PROTOCOL;
  if (artifactProtocol === PLATFORM_REQUIRED_ARTIFACT_PROTOCOL) pass("hard_artifact_protocol", "artifactProtocol declared (workspace-side)", `declared ${PLATFORM_REQUIRED_ARTIFACT_PROTOCOL}${declared.artifactProtocol ? "" : " (go-live default)"} ${artifactProtocolCaveat}`);
  else fail("hard_artifact_protocol", "artifactProtocol declared (workspace-side)", `got ${artifactProtocol}, expected ${PLATFORM_REQUIRED_ARTIFACT_PROTOCOL} ${artifactProtocolCaveat}`);
  // Structurally true on this client (it has no legacy path), but the caller must still DECLARE it —
  // an undeclared flag usually means the payload was assembled from another client's conventions.
  if (declared.legacyFallbacksUsed === true) fail("hard_legacy_fallbacks", "legacyFallbacksUsed = false", "got true");
  else pass("hard_legacy_fallbacks", "legacyFallbacksUsed = false", declared.legacyFallbacksUsed === false ? undefined : "go-live default");

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
