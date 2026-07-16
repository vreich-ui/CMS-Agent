// Dr. Lurie executable call-tool policy. This is enforcement that runs at project.call_tool time,
// distinct from the config permission model (allowedTools / toolPolicies / defaultToolPolicy).
//
// Dr. Lurie runs with full access, and its remote server still advertises legacy "artifact fallback"
// tools plus accepts fallback artifact SOURCES. Those bypass the sanctioned materialization path
// (get_pdf_tool_storage_grant -> PDF-Tool import/create -> artifact reference), so live rendering
// cannot guarantee the asset. This policy blocks them regardless of what tools/list advertises or
// what the config marks "allowed":
//   - legacy artifact fallback tools by name: save_artifact, create_artifact_from_url, and direct
//     upload intents (create_artifact_upload_intent);
//   - fallback artifact SOURCE arguments on any tool: public remote image URLs, copied raw artifact
//     references, repo/source paths, and hand-authored blob-store keys.

import type { ArtifactPolicyWarning } from "./artifactPolicy.js";

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

// Legacy artifact-fallback tool names. Exact names plus a couple of shape patterns so a renamed
// variant (e.g. save_artifact_v2, create_artifact_from_remote_url, create_upload_intent) is still
// caught. The sanctioned brokered tools (get_pdf_tool_storage_grant, search/get/list/verify/restore)
// are intentionally NOT here.
export const LEGACY_ARTIFACT_FALLBACK_TOOLS = new Set(["save_artifact", "create_artifact_from_url", "create_artifact_upload_intent"]);
const legacyToolNamePatterns = [/save_.*artifact/i, /artifact.*from_url/i, /(create|make|new)_.*upload_intent/i, /upload_intent/i];

const isLegacyArtifactTool = (tool: string): boolean => LEGACY_ARTIFACT_FALLBACK_TOOLS.has(tool) || legacyToolNamePatterns.some((pattern) => pattern.test(tool));

const IMAGE_EXTENSION = "(?:png|jpe?g|webp|gif|svg|avif|bmp|tiff?)";
// A remote/data image URL: an absolute http(s) URL, a protocol-relative //host URL, or a data: URI
// with image bytes. These may not be shipped as artifact sources — images must be materialized.
const remoteImageUrlPattern = new RegExp(`^(?:https?:)?//[^\\s]+\\.${IMAGE_EXTENSION}(?:[?#][^\\s]*)?$`, "i");
const dataImageUrlPattern = /^data:image\//i;
// A copied raw image artifact reference (e.g. "image/req_demo/abc123.png" or "image//req/x.jpg").
// A materialized site path ("/assets/...", "/_astro/...", "/media/...") is NOT this shape.
const copiedArtifactRefPattern = new RegExp(`^images?/{1,2}[A-Za-z0-9._~/%-]+\\.${IMAGE_EXTENSION}$`, "i");
// A hand-authored blob-store key: a multi-segment key rooted at a known store namespace with a
// trailing filename+extension (no leading slash — a leading slash marks a materialized public path).
const handAuthoredBlobKeyPattern = /^(?:images?|documents?|pdfs?|artifacts?|blobs?|uploads?|media|files?)\/[^\s]+\/[^\s/]+\.[a-z0-9]{2,5}$/i;
// A repo / source path used as an artifact source: relative traversal, a known source directory root,
// or a path (with separator) ending in a code/content file extension.
const repoTraversalPattern = /^\.\.?\//;
const repoRootPattern = /^\/?(?:src|content|contents|pages|posts|app|components|public|assets|lib|packages|node_modules)\//i;
const repoFileExtensionPattern = /\/[^\s/]+\.(?:md|mdx|markdown|astro|tsx?|jsx?|mjs|cjs|vue|svelte|html?|css|scss|json|ya?ml)$/i;

const classifyValue = (value: string): { code: string; message: string } | undefined => {
  if (remoteImageUrlPattern.test(value) || dataImageUrlPattern.test(value)) {
    return { code: "blocked_remote_image_url", message: "Public remote/data image URLs are not accepted artifact sources; images must be materialized via the sanctioned PDF-Tool grant flow." };
  }
  if (copiedArtifactRefPattern.test(value)) {
    return { code: "blocked_copied_artifact_ref", message: "Copied raw image artifact references are not accepted; obtain a fresh reference through the sanctioned artifact flow instead of hand-copying one." };
  }
  if (handAuthoredBlobKeyPattern.test(value)) {
    return { code: "blocked_hand_authored_blob_key", message: "Hand-authored blob-store keys are not accepted; the backend assigns storage keys during materialization." };
  }
  if (repoTraversalPattern.test(value) || repoRootPattern.test(value) || repoFileExtensionPattern.test(value)) {
    return { code: "blocked_repo_path", message: "Repository/source paths are not accepted artifact sources; artifacts must be materialized, not read from a repo path." };
  }
  return undefined;
};

const formatPath = (segments: Array<string | number>): string => segments.reduce<string>((path, segment) => (typeof segment === "number" ? `${path}[${segment}]` : path ? `${path}.${segment}` : String(segment)), "") || "$";

// Walk the argument tree and report the first fallback-source finding per distinct location. Value
// shape (not key name) drives detection, so a nested `{ artifact: { url } }` is caught the same as a
// top-level `url`.
const scanArguments = (args: unknown): ArtifactPolicyWarning[] => {
  const findings: ArtifactPolicyWarning[] = [];
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (typeof value === "string") {
      const hit = classifyValue(value.trim());
      if (hit) findings.push({ code: hit.code, severity: "error", path: `arguments.${formatPath(path)}`, message: hit.message });
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...path, index])); return; }
    if (isRecord(value)) { for (const [key, child] of Object.entries(value)) visit(child, [...path, key]); }
  };
  visit(args, []);
  return findings;
};

// Evaluate a project.call_tool request against the executable policy. Returns error-severity
// findings when the call must be blocked; an empty array means the call may proceed to the permission
// check and remote transport.
export function evaluateDrLurieCallToolPolicy(call: { tool: string; arguments?: Record<string, unknown> }): ArtifactPolicyWarning[] {
  const findings: ArtifactPolicyWarning[] = [];
  if (isLegacyArtifactTool(call.tool)) {
    findings.push({
      code: "blocked_legacy_artifact_tool",
      severity: "error",
      path: "tool",
      message: `Legacy artifact fallback tool "${call.tool}" is blocked; materialize artifacts through the sanctioned PDF-Tool grant flow and reference them by artifactReference.`
    });
  }
  findings.push(...scanArguments(call.arguments ?? {}));
  return findings;
}
