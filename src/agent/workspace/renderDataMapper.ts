// C2 (BRIEF §3.10, R7) — the deterministic renderData mapper.
//
// WHY IT EXISTS. R7 settles that a PDF slot costs ZERO extra model tokens: the generic chromium
// template `article_brochure_v1` carries a `renderDataSchema` that deliberately MIRRORS article
// structure, so the material the run has already written (draft_writer's prose) plus the images the
// run has already generated is, by construction, everything the template needs. If a model had to
// re-type the whole article into `renderData`, a PDF slot would cost as much as the article did and
// would drift from it on every retry. This module is the "type it again, for free, and never
// differently" half of that ruling.
//
// WHAT IT IS NOT. It is not a validator and not a template engine. It does not fetch the template, it
// does not ajv-check its own output (pdf-tool owns the single validator — see D1's render-data-schema
// .ts; forking it here would be the three-copies mistake), and it never invents prose. Every string it
// emits came out of draft_writer verbatim, truncated at most. A field it cannot derive is REPORTED
// (`unfilledRequired`), never filled with placeholder text — a plausible-looking PDF built from
// invented copy is strictly worse than a slot that says what it is missing.
//
// SCHEMA COUPLING, DELIBERATELY LOOSE. The mapper targets R7's article shape and then emits only the
// keys the template's own `renderDataSchema` declares (when it declares any). So a site whose article
// template is a subset of `article_brochure_v1` gets a subset, and a site whose template asks for a
// field this mapper knows nothing about gets that field named in `unfilledRequired` rather than a
// silent gap. The length limits below mirror `article_brochure_v1`'s declared maxima; they are
// belt-and-braces so a long draft degrades to a truncated PDF instead of a 400.
//
// THE COVER IMAGE (BRIEF §3.10). `coverImage` is an ASSET ID, not a URL and not a blob key: pdf-tool
// binds `assets.images[].assetId` to `https://render.assets.invalid/<assetId>` for chromium (see
// pdf-tool's job-assets.ts). The bytes never travel — the entry names `{assetId, blobKey}` and
// pdf-tool resolves the key from the tenant's own store. That is why artifactMaterialization.ts runs
// every IMAGE slot to a terminal state before it dispatches any PDF slot: the cover cannot be named
// before the image it names exists.

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Limits mirroring `article_brochure_v1`'s renderDataSchema (pdf-tool `templates/article_brochure_v1.json`). */
const LIMITS = {
  title: 200,
  deck: 400,
  kicker: 80,
  author: 120,
  heading: 150,
  paragraph: 2000,
  quote: 500,
  attribution: 150,
  sourceLabel: 200,
  sourceUrl: 500,
  sourceNote: 300,
  sections: 24,
  paragraphs: 12,
  pullQuotes: 12,
  sources: 40
} as const;

/** The template facts this mapper needs — the shape contract_intelligence carries per BRIEF §3.7. */
export type RenderDataTemplate = {
  templateId: string;
  kind?: string;
  label?: string;
  renderDataSchema?: unknown;
  isDefault?: boolean;
};

/** One image slot this run has already materialized, in the form §3.10's `assets.images[]` accepts. */
export type MaterializedImageSlot = {
  slotId: string;
  purpose?: string;
  placement?: string;
  assetId: string;
  blobKey: string;
};

export type RenderDataMapping = {
  renderData: Record<string, unknown>;
  /** Present only when a cover image was bound; the exact `assets` object the bridge call carries. */
  assets?: { images: Array<{ assetId: string; blobKey: string }> };
  /** Schema-declared (or article-shape) keys this mapper actually filled, for the run's notes. */
  filled: string[];
  /** Keys the template's schema REQUIRES that this mapper could not derive. Never guessed. */
  unfilledRequired: string[];
  /** Which image slot became `coverImage`, when one did. */
  coverSlotId?: string;
};

/** The article kind this mapper is defined for (R7). Anything else is left to the planner. */
export const ARTICLE_TEMPLATE_KIND = "article";

export const isArticleTemplate = (template: Pick<RenderDataTemplate, "kind">): boolean =>
  typeof template.kind === "string" && template.kind.trim().toLowerCase() === ARTICLE_TEMPLATE_KIND;

