// T5 (2026-09-16 annotate-bridge plan) — the CONSTRUCTOR for image_annotation, same shape as A5's,
// A7's and A8's: the operation's dispatched input is flat (tenantId, image, annotations, slot?,
// deviceScaleFactor? — descriptors/imageAnnotation.ts) while image_annotation_studio's entry node
// reads ONE nested `initialInput.imageAnnotationBrief`. A rename table cannot nest, so the binding
// carries an empty inputMapping and this builder does the whole translation.
//
// THE ONE DERIVATION THIS BUILDER PERFORMS, AND WHY IT IS NOT A GUESS. Every one of the three bridge
// verbs (analyze_image_layout, annotate_image, check_image_text) requires `request_id` — the artifact
// request the image belongs to — while the operation's own `image` accepts EITHER {requestId,
// sha256} OR {publicPath}. A publicPath is not a description of an image, it is the bridge's own
// addressing form `/img/<requestId>/<sha256>.<ext>` (the pattern the live tools' own schemas state
// verbatim), so the requestId and sha256 are LITERALLY IN IT and are read out of it rather than
// asked for twice. A publicPath that does not match that shape is refused BY NAME here — never
// completed from the tenantId, never sent to the bridge to be refused a call later.
//
// NOTHING ELSE IS INVENTED: no slot is minted, no deviceScaleFactor is raised, no annotation text is
// rewritten, and the placement decision belongs to the analyze stage (which reads the image's own
// grid) rather than to this pure, offline constructor.

export const IMAGE_ANNOTATION_BRIEF_BUILDER_ID = "image_annotation_brief_builder.v1";
export const IMAGE_ANNOTATION_BRIEF_KEY = "imageAnnotationBrief";
export const IMAGE_ANNOTATION_BRIEF_REQUIRED_OPERATION_FIELDS = ["tenantId", "image", "annotations"] as const;

/** AnnotationSpec v1's own four text styles — the descriptor's closed `role` enum, verbatim. */
export const IMAGE_ANNOTATION_ROLES = ["title", "caption", "label", "badge"] as const;
export type ImageAnnotationRole = (typeof IMAGE_ANNOTATION_ROLES)[number];

export type ImageAnnotationEntry = { text: string; role: ImageAnnotationRole };

/** `requestId` is always resolved (supplied, or read out of publicPath); at least one of
 *  sha256/publicPath is always present — the bridge needs one to name the artifact. */
export type ImageAnnotationImageRef = { requestId: string; sha256?: string; publicPath?: string };

export type ImageAnnotationBrief = {
  tenantId: string;
  image: ImageAnnotationImageRef;
  annotations: ImageAnnotationEntry[];
  slot?: string;
  deviceScaleFactor?: number;
};

