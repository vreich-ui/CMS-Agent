// T5 (2026-09-16 annotate-bridge plan) — image_annotation: draw a deterministic text layer over an
// image that is already on the tenant plane, and PROVE the strings landed.
//
// THREE deterministic stages, zero model calls — the same posture documentRenderEngine.ts (A8) and
// assetLookupEngine.ts (A5) hold. Composing three bridge verbs and ranking 36 numbers is mechanical;
// nothing here needs judgment, so nothing here asks for it.
//
//   image_annotation_analyze — READ ONLY (the descriptor's own `analyze_image_layout` effect,
//                              riskLevel "read"). Calls the bridge's analyze_image_layout once and
//                              chooses a placement PER CELL FROM THE NUMBERS IT RETURNED. No cell id
//                              is hardcoded anywhere in this file: that is the entire point of
//                              calling analyze_image_layout, and a hardcoded "B2" would make the read
//                              ceremonial. Writes nothing.
//   image_annotation_draw    — THE WRITE (the descriptor's own `annotate_image` effect, riskLevel
//                              "write"). Builds an AnnotationSpec v1 document from the chosen
//                              placements — ONE element per entry in the operation's own
//                              `annotations[]`, never more and never fewer — and calls annotate_image
//                              once. The base image is never modified; a NEW artifact is saved.
//   image_annotation_verify  — terminal, READ ONLY. Calls check_image_text {mode:"expect"} with
//                              EXACTLY the strings the spec drew and reports
//                              `annotationTextVerified` from that receipt — the descriptor's one
//                              completion criterion (annotation_text_verified, evidenceKind
//                              image_text_check), PROJECTED from the receipt and never asserted by
//                              this code because the draw call returned ok.
//
// WARNINGS NEVER BLOCK, HERE OR ANYWHERE. The descriptor says so in its own words and names T5's
// executor specifically ("T4's executor must not invent a gate out of them"): annotate_image's
// renderReport.warnings[] (TEXT_SHRUNK, TEXT_WRAPPED, COLLISION_PUSHED, AVOID_ZONE_OVERLAP,
// CONTRAST_LOW, ...) ride along with a SUCCESSFUL render, and check_image_text is warn-only by
// design — a failing check still returns ok:true at the call's own level with the verdict nested in
// textCheck.ok. Every warning either stage sees is CARRIED VERBATIM onto its envelope and read by
// the report; not one of them turns a completed stage into a refusal.
//
// WHY EVERY ROLE BECOMES A `text` ELEMENT, INCLUDING "badge". AnnotationSpec v1's `text` element
// takes `style: label | title | caption | badge` — the descriptor's own four roles are exactly that
// enum, and it says so. The spec ALSO has a separate `badge` element, but its content is `n: a
// non-negative integer OR a short string label of at most 4 characters`, while this operation's
// `annotations[].text` has no such bound. Mapping a 30-character badge string onto that element
// would mean truncating a caller's text to fit an element it never asked for — so the badge STYLE is
// used and the badge ELEMENT is not. That is a named decision, not an oversight.
import { callProjectTool, CloneRefusal, type CloneDeps } from "./cloneEngine.js";
import type { ImageAnnotationBrief, ImageAnnotationEntry, ImageAnnotationRole } from "./imageAnnotationBriefBuilder.js";

export const IMAGE_ANNOTATION_ARTIFACTS = {
  analyze: "image_annotation.analyze.v1",
  draw: "image_annotation.draw.v1",
  verify: "image_annotation.verify.v1"
} as const;

export type ImageAnnotationGridCell = { id: string; lum: number; busy: number; color: string | null };

