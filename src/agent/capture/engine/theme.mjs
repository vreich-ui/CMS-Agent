import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this CLI directly runnable; theme.test.ts asserts these emitted values against the TS registry.
const THEME_COLOR_KEYS = [
  'primary',
  'secondary',
  'accent',
  'gold',
  'text-heading',
  'text-default',
  'text-muted',
  'bg-page',
  'bg-surface',
  'bg-page-dark',
];
const FALLBACK_COLORS = {
  primary: 'rgb(46 111 149)',
  secondary: 'rgb(37 90 120)',
  accent: 'rgb(94 140 138)',
  gold: 'rgb(194 168 120)',
  'text-heading': 'rgb(22 26 29)',
  'text-default': 'rgb(36 41 46)',
  'text-muted': 'rgb(58 65 73 / 76%)',
  'bg-page': 'rgb(252 251 248)',
  'bg-surface': 'rgb(247 245 240)',
  'bg-page-dark': 'rgb(3 6 32)',
};
const FALLBACK_FONTS = {
  sans: "'Inter Variable'",
  serif: "'Source Serif 4', Georgia, serif",
  heading: "'Playfair Display', 'Times New Roman', serif",
};

// C3 (BRIEF §3.1, derivedFrom.method 'clone') — IMAGERY OBSERVATIONS.
//
// The line this extractor used to emit — "Imagery style is intentionally not written to brandImagery;
// review separately" — was written when there was nowhere for an imagery observation to GO. There is
// now: `visual_standard` (R1), whose `derivedFrom.method` includes 'clone' precisely for this. So the
// observations are collected instead of dropped, and cloneEngine.ts files them as a DRAFT standard
// that a human reads before anything is applied.
//
// WHAT IS OBSERVED, AND WHAT IS DELIBERATELY NOT. Only structural facts already in the snapshot: how
// many distinct image assets the source uses, on how many pages, whether imagery is used as a CSS
// background (full-bleed) or as an inline asset, the quantized aspect ratios of the blocks that carry
// images, and the file extensions of those assets. Nothing here interprets captured content: no alt
// text, no caption, no page copy is read (capture rights govern extracted copy, and an alt string is
// extracted copy), and nothing infers a mood, a subject or a brand's intent from a picture it has not
// looked at. A snapshot cannot tell you what a site's images are OF, and this does not pretend to.
const IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp|avif|gif|svg)(?:[?#].*)?$/i;
const VECTOR_EXTENSIONS = new Set(['svg']);
// The same quantization discipline every other axis in this file uses: snap to a small named set
// rather than emitting a measured ratio nothing can act on.
const ASPECT_RATIO_CHOICES = [
  [16 / 9, '16:9'],
  [3 / 2, '3:2'],
  [4 / 3, '4:3'],
  [1, '1:1'],
  [4 / 5, '4:5'],
  [9 / 16, '9:16'],
];

const assetExtension = (url) => {
  const match = IMAGE_EXTENSION_RE.exec(String(url ?? ''));
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : null;
};

/**
 * Bounded imagery observations for one snapshot. Never throws, never interprets content, and returns
 * `observed: false` for a snapshot that carries no image evidence at all — which is a fact about the
 * source, not a failure, and is what stops a text-only capture minting an imagery standard.
 */
export function observeImagery(snapshot) {
  const pages = Array.isArray(snapshot?.pages) ? snapshot.pages : [];
  const assets = new Map();
  const ratios = new Map();
  let backgroundImageBlocks = 0;
  let pagesWithImages = 0;
  for (const page of pages) {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
    let pageHasImage = false;
    for (const block of blocks) {
      const urls = Array.isArray(block?.assetUrls) ? block.assetUrls : [];
      const imageUrls = urls.filter((url) => assetExtension(url));
      for (const url of imageUrls) assets.set(String(url), assetExtension(url));
      const styles = Object.values(block?.computedStyles ?? {});
      const hasBackgroundImage = styles.some((style) => typeof style?.backgroundImage === 'string' && style.backgroundImage.includes('url('));
      if (hasBackgroundImage) backgroundImageBlocks += 1;
      if (!imageUrls.length && !hasBackgroundImage) continue;
      pageHasImage = true;
      const box = block?.boundingBoxes?.desktop ?? block?.boundingBoxes?.mobile;
      const width = Number(box?.width);
      const height = Number(box?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
      const ratio = nearest(width / height, ASPECT_RATIO_CHOICES, [1, '1:1']);
      ratios.set(ratio, (ratios.get(ratio) ?? 0) + 1);
    }
    if (pageHasImage) pagesWithImages += 1;
  }
  const extensions = [...new Set([...assets.values()])].sort();
  const vectorOnly = extensions.length > 0 && extensions.every((extension) => VECTOR_EXTENSIONS.has(extension));
  return {
    // `observed` is the ONE question cloneEngine asks before it files anything: an imagery standard
    // derived from a source that showed no imagery would be a standard derived from nothing.
    observed: assets.size > 0 || backgroundImageBlocks > 0,
    imageCount: assets.size,
    pagesWithImages,
    backgroundImageBlocks,
    extensions,
    // Most common first, at most four — the shape a draft's aspectRatios can be keyed from.
    aspectRatios: [...ratios.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ratio]) => ratio),
    // The ONE inference, and it is a quantization of file types rather than a judgment about pictures:
    // a source whose every image asset is an SVG really is a flat-vector publication. Anything else is
    // left as null — the medium is a decision for the writer or a human, not for an extension list.
    medium: vectorOnly ? 'flat_vector' : null,
  };
}

const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);
const cssColor = (value) =>
  value?.replace(/rgba?\(([^)]+)\)/, (_match, channels) => `rgb(${channels.replace(/,/g, ' ')})`) ?? null;