export type ImageAnnotationBriefBuildResult =
  | { ok: true; tenantId: string; brief: ImageAnnotationBrief }
  | { ok: false; code: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// The bridge's own addressing form, copied from the live analyze_image_layout / annotate_image /
// check_image_text schemas' `public_path` pattern: ^/(img|pdf)/[^/]+/[0-9a-fA-F]{64}\.[a-z]+$.
// Narrowed to /img/ here because this operation annotates IMAGES; a /pdf/ path is refused by name
// rather than sent to a verb that would answer ANNOTATE_ARTIFACT_NOT_IMAGE.
const IMAGE_PUBLIC_PATH = /^\/img\/([^/]+)\/([0-9a-fA-F]{64})\.[a-z]+$/;

/** Pure: no clock, no store, no network, no model. */
export function buildImageAnnotationBrief(input: unknown): ImageAnnotationBriefBuildResult {
  const source = isRecord(input) ? input : {};
  const refuse = (code: string, reason: string): ImageAnnotationBriefBuildResult => ({ ok: false, code, reason });

  const tenantId = nonEmptyString(source.tenantId) ? source.tenantId.trim() : undefined;
  if (!tenantId) {
    return refuse(
      "image_annotation_brief_tenant_missing",
      "image_annotation was dispatched with no tenantId; the base image, the artifact it writes and every bridge call it makes are tenant-scoped, so a brief cannot be built without one."
    );
  }

  const image = isRecord(source.image) ? source.image : undefined;
  if (!image) {
    return refuse(
      "image_annotation_brief_image_missing",
      `image_annotation needs an \`image\` naming the base image by provenance — {requestId, sha256} or {publicPath}; received ${JSON.stringify(source.image)}. This operation never searches for an image by description.`
    );
  }

  let requestId = nonEmptyString(image.requestId) ? image.requestId.trim() : undefined;
  let sha256 = nonEmptyString(image.sha256) ? image.sha256.trim() : undefined;
  let publicPath: string | undefined;

  if (image.publicPath !== undefined) {
    if (!nonEmptyString(image.publicPath)) {
      return refuse("image_annotation_brief_public_path_invalid", `image.publicPath, when supplied, must be a non-empty string; received ${JSON.stringify(image.publicPath)}.`);
    }
    publicPath = image.publicPath.trim();
    const matched = IMAGE_PUBLIC_PATH.exec(publicPath);
    if (!matched) {
      return refuse(
        "image_annotation_brief_public_path_unaddressable",
        `image.publicPath "${publicPath}" is not the bridge's own image addressing form /img/<requestId>/<sha256>.<ext>. The request id and checksum every bridge verb needs are read OUT of that path; a path in any other shape names nothing this operation can scope a call to, and is refused here rather than sent to the bridge to fail as artifact_not_in_request_index.`
      );
    }
    const [, pathRequestId, pathSha256] = matched;
    if (requestId && requestId !== pathRequestId) {
      return refuse(
        "image_annotation_brief_image_ref_conflict",
        `image.requestId "${requestId}" disagrees with the request id "${pathRequestId}" inside image.publicPath. Two names for one artifact must agree; neither is silently preferred over the other.`
      );
    }
    if (sha256 && sha256.toLowerCase() !== pathSha256.toLowerCase()) {
      return refuse(
        "image_annotation_brief_image_ref_conflict",
        `image.sha256 "${sha256}" disagrees with the checksum inside image.publicPath ("${pathSha256}"). Two names for one artifact must agree; neither is silently preferred over the other.`
      );
    }
    requestId = pathRequestId;
    sha256 = sha256 ?? pathSha256;
  }

  if (!requestId) {
    return refuse(
      "image_annotation_brief_request_id_missing",
      "image_annotation's base image was named by a bare sha256 with no requestId and no publicPath. Every bridge verb is scoped by the artifact REQUEST the image belongs to (analyze_image_layout/annotate_image/check_image_text all require request_id), and a request this run cannot name is a request it does not call into. Supply {requestId, sha256} or a publicPath."
    );
  }
  if (!sha256 && !publicPath) {
    return refuse(
      "image_annotation_brief_image_ref_incomplete",
      `image names request "${requestId}" but neither a sha256 nor a publicPath, so nothing identifies WHICH image in that request to annotate. A lone requestId is not a usable reference.`
    );
  }

  const annotations = Array.isArray(source.annotations) ? source.annotations : undefined;
  if (!annotations || annotations.length === 0) {
    return refuse(
      "image_annotation_brief_annotations_missing",
      `image_annotation needs at least one entry in \`annotations\`; received ${JSON.stringify(source.annotations)}. An annotation run that draws nothing is never started — it would write a new artifact identical to the base one.`
    );
  }
  const built: ImageAnnotationEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of annotations.entries()) {
    const row = isRecord(entry) ? entry : undefined;
    if (!row || !nonEmptyString(row.text)) {
      return refuse("image_annotation_brief_annotation_text_missing", `annotations[${index}] carries no non-empty \`text\`; received ${JSON.stringify(entry)}. An empty string is not a label.`);
    }
    if (!nonEmptyString(row.role) || !(IMAGE_ANNOTATION_ROLES as readonly string[]).includes(row.role.trim())) {
      return refuse(
        "image_annotation_brief_annotation_role_invalid",
        `annotations[${index}].role is ${JSON.stringify(row.role)}; the only roles AnnotationSpec v1 has text styles for are ${IMAGE_ANNOTATION_ROLES.join(", ")}. An unrecognised role is refused here rather than rendered at the default style, silently.`
      );
    }
    const text = row.text.trim();
    // THE SAME STRING TWICE IS NOT TWO ANNOTATIONS, it is one annotation and an unanswerable
    // completion check: check_image_text {mode:"expect"} matches a normalized SUBSTRING of the
    // detected text, so a duplicate can never be distinguished from a single draw and "both were
    // verified" would be a claim this run has no evidence for.
    if (seen.has(text.toLowerCase())) {
      return refuse(
        "image_annotation_brief_annotation_duplicate",
        `annotations[${index}] repeats the text "${text}". The completion evidence is check_image_text {mode:"expect"}, which matches each expected string as a substring of the detected text — it cannot tell one copy from two, so a duplicate would make "every drawn string was read back" unverifiable. Draw it once.`
      );
    }
    seen.add(text.toLowerCase());
    built.push({ text, role: row.role.trim() as ImageAnnotationRole });
  }

  const brief: ImageAnnotationBrief = {
    tenantId,
    image: { requestId, ...(sha256 ? { sha256: sha256.toLowerCase() } : {}), ...(publicPath ? { publicPath } : {}) },
    annotations: built
  };

  if (source.slot !== undefined) {
    if (!nonEmptyString(source.slot)) {
      return refuse("image_annotation_brief_slot_invalid", `slot, when supplied, must be a non-empty string; received ${JSON.stringify(source.slot)}.`);
    }
    brief.slot = source.slot.trim();
  }
  if (source.deviceScaleFactor !== undefined) {
    const factor = source.deviceScaleFactor;
    if (typeof factor !== "number" || !Number.isInteger(factor) || factor < 1 || factor > 3) {
      return refuse(
        "image_annotation_brief_device_scale_factor_invalid",
        `deviceScaleFactor, when supplied, must be an integer 1-3 (annotate_image's own range); received ${JSON.stringify(factor)}. A factor of 2 costs four times the pixels, which is what an up-front budget refusal is usually about — it is never quietly clamped.`
      );
    }
    brief.deviceScaleFactor = factor;
  }

  return { ok: true, tenantId, brief };
}