export type ImageAnnotationPlacement = {
  /** Stable, deterministic element id — also the id carried onto the AnnotationSpec element. */
  elementId: string;
  text: string;
  role: ImageAnnotationRole;
  /** The 6x6 grid cell this string was placed in, chosen from analyze_image_layout's own numbers. */
  cell: string;
  busy: number;
  lum: number;
  anchor: string;
  align: string;
  /** "#111111" over a light cell, "#ffffff" over a dark one — decided from the cell's OWN lum. */
  textColor: string;
  /** Named when the role's preferred band held no free cell and the global ranking was used
   *  instead. Null when the role got the band it prefers. Never silent. */
  fallback: string | null;
};

export type ImageAnnotationAnalyzeEnvelope = {
  artifact: typeof IMAGE_ANNOTATION_ARTIFACTS.analyze;
  summary: string;
  /** The BASE image's own pixel dimensions, read from hints.image — the AnnotationSpec's canvas.
   *  Never guessed: a layout report that states none is a refusal, below. */
  canvas: { w: number; h: number };
  sourcePublicPath: string | null;
  /** Every cell analyze_image_layout reported, verbatim — the evidence the placement rests on. */
  cells: ImageAnnotationGridCell[];
  safeZones: unknown[];
  placements: ImageAnnotationPlacement[];
  /** The per-style text colours the placements imply, for the spec's `theme.textColors`. */
  textColors: Record<string, string>;
};

// WHICH ROWS EACH ROLE PREFERS. Not an aesthetic opinion dressed as a rule: the grid's rows run 1
// (top) to 6 (bottom), a title reads at the top and a caption reads at the bottom, and label/badge
// are positionally neutral by definition. The preference only ever ORDERS the candidate cells — the
// choice WITHIN the band is still made from the cell's own busy/lum, and an empty band falls back to
// the global ranking with the fallback NAMED on the placement.
const ROLE_ROW_BAND: Record<ImageAnnotationRole, number[] | null> = {
  title: [1, 2],
  caption: [5, 6],
  label: null,
  badge: null
};

const ROLE_ANCHOR: Record<ImageAnnotationRole, string> = { title: "tc", caption: "bc", label: "c", badge: "c" };
const ROLE_ALIGN: Record<ImageAnnotationRole, string> = { title: "center", caption: "center", label: "left", badge: "left" };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter(nonEmptyString) : []);

const cellRow = (cellId: string): number => Number.parseInt(cellId.slice(1), 10);

/** Light text over a dark cell, dark text over a light one — from the cell's OWN mean luminance. */
const contrastingTextColor = (lum: number): string => (lum >= 0.5 ? "#111111" : "#ffffff");

/**
 * THE PLACEMENT DECISION, PURE AND EXPORTED so it can be tested against real grid numbers without a
 * wire call. Ranks every cell by BUSYNESS ASCENDING (quiet first — analyze_image_layout's own
 * guidance, and the one number that says "text can go here"), tie-broken by luminance distance from
 * mid-grey descending (an extreme cell gives text something to contrast against) and finally by cell
 * id, so the same image and the same annotations always produce the same picture.
 */
export function chooseAnnotationPlacements(cells: readonly ImageAnnotationGridCell[], annotations: readonly ImageAnnotationEntry[]): ImageAnnotationPlacement[] {
  const ranked = [...cells].sort((left, right) => {
    if (left.busy !== right.busy) return left.busy - right.busy;
    const leftContrast = Math.abs(left.lum - 0.5);
    const rightContrast = Math.abs(right.lum - 0.5);
    if (leftContrast !== rightContrast) return rightContrast - leftContrast;
    return left.id.localeCompare(right.id);
  });

  const used = new Set<string>();
  const placements: ImageAnnotationPlacement[] = [];
  annotations.forEach((entry, index) => {
    const band = ROLE_ROW_BAND[entry.role];
    const inBand = band ? ranked.find((cell) => !used.has(cell.id) && band.includes(cellRow(cell.id))) : undefined;
    const chosen = inBand ?? ranked.find((cell) => !used.has(cell.id));
    if (!chosen) {
      throw new CloneRefusal(
        "image_annotation_placements_exhausted",
        `This run asks for ${annotations.length} annotations but analyze_image_layout reports only ${cells.length} grid cells, and this operation places at most one string per cell so two strings are never stacked on one spot without being told to be. Split the request, or annotate fewer strings at once.`
      );
    }
    used.add(chosen.id);
    placements.push({
      elementId: `annotation_${index + 1}`,
      text: entry.text,
      role: entry.role,
      cell: chosen.id,
      busy: chosen.busy,
      lum: chosen.lum,
      anchor: ROLE_ANCHOR[entry.role],
      align: ROLE_ALIGN[entry.role],
      textColor: contrastingTextColor(chosen.lum),
      fallback: band && !inBand ? `no free cell in rows ${band.join("/")} (the ${entry.role} band); placed on the global quiet ranking instead` : null
    });
  });
  return placements;
}

