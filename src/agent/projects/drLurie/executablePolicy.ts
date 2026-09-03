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
//   - the RETIRED publish dialect: the frozen save_json_blob_* article verbs and the five-agent
//     per-stage output tools, which the ratified alignment doc froze and directed must not be
//     allowlisted for this project. The seeded config blocks each by name, but this client's
//     defaultToolPolicy is "allowed" — so a legacy verb the enumeration does not happen to cover
//     would otherwise be permitted. Matching by shape closes that gap;
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

// The retired publish dialect, matched by SHAPE so a variant the seeded blocklist does not name is
// still refused: the whole save_json_blob_* family, and the five-agent pipeline's per-stage
// update_output / mark_complete verbs. The sanctioned object verbs (object_create, object_checkout,
// object_validate, object_patch, object_publish, object_checkin) match none of these.
const retiredDialectToolPatterns = [
  /^save_json_blob(_|$)/i,
  /^(reader_insight|research|angle|draft|final_article)_(update_output|mark_complete)$/i
];

const isRetiredDialectTool = (tool: string): boolean => retiredDialectToolPatterns.some((pattern) => pattern.test(tool));

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
// or a path (with separator) ending in a code/content file extension. These patterns describe
// RELATIVE repo paths; an absolute served path (single leading slash, e.g. /assets/..., /_astro/...,
// /media/...) is a materialized public reference and is excluded by isServedPath below.
const repoTraversalPattern = /^\.\.?\//;
const repoRootPattern = /^(?:src|content|contents|pages|posts|app|components|public|assets|lib|packages|node_modules)\//i;
const repoFileExtensionPattern = /\/[^\s/]+\.(?:md|mdx|markdown|astro|tsx?|jsx?|mjs|cjs|vue|svelte|html?|scss|ya?ml)$/i;
// A single leading slash marks an absolute, already-materialized served path (matches artifactPolicy's
// treatment of /assets and /_astro). A double leading slash is protocol-relative and handled as a
// remote URL, so it must NOT count as a served path here.
const isServedPath = (value: string): boolean => value.startsWith("/") && !value.startsWith("//");

// REVIEW — AN ABSOLUTE REMOTE URL IS NOT A REPOSITORY PATH, and until now the repo-path classifier
// could not tell the difference.
//
// `repoFileExtensionPattern` is unanchored at the front: it fires on any value ending in
// `/<name>.<code-or-content-extension>`, and `.html`/`.htm`/`.md`/`.yaml` are all on that list. A
// perfectly ordinary citation — `https://www.fda.gov/drugs/guide.html` — therefore classified as
// `blocked_repo_path`. That was harmless while this policy only ever saw a model's own hand-written
// project.call_tool arguments; C2 changed the exposure by running `enforceCallToolPolicy` inside
// `artifactMaterialization.ts`, whose `create_agent_artifact_job` arguments now carry the
// deterministically derived `data` for an article PDF — including `sources[].url`, straight out of
// draft_writer. One cited .html source and the whole PDF slot came back `tool_policy_blocked`.
//
// So the repo-path branch is scoped to what it is actually about: a path INTO A REPOSITORY OR A
// SOURCE TREE, which is by definition not something with a scheme and a host. Nothing is weakened —
// a remote IMAGE url is still refused one branch earlier by `remoteImageUrlPattern`, which is the
// rule that governs remote artifact SOURCES; this only stops a URL being reported as the wrong thing
// entirely. A relative `src/pages/post.md`, a `../assets/x.mdx`, and every other genuine repo path
// are untouched: none of them has a scheme.
const remoteUrlPattern = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const isRemoteUrl = (value: string): boolean => remoteUrlPattern.test(value);