const nearest = (value, choices, fallback) =>
  choices.reduce(
    (best, choice) => (Math.abs(value - choice[0]) < Math.abs(value - best[0]) ? choice : best),
    fallback
  )[1];

function styles(snapshot) {
  return snapshot.pages.flatMap((page) => page.blocks.flatMap((block) => Object.values(block.computedStyles ?? {})));
}

function pick(values, fallback) {
  const counts = new Map();
  for (const value of values) if (value && !TRANSPARENT.has(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best
    ? { value: cssColor(best[0]), confidence: Math.min(0.9, best[1] / Math.max(values.length, 1)), evidence: true }
    : { value: fallback, confidence: 0, evidence: false };
}
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );

/** Extract only bounded theme values; captured page content is never interpreted as instructions. */
export function extractTheme(snapshot, { name = 'Captured site theme' } = {}) {
  if (snapshot?.schemaVersion !== 'snapshot.v1' || !Array.isArray(snapshot.pages)) {
    throw new Error('Theme extractor input must be a snapshot.v1 document with pages.');
  }
  if ((snapshot.diagnostics?.quarantined?.length ?? 0) > 0) {
    throw new Error('Theme extractor refuses snapshots with quarantined pages.');
  }
  const samples = styles(snapshot);
  const text = pick(
    samples.map((s) => s.color),
    FALLBACK_COLORS['text-default']
  );
  const surface = pick(
    samples.map((s) => s.backgroundColor),
    FALLBACK_COLORS['bg-surface']
  );
  const colors = Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => {
      const evidence = key === 'text-default' ? text : key === 'bg-surface' ? surface : null;
      return [key, evidence?.value ?? FALLBACK_COLORS[key]];
    })
  );
  const family = samples.map((s) => s.fontFamily).find(Boolean);
  const safeSans = family && /^[A-Za-z0-9,'" -]+$/.test(family) ? family : FALLBACK_FONTS.sans;
  const radius = Math.max(0, ...samples.map((s) => Number.parseFloat(s.borderRadius) || 0));
  const fontSize = Math.max(0, ...samples.map((s) => Number.parseFloat(s.fontSize) || 0));
  const weight = Math.max(0, ...samples.map((s) => Number.parseFloat(s.fontWeight) || 0));
  const widths = snapshot.pages.flatMap((page) =>
    page.blocks.map((block) => block.boundingBoxes?.desktop?.width).filter(Number.isFinite)
  );
  const padding = samples
    .flatMap((s) => s.padding ?? [])
    .map(Number.parseFloat)
    .filter(Number.isFinite);
  const axisEvidence = {
    containerWidth: widths.length > 0,
    sectionRhythm: padding.length > 0,
    radius: samples.some((s) => s.borderRadius),
    buttonShape: samples.some((s) => s.borderRadius),
    shadow: false,
    scale: samples.some((s) => s.fontSize),
    headingWeight: samples.some((s) => s.fontWeight),
  };
  const containerWidth = widths.length
    ? nearest(
        Math.max(...widths),
        [
          [896, 'narrow'],
          [1152, 'default'],
          [1280, 'wide'],
        ],
        [1152, 'default']
      )
    : 'default';
  const sectionRhythm = padding.length
    ? nearest(
        Math.max(...padding),
        [
          [40, 'compact'],
          [56, 'default'],
          [72, 'airy'],
        ],
        [56, 'default']
      )
    : 'default';
  const buttonShape = axisEvidence.buttonShape
    ? nearest(
        radius,
        [
          [6, 'rect'],
          [12, 'soft'],
          [999, 'pill'],
        ],
        [999, 'pill']
      )
    : 'pill';
  const tokens = {
    colors,
    fonts: { sans: safeSans, serif: FALLBACK_FONTS.serif, heading: FALLBACK_FONTS.heading },
    layout: { containerWidth, sectionRhythm },
    shape: {
      radius: nearest(
        radius,
        [
          [0, 'sharp'],
          [8, 'soft'],
          [16, 'round'],
          [24, 'pill'],
        ],
        [16, 'round']
      ),
      buttonShape,
      shadow: 'soft',
    },
    type: {
      scale: nearest(
        fontSize,
        [
          [16, 'compact'],
          [18, 'default'],
          [19, 'editorial'],
        ],
        [18, 'default']
      ),
      headingWeight: nearest(
        weight,
        [
          [400, 'regular'],
          [500, 'medium'],
          [700, 'bold'],
        ],
        [700, 'bold']
      ),
    },
  };
  const swatches = THEME_COLOR_KEYS.map((key) => {
    const sample = key === 'text-default' ? text : key === 'bg-surface' ? surface : null;
    return { key, value: colors[key], confidence: sample?.confidence ?? 0, fallback: !sample?.evidence };
  });
  const imagery = observeImagery(snapshot);
  const gaps = [
    ...swatches
      .filter((entry) => entry.fallback)
      .map((entry) => `No computed-style evidence for ${entry.key}; using fallback.`),
    family
      ? `Computed font stack inferred: ${family}. No font file is shipped from a snapshot.`
      : 'No computed font family evidence; no font file is shipped from a snapshot.',
    // C3: the observations now have somewhere to go (a DRAFT visual_standard, derivedFrom.method
    // 'clone'), so this line says what was seen and what still has to be decided instead of saying
    // the whole subject was dropped. Nothing is applied by either wording.
    imagery.observed
      ? `Imagery observed but NOT applied: ${imagery.imageCount} distinct image asset(s) across ${imagery.pagesWithImages} page(s), ${imagery.backgroundImageBlocks} background-image block(s), ratios ${imagery.aspectRatios.join(', ') || 'unquantifiable'}. These become a DRAFT visual_standard (derivedFrom.method 'clone') for human review; a snapshot cannot say what the images are OF, so subject and style stay unwritten.`
      : 'No imagery evidence in this snapshot; nothing is written to brandImagery and no imagery standard is derived.',
  ];
  return {
    body: {
      name,
      description: 'Bounded theme draft extracted from captured computed styles.',
      whenToUse: 'Use only for this captured site after human swatch review.',
      scope: 'one_off',
      tokens,
    },
    report: {
      swatches,
      gaps,
      // C3: carried on the REPORT (a CMS-Agent stage artifact), never on `body` — `body` is the theme
      // OBJECT written to the platform, and imagery is not a theme field.
      imagery,
      axes: Object.fromEntries(
        Object.entries({ ...tokens.layout, ...tokens.shape, ...tokens.type }).map(([key, value]) => [
          key,
          { value, confidence: axisEvidence[key] ? 0.7 : 0, evidence: Boolean(axisEvidence[key]) },
        ])
      ),
    },
  };
}

