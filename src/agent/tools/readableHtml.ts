/**
 * Readability-style main-text extraction for web.fetch (B3).
 *
 * WHY THIS FILE EXISTS
 *
 * web.fetch returned raw response text, capped at 250 000 bytes. On a modern content page that is
 * almost entirely script tags, inlined JSON state, nav chrome and cookie banners: in proof run
 * `run_1789303857536_obd2fd` the research node spent its whole `toolCallLimit: 5` on two pages (VCA,
 * Cornell) whose useful prose never appeared inside the bytes it was given, kept one usable source
 * (AVMA), and the draft was then blocked for want of evidence. The tool was not failing — it was
 * answering with the wrong 250 000 characters.
 *
 * NO DOM, NO DEPENDENCY. Mozilla's Readability needs jsdom, which is a heavy dependency to add to a
 * Cloud Run image for one tool, and the repo's testing rule is logic-first tests on pure modules
 * rather than a DOM. This is a single-pass scanner over the markup instead: it is not a parser and
 * does not need to be, because every decision here is a coarse one — drop these element subtrees,
 * prefer this container if it exists, turn what is left into newline-separated text. A malformed
 * page degrades to "slightly worse text", never to a throw: extraction is wrapped by the caller and
 * falls back to the raw body.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No scoring heuristic (Readability's link-density/comma
 * counting), no boilerplate classifier, no markdown reconstruction. Those buy quality on adversarial
 * pages and cost a class of silent wrongness — dropping the one paragraph that carried the claim —
 * that a research node cannot detect. Dropping known-chrome elements and preferring <article>/<main>
 * is the part that is safe to be confident about.
 */

export type ReadablePage = {
  /** Extracted main text, newline-separated by block, whitespace-collapsed. Never truncated here. */
  text: string;
  title?: string;
  canonicalUrl?: string;
  /** ISO-8601 as the page declared it; not normalized or re-parsed. */
  publishedAt?: string;
  /** Which container the text came from, for the record: the page's own <article>/<main>, or <body>. */
  source: "article" | "main" | "body";
};

/** Element subtrees that never carry the page's claim. Removed whole, opening tag to closing tag. */
const DROPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "form", "nav", "header", "footer", "aside", "figure", "select", "button", "dialog"];
/** Tags whose boundaries are a line break in the output. */
const BLOCK_ELEMENTS = ["p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br", "hr", "blockquote", "pre", "dd", "dt", "td", "th"];

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•", deg: "°", trade: "™", copy: "©", reg: "®" };

const decodeEntities = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });

// Comments first: a commented-out <script> would otherwise leave a stray closing tag behind.
const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, " ");

/**
 * Remove each DROPPED_ELEMENTS subtree. Nesting is counted per element name so a <div> inside a
 * dropped <nav> does not close it early, and an UNCLOSED dropped element (common in hand-written
 * markup) truncates at the next occurrence of that same tag rather than eating the rest of the page.
 */
