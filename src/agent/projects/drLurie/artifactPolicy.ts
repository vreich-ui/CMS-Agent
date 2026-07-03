export type ArtifactPolicySeverity = "warning" | "error";

export type ArtifactPolicyWarning = {
  code: string;
  severity: ArtifactPolicySeverity;
  path: string;
  message: string;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const publicFieldNames = new Set(["src", "url", "href", "image", "featuredImage", "publicUrl", "canonicalUrl", "thumbnail", "ogImage"]);
const imageArtifactRefPattern = /(?:^|["'\s:/])image\/{1,2}[A-Za-z0-9._~/%-]+\.(?:png|jpe?g|webp)(?:$|[?#"'\s])/i;
const pdfArtifactRefPattern = /(?:^|["'\s:/])(?:document|pdf)\/{1,2}[A-Za-z0-9._~/%-]+\.pdf(?:$|[?#"'\s])/i;

const formatPath = (segments: Array<string | number>): string => segments.reduce<string>((path, segment) => typeof segment === "number" ? `${path}[${segment}]` : path ? `${path}.${segment}` : segment, "");

const looksLikeImageArtifactRef = (value: string): boolean => imageArtifactRefPattern.test(`${value} `) && !value.startsWith("/assets/") && !value.startsWith("/_astro/");
const looksLikePdfArtifactRef = (value: string): boolean => pdfArtifactRefPattern.test(`${value} `) || value.startsWith("/pdf/");

export function validateArticleBodyImagePlacement(articleBody: unknown): ArtifactPolicyWarning[] {
  if (!isRecord(articleBody) || !Array.isArray(articleBody.nodes)) return [];
  const warnings: ArtifactPolicyWarning[] = [];

  articleBody.nodes.forEach((node, index) => {
    if (!isRecord(node)) return;
    const media = isRecord(node.media) ? node.media : undefined;
    const rendering = isRecord(node.rendering) ? node.rendering : undefined;
    const kind = typeof node.kind === "string" ? node.kind : undefined;
    const mediaType = typeof media?.type === "string" ? media.type : undefined;
    const isImageNode = kind === "image" || mediaType === "image" || (typeof media?.src === "string" && looksLikeImageArtifactRef(media.src));
    if (!isImageNode) return;

    if (rendering?.placement !== "inline") {
      warnings.push({
        code: "image_missing_inline_rendering_placement",
        severity: "warning",
        path: `nodes[${index}].rendering.placement`,
        message: "Reader-visible image nodes should specify rendering.placement: 'inline' so Dr. Lurie live rendering does not drop the image."
      });
    }
  });

  return warnings;
}

export function validateNoRawImageArtifactPublicUrls(payload: unknown): ArtifactPolicyWarning[] {
  const warnings: ArtifactPolicyWarning[] = [];

  const visit = (value: unknown, path: Array<string | number>, parentKey?: string): void => {
    if (typeof value === "string") {
      if (parentKey && publicFieldNames.has(parentKey) && looksLikeImageArtifactRef(value)) {
        warnings.push({
          code: "raw_image_artifact_public_url",
          severity: "error",
          path: formatPath(path),
          message: "Raw Dr. Lurie image artifact references are not public reader-facing URLs; images must be materialized by the Dr. Lurie publishing backend."
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index], parentKey));
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key], key);
    }
  };

  visit(payload, []);
  return warnings;
}

export function summarizeArtifactPolicyWarnings(payload: unknown): ArtifactPolicyWarning[] {
  const warnings = [...validateArticleBodyImagePlacement(payload), ...validateNoRawImageArtifactPublicUrls(payload)];

  if (isRecord(payload)) {
    const serialized = JSON.stringify(payload);
    if (looksLikePdfArtifactRef(serialized) && !serialized.includes("raw_image_artifact_public_url")) {
      warnings.push({
        code: "pdf_artifact_route_allowed",
        severity: "warning",
        path: "$",
        message: "PDF artifact references may use Dr. Lurie's /pdf/* fallback, unlike raw image artifact references."
      });
    }
  }

  return warnings;
}