/** theme.textColors is PER STYLE, not per element (annotate_image's own shape), so a style drawn on
 *  several cells gets the colour its cells' MEAN luminance implies — stated here rather than left to
 *  whichever placement happened to be last. */
function resolveTextColors(placements: readonly ImageAnnotationPlacement[]): Record<string, string> {
  const byRole = new Map<string, number[]>();
  for (const placement of placements) {
    byRole.set(placement.role, [...(byRole.get(placement.role) ?? []), placement.lum]);
  }
  const colors: Record<string, string> = {};
  for (const role of [...byRole.keys()].sort()) {
    const luminances = byRole.get(role)!;
    colors[role] = contrastingTextColor(luminances.reduce((sum, value) => sum + value, 0) / luminances.length);
  }
  return colors;
}

/** The artifact-naming half of every bridge call: the request the image belongs to plus ONE of the
 *  two spellings the bridge accepts. Built once so all three verbs name the image identically. */
const imageRefArgs = (brief: ImageAnnotationBrief): Record<string, unknown> => ({
  requestId: brief.image.requestId,
  ...(brief.image.sha256 ? { sha256: brief.image.sha256 } : {}),
  ...(brief.image.publicPath ? { publicPath: brief.image.publicPath } : {})
});

/**
 * Stage 1 — READ ONLY. ONE bridge call. `siteId` is the tenant's Platform site object id, resolved
 * by the caller through pdfToolSiteScope.ts, never the tenantId (the bridge refuses that with
 * artifact_site_mismatch).
 */