const clamp = (value: string, max: number): string => {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};

/** First non-empty string among a record's candidate keys, in the caller's stated preference order. */
const firstString = (source: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) if (nonEmpty(source[key])) return source[key].trim();
  return undefined;
};

const firstArray = (source: Record<string, unknown>, keys: string[]): unknown[] | undefined => {
  for (const key of keys) if (Array.isArray(source[key])) return source[key] as unknown[];
  return undefined;
};

/** Prose delivered as one blob becomes paragraphs on blank lines — the shape draft_writer's own
 * "clean headings and paragraphs" instruction produces. Never sentence-splits: a paragraph break the
 * writer did not make is not ours to invent. */
const paragraphsOf = (value: unknown): string[] => {
  const raw: unknown[] = Array.isArray(value) ? value : nonEmpty(value) ? value.split(/\n\s*\n/) : [];
  return raw
    .map((entry) => (nonEmpty(entry) ? clamp(entry, LIMITS.paragraph) : isRecord(entry) ? clamp(String(firstString(entry, ["text", "body", "content", "paragraph"]) ?? ""), LIMITS.paragraph) : ""))
    .filter(nonEmpty)
    .slice(0, LIMITS.paragraphs);
};

type Section = { heading: string; paragraphs: string[] };

const sectionsOf = (draft: Record<string, unknown>): Section[] => {
  const raw = firstArray(draft, ["sections", "draftSections", "draft_sections", "body", "articleSections"]) ?? [];
  const sections: Section[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const heading = firstString(entry, ["heading", "title", "name", "sectionTitle", "h2"]);
    const paragraphs = paragraphsOf(entry.paragraphs ?? entry.body ?? entry.content ?? entry.text ?? entry.prose);
    // Both halves are required by the article shape. A section with a heading and no prose is a
    // planning gap, not a page — it is dropped and shows up as a shorter document, never as a
    // heading followed by nothing.
    if (!heading || paragraphs.length === 0) continue;
    sections.push({ heading: clamp(heading, LIMITS.heading), paragraphs });
    if (sections.length >= LIMITS.sections) break;
  }
  return sections;
};

const pullQuotesOf = (draft: Record<string, unknown>): Array<{ quote: string; attribution?: string }> => {
  const raw = firstArray(draft, ["pullQuotes", "pull_quotes", "quotes"]) ?? [];
  const quotes: Array<{ quote: string; attribution?: string }> = [];
  for (const entry of raw) {
    const quote = nonEmpty(entry) ? entry : isRecord(entry) ? firstString(entry, ["quote", "text", "pullQuote"]) : undefined;
    if (!quote) continue;
    const attribution = isRecord(entry) ? firstString(entry, ["attribution", "attributedTo", "author", "source"]) : undefined;
    quotes.push({ quote: clamp(quote, LIMITS.quote), ...(attribution ? { attribution: clamp(attribution, LIMITS.attribution) } : {}) });
    if (quotes.length >= LIMITS.pullQuotes) break;
  }
  return quotes;
};

const sourcesOf = (draft: Record<string, unknown>): Array<{ label: string; url?: string; note?: string }> => {
  const raw = firstArray(draft, ["sources", "sourceNotes", "source_notes", "citations", "references"]) ?? [];
  const sources: Array<{ label: string; url?: string; note?: string }> = [];
  for (const entry of raw) {
    const label = nonEmpty(entry) ? entry : isRecord(entry) ? firstString(entry, ["label", "title", "name", "source", "claim"]) : undefined;
    if (!label) continue;
    const url = isRecord(entry) ? firstString(entry, ["url", "href", "link"]) : undefined;
    const note = isRecord(entry) ? firstString(entry, ["note", "detail", "evidence", "comment"]) : undefined;
    sources.push({
      label: clamp(label, LIMITS.sourceLabel),
      ...(url ? { url: clamp(url, LIMITS.sourceUrl) } : {}),
      ...(note ? { note: clamp(note, LIMITS.sourceNote) } : {})
    });
    if (sources.length >= LIMITS.sources) break;
  }
  return sources;
};