// FIX-2 — THE MACHINE-MINTED CANONICAL BLOB KEY, and why it must be exempted BEFORE anything else.
//
// pdf-tool's canonical artifact layout is `{artifactKind}/{safeRequestId}/{sha256}{ext}`
// (pdf-tool/netlify/lib/artifact-layout.ts). Two of the patterns above match that shape exactly:
// `copiedArtifactRefPattern` (any `image/<request>/<file>.<imageExt>`) and, for every kind,
// `handAuthoredBlobKeyPattern`. So BRIEF §3.10's sanctioned cover binding —
// `assets.images[] = { assetId, blobKey }` on create_agent_artifact_job, naming an image this same run
// just generated and whose bytes deliberately never travel over MCP — had precisely the forbidden
// shape, and on dr-lurie an article PDF with a cover became a blocked slot instead of a render.
//
// The rule this policy exists to enforce is about HAND-AUTHORED references: a human or a model
// TYPING a storage key it believes exists, instead of obtaining one through the artifact flow. A key
// the deterministic layout produced is the opposite of that — it cannot be typed, because its
// filename is the sha256 of the bytes, which nobody knows until the bytes exist. pdf-tool's own
// `parseArtifactBlobKey` is exactly this predicate ("parsing a key back proves it was produced by
// this deterministic layout rather than hand-authored — the verification API leans on that"), and it
// is MIRRORED here rather than imported: these are three separate repositories and this module must
// stay dependency-free.
//
// The check runs FIRST, before every classifier, deliberately. Placing it inside the copied-ref
// branch alone would leave the hand-authored-blob-key branch (and, for an unusual extension, the
// repo-path branch) firing on the very same string one line later — the same block, arrived at by a
// different name.
//
// WHAT IT DOES NOT WEAKEN: a hand-copied `image/req_demo/hero.webp` is still blocked, because `hero`
// is not 64 hex characters; and nothing here touches remote/data URLs, legacy tools, or the retired
// publish dialect. Kept deliberately narrow to the KEY SHAPE rather than to a field path
// (`assets.images[].blobKey`): the same canonical key is equally legitimate anywhere a machine passes
// one, and a path-scoped exemption would have to be re-widened for every new sanctioned field.
//
// REVIEW — THE EXEMPTION IS THE LAYOUT, NOT A FAMILY RESEMBLANCE TO IT. As first written the kind
// segment was `[a-z]+` and the request segment `[^/]+`, both far wider than the layout that is being
// mirrored, and an exemption that runs FIRST is only ever as narrow as its own pattern:
//   * `[a-z]+` admitted namespaces pdf-tool never mints. `uploads/`, `documents/`, `artifacts/` and
//     `media/` are precisely the roots `handAuthoredBlobKeyPattern` exists to refuse, and any of them
//     followed by 64 hex characters walked straight past it.
//   * `[^/]+` admitted a "request id" containing spaces, `%2e%2e`, or anything else short of a
//     literal slash, where pdf-tool's own `safePathSegment` reduces a request id to
//     `[a-zA-Z0-9._-]`. A key it could never have produced was being treated as proof it did.
//   * Between them they also exempted `src/<anything>/<64 hex>.md` from the repo-path rule.
// pdf-tool's canonical kinds are exactly image/pdf/binary (`CANONICAL_ARTIFACT_KINDS`,
// artifact-layout.ts) and its segments are exactly that charset, so those are the pattern now. The
// sanctioned §3.10 cover binding is unaffected — that is the shape it already has.
//
// WHAT THIS STILL CANNOT PROVE, stated plainly rather than implied away: this is a SHAPE test, so a
// caller that types 64 hex characters produces a string that parses. What it buys is that such a key
// resolves to nothing in the tenant's store and fails as a missing asset, instead of an out-of-layout
// key being waved through as machine-minted. Provenance would need a store lookup this module (three
// separate repositories, deliberately dependency-free) cannot make.
const CANONICAL_ARTIFACT_KINDS = "(?:image|pdf|binary)";
const CANONICAL_REQUEST_SEGMENT = "[A-Za-z0-9._-]+";
const CANONICAL_BLOB_KEY_PATTERN = new RegExp(`^${CANONICAL_ARTIFACT_KINDS}/(${CANONICAL_REQUEST_SEGMENT})/[a-f0-9]{64}(?:\\.[a-z0-9]+)?$`);
// REVIEW: the request segment must ALSO contain at least one alphanumeric, so it cannot be `.` or
// `..`. pdf-tool's `safePathSegment` charset includes `.`, so `image/../<64 hex>.png` parsed as a
// machine-minted key and walked past `copiedArtifactRefPattern` — a middle segment that is a
// parent-directory traversal resolves outside the `image/` namespace this exemption is scoped to,
// which is the opposite of what "only the deterministic layout produces this shape" is meant to buy.
// Checked as a separate predicate on the captured segment rather than spelled `[..]*[alnum][..]*`
// inside the pattern: two adjacent quantified classes over an overlapping alphabet is the shape that
// backtracks quadratically, and this classifier runs over EVERY string in a call's arguments —
// including, since C2, a PDF slot's whole article prose. One capture plus one linear test is the
// same rule without that edge.
const CANONICAL_SEGMENT_HAS_ALPHANUMERIC = /[A-Za-z0-9]/;
export const isCanonicalArtifactBlobKey = (value: string): boolean => {
  const match = CANONICAL_BLOB_KEY_PATTERN.exec(value);
  return !!match && CANONICAL_SEGMENT_HAS_ALPHANUMERIC.test(match[1]);
};

const classifyValue = (value: string): { code: string; message: string } | undefined => {
  if (isCanonicalArtifactBlobKey(value)) return undefined;
  if (remoteImageUrlPattern.test(value) || dataImageUrlPattern.test(value)) {
    return { code: "blocked_remote_image_url", message: "Public remote/data image URLs are not accepted artifact sources; images must be materialized via the sanctioned PDF-Tool grant flow." };
  }
  if (copiedArtifactRefPattern.test(value)) {
    return { code: "blocked_copied_artifact_ref", message: "Copied raw image artifact references are not accepted; obtain a fresh reference through the sanctioned artifact flow instead of hand-copying one." };
  }
  if (handAuthoredBlobKeyPattern.test(value)) {
    return { code: "blocked_hand_authored_blob_key", message: "Hand-authored blob-store keys are not accepted; the backend assigns storage keys during materialization." };
  }
  if (!isServedPath(value) && !isRemoteUrl(value) && (repoTraversalPattern.test(value) || repoRootPattern.test(value) || repoFileExtensionPattern.test(value))) {
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
  if (isRetiredDialectTool(call.tool)) {
    findings.push({
      code: "blocked_retired_publish_dialect",
      severity: "error",
      path: "tool",
      message: `Retired legacy publish-dialect tool "${call.tool}" is blocked; the frozen save_json_blob_*/per-stage pipeline takes zero new writes. Publish through the object verbs: object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin.`
    });
  }
  findings.push(...scanArguments(call.arguments ?? {}));
  return findings;
}