const dropElements = (html: string): string => {
  let out = html;
  for (const name of DROPPED_ELEMENTS) {
    // Self-closing / void spellings first, then paired subtrees, non-greedy so one unclosed tag
    // cannot swallow every later section.
    out = out.replace(new RegExp(`<${name}\\b[^>]*/>`, "gi"), " ");
    out = out.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}\\s*>`, "gi"), " ");
    // Anything left is an unclosed opener: drop the tag itself, keep the text after it.
    out = out.replace(new RegExp(`<${name}\\b[^>]*>`, "gi"), " ");
  }
  return out;
};

const attr = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value ? decodeEntities(value).trim() || undefined : undefined;
};

/** First <meta> whose name/property matches one of `keys`, in the order the keys are given. */
const metaContent = (html: string, keys: string[]): string | undefined => {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const key of keys) {
    for (const tag of tags) {
      const which = attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop");
      if (which?.toLowerCase() === key) { const content = attr(tag, "content"); if (content) return content; }
    }
  }
  return undefined;
};

const firstTagText = (html: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, "i").exec(html);
  if (!match) return undefined;
  const text = collapse(decodeEntities(match[1].replace(/<[^>]*>/g, " ")));
  return text || undefined;
};

const collapse = (text: string) => text.replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** The publication date, from the places pages actually declare it, most explicit first. */
const extractPublishedAt = (html: string): string | undefined => {
  const meta = metaContent(html, ["article:published_time", "article:published", "datepublished", "publishdate", "pubdate", "date", "dc.date.issued", "citation_publication_date"]);
  if (meta) return meta;
  // JSON-LD is inside a <script> — read it from the ORIGINAL html, before dropElements runs.
  for (const block of html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi) ?? []) {
    const published = /"datePublished"\s*:\s*"([^"]+)"/.exec(block)?.[1];
    if (published) return published;
  }
  const timeTag = /<time\b[^>]*\bdatetime\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html);
  return timeTag?.[2] ?? timeTag?.[3] ?? undefined;
};

/**
 * The page's main container: its own <article> or <main> when it declares one (the two elements that
 * exist to say "the content is here"), otherwise <body>, otherwise the whole document.
 */
const mainContainer = (html: string): { html: string; source: ReadablePage["source"] } => {
  for (const name of ["article", "main"] as const) {
    const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, "i").exec(html);
    // A one-line <article> teaser in a listing page is not the content; require some substance
    // before preferring it over the body.
    if (match && match[1].replace(/<[^>]*>/g, "").trim().length >= 200) return { html: match[1], source: name };
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return body ? { html: body[1], source: "body" } : { html, source: "body" };
};

const toText = (html: string): string => {
  let out = html;
  for (const name of BLOCK_ELEMENTS) out = out.replace(new RegExp(`</?${name}\\b[^>]*>`, "gi"), "\n");
  out = out.replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(out));
};

/**
 * Extract the readable content of an HTML document. Pure and total: any input returns a
 * ReadablePage, and `text` is empty only when the document really carries no prose.
 */
export function extractReadable(html: string): ReadablePage {
  const withoutComments = stripComments(html);
  // Metadata is read from the full document (JSON-LD lives in a <script>, canonical in <head>);
  // only the body text goes through dropElements.
  const title = metaContent(withoutComments, ["og:title", "twitter:title"]) ?? firstTagText(withoutComments, "title") ?? firstTagText(withoutComments, "h1");
  const canonicalTag = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i.exec(withoutComments)?.[0];
  const canonicalUrl = (canonicalTag ? attr(canonicalTag, "href") : undefined) ?? metaContent(withoutComments, ["og:url"]);
  const publishedAt = extractPublishedAt(withoutComments);
  const container = mainContainer(withoutComments);
  return { text: toText(dropElements(container.html)), source: container.source, ...(title ? { title } : {}), ...(canonicalUrl ? { canonicalUrl } : {}), ...(publishedAt ? { publishedAt } : {}) };
}

/** Default output ceiling for web.fetch, in characters. */
export const DEFAULT_FETCH_MAX_CHARS = 8_000;
// Deliberately UNDER DEFAULT_TOOL_RESULT_MAX_CHARS (32 000, OpenAINodeRunner.ts): a model that raises
// maxChars must not have the extra text silently removed again by a different bound carrying a
// different flag. The margin leaves room for the envelope (url, title, notes) around the text.
export const MAX_FETCH_MAX_CHARS = 24_000;

const looksLikeHtml = (contentType: string, body: string) => /html|xhtml/i.test(contentType) || /<\s*(html|body|article|main|div|p)\b/i.test(body.slice(0, 4_000));

export type ReadableFetchBody = {
  text: string;
  /** "readable" when the main-text pass ran and produced prose; "raw" for JSON/plain text or an HTML page it could not read. */
  extraction: "readable" | "raw";
  /** Characters in the fetched body BEFORE extraction and capping — the size the model was spared. */
  rawChars: number;
  /** True when `text` was cut at maxChars. */
  truncated: boolean;
  title?: string;
  canonicalUrl?: string;
  publishedAt?: string;
  contentSource?: ReadablePage["source"];
};

/**
 * Turn a fetched body into what the model should read. HTML goes through extractReadable; anything
 * else (JSON, plain text, XML) is passed through — those formats are already the payload, and
 * "extracting" them would corrupt structured data the caller asked for on purpose. An HTML page
 * whose extraction comes back empty (a JS-rendered shell) falls back to the raw body rather than
 * handing back nothing: an empty result reads to a model like "the page said nothing", which is a
 * different and much worse claim than "this page is mostly script".
 */
export function readableFetchBody(body: string, contentType: string, maxChars: number = DEFAULT_FETCH_MAX_CHARS): ReadableFetchBody {
  const cap = Math.max(1, Math.min(Math.floor(maxChars) || DEFAULT_FETCH_MAX_CHARS, MAX_FETCH_MAX_CHARS));
  const rawChars = body.length;
  const cut = (text: string) => ({ text: text.slice(0, cap), truncated: text.length > cap });
  if (!looksLikeHtml(contentType, body)) return { ...cut(body), extraction: "raw", rawChars };
  let page: ReadablePage | undefined;
  try { page = extractReadable(body); } catch { page = undefined; }
  if (!page || page.text.length < 200) return { ...cut(body), extraction: "raw", rawChars, ...(page?.title ? { title: page.title } : {}), ...(page?.canonicalUrl ? { canonicalUrl: page.canonicalUrl } : {}), ...(page?.publishedAt ? { publishedAt: page.publishedAt } : {}) };
  return {
    ...cut(page.text),
    extraction: "readable",
    rawChars,
    contentSource: page.source,
    ...(page.title ? { title: page.title } : {}),
    ...(page.canonicalUrl ? { canonicalUrl: page.canonicalUrl } : {}),
    ...(page.publishedAt ? { publishedAt: page.publishedAt } : {})
  };
}