export async function imageAnnotationAnalyzeStep(
  input: { targetProjectId: string; siteId: string; brief: ImageAnnotationBrief },
  deps: CloneDeps = {}
): Promise<ImageAnnotationAnalyzeEnvelope> {
  const { brief } = input;
  const result = await callProjectTool(input.targetProjectId, "analyze_image_layout", { siteId: input.siteId, ...imageRefArgs(brief) }, deps);

  const hints = isRecord(result.hints) ? result.hints : undefined;
  const image = hints && isRecord(hints.image) ? hints.image : undefined;
  const width = image && typeof image.w === "number" ? image.w : undefined;
  const height = image && typeof image.h === "number" ? image.h : undefined;
  if (!width || !height) {
    // THE CANVAS IS NEVER GUESSED. AnnotationSpec's canvas {w,h} is what every normalized position
    // in the spec is a fraction OF, and the stored image is canvas.w x canvas.h (times the device
    // scale factor) — inventing one would silently letterbox or stretch the annotation layer over
    // the base image on every single run.
    throw new CloneRefusal(
      "image_annotation_canvas_unknown",
      `analyze_image_layout for request "${brief.image.requestId}" on "${brief.tenantId}" reported no hints.image {w,h}, so the base image's own pixel dimensions are unknown. AnnotationSpec's canvas is exactly those dimensions and every position in the spec is a fraction of it; a guessed canvas would stretch the whole annotation layer over the image. Nothing was drawn.`
    );
  }

  const grid = hints && isRecord(hints.grid) ? hints.grid : undefined;
  const cells: ImageAnnotationGridCell[] = (Array.isArray(grid?.cells) ? grid!.cells : [])
    .filter(isRecord)
    .filter((cell) => nonEmptyString(cell.id) && typeof cell.lum === "number" && typeof cell.busy === "number")
    .map((cell) => ({ id: (cell.id as string).trim(), lum: cell.lum as number, busy: cell.busy as number, color: nonEmptyString(cell.color) ? cell.color : null }));
  if (cells.length === 0) {
    // Placing text without the layout read is guessing, which is the one thing this stage exists to
    // stop. A report with no usable cells is a refusal, never a fall back to a favourite cell.
    throw new CloneRefusal(
      "image_annotation_layout_unreadable",
      `analyze_image_layout for request "${brief.image.requestId}" on "${brief.tenantId}" reported no usable grid cells (each needs an id, a lum and a busy). This operation places text from those numbers and from nothing else; with none of them there is no placement to make, and a default cell would be exactly the guess the read exists to prevent.`
    );
  }

  const placements = chooseAnnotationPlacements(cells, brief.annotations);
  const quietest = placements.reduce((best, entry) => (entry.busy < best.busy ? entry : best), placements[0]);
  return {
    artifact: IMAGE_ANNOTATION_ARTIFACTS.analyze,
    summary: `Read the ${cells.length}-cell layout of ${width}x${height} image in request "${brief.image.requestId}" and placed ${placements.length} annotation(s); quietest placement is ${quietest.role} in cell ${quietest.cell} (busy ${quietest.busy.toFixed(4)}, lum ${quietest.lum.toFixed(3)}). Nothing was written.`,
    canvas: { w: width, h: height },
    sourcePublicPath: nonEmptyString(result.source_public_path) ? result.source_public_path : nonEmptyString(result.public_path) ? result.public_path : null,
    cells,
    safeZones: Array.isArray(hints?.safeZones) ? (hints!.safeZones as unknown[]) : [],
    placements,
    textColors: resolveTextColors(placements)
  };
}

export type AnnotationSpecElement = { id: string; type: "text"; content: string; at: string; anchor: string; align: string; style: ImageAnnotationRole };
export type AnnotationSpecDocument = {
  version: 1;
  canvas: { w: number; h: number };
  theme: { textColors: Record<string, string> };
  elements: AnnotationSpecElement[];
  avoid: never[];
};

/**
 * PURE. The AnnotationSpec v1 document, built from the analyze stage's own placements — ONE element
 * per placement, and the analyze stage already built one placement per entry in `annotations[]`.
 *
 * `base` is DELIBERATELY OMITTED: the Platform bridge fills it in from the artifact the call itself
 * names ("Omit `base` and Platform fills it in from the artifact you named"), and a hand-authored
 * base that disagreed would come back as ANNOTATE_BASE_MISMATCH. One name for the artifact, supplied
 * once, is one fewer place for the two to drift.
 */
export function buildAnnotationSpec(analyze: ImageAnnotationAnalyzeEnvelope): AnnotationSpecDocument {
  return {
    version: 1,
    canvas: { w: analyze.canvas.w, h: analyze.canvas.h },
    theme: { textColors: { ...analyze.textColors } },
    elements: analyze.placements.map((placement) => ({
      id: placement.elementId,
      type: "text",
      content: placement.text,
      at: placement.cell,
      anchor: placement.anchor,
      align: placement.align,
      style: placement.role
    })),
    avoid: []
  };
}

export type ImageAnnotationDrawEnvelope = {
  artifact: typeof IMAGE_ANNOTATION_ARTIFACTS.draw;
  summary: string;
  /** The NEW image artifact. `publicPath` is NON-NULL by construction — a draw that returned no
   *  addressable path is a refusal above, never an envelope, because the completion evidence is read
   *  back out of that path. */
  annotated: { publicPath: string; sha256: string | null; requestId: string; widthPx: number | null; heightPx: number | null; format: string | null; assetId: string | null };
  sourcePublicPath: string | null;
  /** The strings this spec actually drew — the exact list the verify stage expects back. */
  drawnStrings: string[];
  spec: AnnotationSpecDocument;
  /** renderReport VERBATIM. Its warnings are information; none of them failed this stage. */
  renderReport: Record<string, unknown> | null;
  warnings: string[];
  slot: string | null;
};