// A header/hero/cover image, named by the words a brief actually uses for one. `placement` is the
// brief's own word for where a slot goes, so it is read first; `slotId`/`purpose` are the fallbacks.
// With no match at all the FIRST image slot is the cover — an article's first image is its lead image
// by convention, and naming one beats shipping a cover-less brochure.
// NOT \b: slot ids are snake/kebab cased and `_` is a word character, so \bcover\b never matches
// `cover_art` — the exact naming a brief is most likely to use.
const HEADER_PATTERN = /(^|[^a-z0-9])(hero|header|cover|lead|banner|top|featured)([^a-z0-9]|$)/i;

export const selectHeaderImage = (images: MaterializedImageSlot[]): MaterializedImageSlot | undefined => {
  if (images.length === 0) return undefined;
  const named = images.find((image) => [image.placement, image.slotId, image.purpose].some((field) => nonEmpty(field) && HEADER_PATTERN.test(field)));
  return named ?? images[0];
};

/** The top-level property names a renderDataSchema declares, and which of them it requires. An
 * unreadable/absent schema yields `undefined` for both, which means "emit the whole article shape". */
const schemaShape = (schema: unknown): { declared?: Set<string>; required: string[] } => {
  if (!isRecord(schema)) return { required: [] };
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : undefined;
  const required = Array.isArray(schema.required) ? schema.required.filter(nonEmpty) : [];
  return { ...(properties && properties.length ? { declared: new Set(properties) } : {}), required };
};

/**
 * Build the render data for a `kind:'article'` template from what the run already produced.
 *
 * Returns `undefined` for a template this mapper is not defined for (a non-article kind), which is
 * the caller's signal to leave the slot's own renderData exactly as the planner wrote it.
 */
export function mapArticleRenderData(params: {
  template: RenderDataTemplate;
  /** draft_writer's `draft.v1` stage output, whatever shape it took. */
  draft: unknown;
  /** Image slots this run has already materialized, in spec order. */
  images?: MaterializedImageSlot[];
}): RenderDataMapping | undefined {
  if (!isArticleTemplate(params.template)) return undefined;

  const draft = isRecord(params.draft) ? params.draft : {};
  const { declared, required } = schemaShape(params.template.renderDataSchema);
  const wants = (key: string): boolean => !declared || declared.has(key);

  const candidates: Record<string, unknown> = {};
  const title = firstString(draft, ["title", "proposedTitle", "proposed_title", "titleProposal", "headline"]);
  if (title) candidates.title = clamp(title, LIMITS.title);
  const deck = firstString(draft, ["deck", "description", "metaDescription", "meta_description", "subtitle", "standfirst", "summary"]);
  if (deck) candidates.deck = clamp(deck, LIMITS.deck);
  const kicker = firstString(draft, ["kicker", "eyebrow", "overline"]);
  if (kicker) candidates.kicker = clamp(kicker, LIMITS.kicker);
  const author = firstString(draft, ["author", "byline", "writtenBy"]);
  if (author) candidates.author = clamp(author, LIMITS.author);

  const sections = sectionsOf(draft);
  if (sections.length) candidates.sections = sections;
  // pullQuotes/sources are REQUIRED-but-possibly-empty in article_brochure_v1 (`maxItems` only, no
  // `minItems`), so an empty array is the honest answer for a draft that carries none — unlike
  // `sections`, whose schema demands at least one and which is therefore left absent (and reported)
  // rather than emitted empty.
  const pullQuotes = pullQuotesOf(draft);
  const sources = sourcesOf(draft);
  candidates.pullQuotes = pullQuotes;
  candidates.sources = sources;

  const cover = selectHeaderImage(params.images ?? []);
  if (cover) candidates.coverImage = cover.assetId;

  const renderData: Record<string, unknown> = {};
  const filled: string[] = [];
  for (const [key, value] of Object.entries(candidates)) {
    if (!wants(key)) continue;
    renderData[key] = value;
    filled.push(key);
  }

  const unfilledRequired = required.filter((key) => renderData[key] === undefined);

  return {
    renderData,
    ...(cover && wants("coverImage") ? { assets: { images: [{ assetId: cover.assetId, blobKey: cover.blobKey }] }, coverSlotId: cover.slotId } : {}),
    filled,
    unfilledRequired
  };
}