export function renderThemeReport(extraction) {
  const rows = extraction.report.swatches
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.key)}</td><td><span style="display:inline-block;width:2rem;height:1rem;background:${escapeHtml(s.value)}"></span> ${escapeHtml(s.value)}</td><td>${s.confidence.toFixed(2)}</td><td>${s.fallback ? 'fallback' : 'evidence'}</td></tr>`
    )
    .join('');
  const axes = Object.entries(extraction.report.axes)
    .map(
      ([key, axis]) =>
        `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(axis.value)}</td><td>${axis.confidence.toFixed(2)}</td><td>${axis.evidence ? 'evidence' : 'default'}</td></tr>`
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Theme extraction report</title></head><body><h1>Theme extraction specimen</h1><table><thead><tr><th>Role</th><th>Swatch</th><th>Confidence</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table><h2>Typography specimen</h2><p style="font-family:${escapeHtml(extraction.body.tokens.fonts.sans)}">The quick brown fox jumps over the lazy dog.</p><h2>Quantized axes</h2><table><thead><tr><th>Axis</th><th>Value</th><th>Confidence</th><th>Source</th></tr></thead><tbody>${axes}</tbody></table><h2>Gaps</h2><ul>${extraction.report.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('')}</ul></body></html>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, outputDirectory] = process.argv.slice(2);
  if (!input || !outputDirectory) throw new Error('Usage: node theme.mjs <snapshot.json> <output-directory>');
  const extraction = extractTheme(JSON.parse(await readFile(input, 'utf8')));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'theme.v1.json'), `${JSON.stringify(extraction.body, null, 2)}\n`),
    writeFile(path.join(outputDirectory, 'theme-report.html'), renderThemeReport(extraction)),
  ]);
}