/** Stage 2 — THE WRITE. ONE bridge call, one new artifact, base image untouched. */
export async function imageAnnotationDrawStep(
  input: { targetProjectId: string; siteId: string; brief: ImageAnnotationBrief; analyze: ImageAnnotationAnalyzeEnvelope },
  deps: CloneDeps = {}
): Promise<ImageAnnotationDrawEnvelope> {
  const { brief, analyze } = input;
  const spec = buildAnnotationSpec(analyze);
  const result = await callProjectTool(
    input.targetProjectId,
    "annotate_image",
    {
      siteId: input.siteId,
      ...imageRefArgs(brief),
      spec,
      ...(brief.slot ? { slot: brief.slot } : {}),
      ...(typeof brief.deviceScaleFactor === "number" ? { deviceScaleFactor: brief.deviceScaleFactor } : {})
    },
    deps
  );

  const artifact = isRecord(result.artifact) ? result.artifact : undefined;
  const renderReport = isRecord(result.renderReport) ? (result.renderReport as Record<string, unknown>) : null;
  const warnings = stringList(renderReport?.warnings);
  const publicPath = nonEmptyString(result.public_path) ? result.public_path : null;
  if (!publicPath) {
    // The annotated image is what the completion evidence is read out of. A write that names no
    // addressable artifact leaves nothing to verify, and reporting the criterion met anyway would be
    // the exact "executor's say-so" the descriptor forbids.
    throw new CloneRefusal(
      "image_annotation_artifact_unaddressable",
      `annotate_image returned no public_path for the annotated artifact on "${brief.tenantId}", so the new image is not addressable and check_image_text has nothing to read back. The completion criterion (annotation_text_verified) is evidence from that read, never an assumption that the render worked.`
    );
  }

  const drawnStrings = spec.elements.map((element) => element.content);
  return {
    artifact: IMAGE_ANNOTATION_ARTIFACTS.draw,
    summary: `Drew ${spec.elements.length} annotation element(s) over request "${brief.image.requestId}"'s image and saved a NEW artifact at ${publicPath}${warnings.length ? `; renderReport carried ${warnings.length} warning(s): ${warnings.join(", ")} (informational, never a blocker)` : "; renderReport carried no warnings"}.`,
    annotated: {
      publicPath,
      sha256: artifact && nonEmptyString(artifact.sha256) ? (artifact.sha256 as string).toLowerCase() : null,
      requestId: brief.image.requestId,
      widthPx: artifact && typeof artifact.widthPx === "number" ? artifact.widthPx : null,
      heightPx: artifact && typeof artifact.heightPx === "number" ? artifact.heightPx : null,
      format: artifact && nonEmptyString(artifact.format) ? artifact.format : null,
      assetId: artifact && nonEmptyString(artifact.assetId) ? artifact.assetId : null
    },
    sourcePublicPath: nonEmptyString(result.source_public_path) ? result.source_public_path : analyze.sourcePublicPath,
    drawnStrings,
    spec,
    renderReport,
    warnings,
    slot: brief.slot ?? null
  };
}

export type ImageAnnotationVerifyEnvelope = {
  artifact: typeof IMAGE_ANNOTATION_ARTIFACTS.verify;
  summary: string;
  /** THE DESCRIPTOR'S ONE COMPLETION CRITERION (annotation_text_verified), projected from
   *  check_image_text {mode:"expect"}'s own receipt and from nothing else. */
  annotationTextVerified: boolean;
  /** evidenceKind image_text_check — named so a reader can see WHICH receipt the flag came from. */
  evidence: { kind: "image_text_check"; source: string; textCheckOk: boolean | null };
  annotatedPublicPath: string;
  expected: string[];
  matched: string[];
  missing: string[];
  detected: string[];
  /** check_image_text's own warnings AND the draw stage's renderReport warnings, carried forward.
   *  Informational: not one of them decides annotationTextVerified. */
  warnings: string[];
  textCheck: Record<string, unknown> | null;
  completed: boolean;
};

/**
 * Stage 3, terminal — READ ONLY. ONE bridge call: check_image_text {mode:"expect"} over the NEW
 * artifact, with exactly the strings the spec drew.
 *
 * `annotationTextVerified` is true only when the receipt says every expected string was read back.
 * A receipt with no verdict, a receipt naming missing strings, and a call that reported ok:false all
 * yield false with the reason stated — never an optimistic default, exactly as
 * documentRenderEngine.ts's pdfContentVerified reads its own gate.
 */
export async function imageAnnotationVerifyStep(
  input: { targetProjectId: string; siteId: string; brief: ImageAnnotationBrief; draw: ImageAnnotationDrawEnvelope },
  deps: CloneDeps = {}
): Promise<ImageAnnotationVerifyEnvelope> {
  const { brief, draw } = input;
  const expected = [...draw.drawnStrings];
  const result = await callProjectTool(
    input.targetProjectId,
    "check_image_text",
    { siteId: input.siteId, requestId: draw.annotated.requestId, publicPath: draw.annotated.publicPath, mode: "expect", expect: expected },
    deps
  );

  const textCheck = isRecord(result.textCheck) ? (result.textCheck as Record<string, unknown>) : null;
  const textCheckOk = textCheck && typeof textCheck.ok === "boolean" ? (textCheck.ok as boolean) : null;
  const matched = stringList(textCheck?.matched);
  const detected = stringList(textCheck?.detected);
  // `missing` is the receipt's own list when it states one. When it does not, it is derived by
  // SUBTRACTION from `matched` — never assumed empty, because "the receipt said nothing about this
  // string" is not "the string was read back".
  const missing = Array.isArray(textCheck?.missing)
    ? stringList(textCheck!.missing)
    : expected.filter((value) => !matched.some((entry) => entry.toLowerCase() === value.toLowerCase()));
  const warnings = [...draw.warnings, ...stringList(textCheck?.warnings)];

  const annotationTextVerified = textCheckOk === true && missing.length === 0;
  const source = !textCheck
    ? `no verdict — check_image_text returned no textCheck receipt for ${draw.annotated.publicPath}, so nothing is known about what the rendered pixels actually say`
    : textCheckOk === null
      ? `check_image_text's receipt for ${draw.annotated.publicPath} carried no ok verdict; an absent verdict is not a pass`
      : `check_image_text {mode:"expect"} over the annotated artifact ${draw.annotated.publicPath}`;

  return {
    artifact: IMAGE_ANNOTATION_ARTIFACTS.verify,
    summary: annotationTextVerified
      ? `All ${expected.length} drawn string(s) were read back out of ${draw.annotated.publicPath} by OCR; annotation_text_verified is met.${warnings.length ? ` ${warnings.length} informational warning(s) rode along: ${warnings.join(", ")}.` : ""}`
      : `annotation_text_verified is NOT met for ${draw.annotated.publicPath}: ${missing.length ? `${missing.length} of ${expected.length} drawn string(s) were not read back (${missing.join(", ")})` : source}. The annotated image EXISTS either way — this is the completion criterion, not the render.`,
    annotationTextVerified,
    evidence: { kind: "image_text_check", source, textCheckOk },
    annotatedPublicPath: draw.annotated.publicPath,
    expected,
    matched,
    missing,
    detected,
    warnings,
    textCheck,
    completed: annotationTextVerified
  };
}
