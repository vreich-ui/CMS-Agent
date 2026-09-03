// Shared image-reference support for node runners (C4 / node runner image support).
//
// A node's input may carry `imageRefs`: inline (base64) or URL-sourced reference images that the
// model should see alongside the node's ordinary JSON input — e.g. "here's the current hero image,
// produce a caption" or "match this palette." This module is the ONE place that:
//   1. validates a raw imageRefs array against the shape/count/size limits,
//   2. resolves each accepted ref to a base64 payload (fetching a URL with a bounded timeout/size),
//   3. builds the provider-shaped content blocks a runner prepends to its request.
//
// Failure policy: an oversize, unfetchable, or malformed ref is DROPPED with a warning — it never
// fails the node. A reference image is an enrichment to the node's real input, not a precondition
// for running it; losing one bad image must not cost an otherwise-good generation. Every drop is
// both logged (console.warn, for operational visibility) and returned in `warnings` (so a runner —
// or a test — can inspect exactly what happened without scraping stdout).
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type ImageRef = {
  url?: string;
  base64?: string;
  mediaType: ImageMediaType;
  label?: string;
};

export const MAX_IMAGE_REFS = 8;
// 1.5 MB, measured on the RESOLVED (decoded) bytes — whether they arrived as a fetched response body
// or as an inline base64 payload. "after fetch" in the brief is read as "on the bytes the model would
// actually receive," not "only when a fetch happened."
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 10000;

const ALLOWED_MEDIA_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/webp"];

export type ResolvedImageRef = { base64: string; mediaType: ImageMediaType; label?: string };
export type ImageRefWarning = { label?: string; reason: string };
export type ResolveImageRefsResult = { resolved: ResolvedImageRef[]; warnings: ImageRefWarning[] };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const isImageRefShaped = (value: unknown): value is ImageRef => isRecord(value) && typeof value.mediaType === "string";

/** Read `imageRefs` off a node input, if present and array-shaped. Never throws, never mutates. */
export const extractImageRefs = (input: unknown): unknown[] | undefined => {
  if (!isRecord(input)) return undefined;
  const refs = input.imageRefs;
  return Array.isArray(refs) ? refs : undefined;
};

/**
 * Strip `imageRefs` from a node's input before it is serialized into the request's JSON text —
 * imageRefs travel as content blocks instead, never duplicated into the text payload. Returns the
 * SAME reference when there is nothing to strip, so a caller with no imageRefs gets back the
 * identical object it passed in (byte-for-byte JSON.stringify parity with today's behavior).
 */
export const stripImageRefs = <T>(input: T): T => {
  if (!isRecord(input) || !("imageRefs" in input)) return input;
  const { imageRefs: _omit, ...rest } = input;
  return rest as T;
};

// Byte length implied by a base64 string, without allocating a Buffer just to measure it: 4 chars
// encode 3 bytes, minus 1 byte per trailing '=' pad character.
const base64ByteLength = (base64: string): number => {
  const clean = base64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
};

type FetchOutcome = { base64: string } | { error: string };

// REVIEW: a `url` on an imageRef is caller-supplied and reaches an outbound fetch, so the scheme is
// allowlisted rather than left to whatever the runtime happens to support. `data:` is accepted by
// undici's fetch and would smuggle arbitrary bytes past the base64 branch's own size check; `file:`
// and any custom scheme have no business here at all. http/https only, parsed rather than
// prefix-matched so `https:/\evil` and friends cannot slip through a string test.
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

const allowedFetchUrl = (url: string): boolean => {
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

// REVIEW: the cap is enforced WHILE the body arrives, not after it has all been buffered.
// `await response.arrayBuffer()` allocates whatever the server chooses to send before anyone can
// measure it, so a hostile (or merely misconfigured) host that streams gigabytes inside the 10s
// timeout took the whole node process down with it — the timeout bounds duration, never volume.
// Two guards, cheapest first: an advertised Content-Length over the cap is refused before a single
// body byte is read, and the stream itself is aborted the moment the running total passes the cap.
// A body with no reader (a stubbed/legacy Response) falls back to arrayBuffer(), which is safe
// because that path only exists where the response is already in memory.
async function readBoundedBody(response: Response): Promise<{ bytes: Buffer } | { error: string }> {
  const declared = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return { error: `oversize (Content-Length ${declared} exceeds the ${MAX_IMAGE_BYTES}-byte cap)` };
  }
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      return { error: `oversize (${arrayBuffer.byteLength} bytes exceeds the ${MAX_IMAGE_BYTES}-byte cap)` };
    }
    return { bytes: Buffer.from(arrayBuffer) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        return { error: `oversize (body exceeded the ${MAX_IMAGE_BYTES}-byte cap after ${total} bytes; the transfer was aborted)` };
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket on both the over-cap return above and any read error.
    await reader.cancel().catch(() => undefined);
  }
  return { bytes: Buffer.concat(chunks, total) };
}

async function fetchAsBase64(url: string, fetchImpl: typeof fetch): Promise<FetchOutcome> {
  if (!allowedFetchUrl(url)) return { error: "unsupported URL scheme; only http(s) image URLs are fetched" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const read = await readBoundedBody(response);
    if ("error" in read) return read;
    return { base64: read.bytes.toString("base64") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: /abort/i.test(message) ? `timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate and resolve a raw `imageRefs` array into base64 payloads ready for a provider's content
 * blocks. Every failure mode (bad shape, unsupported mediaType, oversize, fetch failure/timeout,
 * more than MAX_IMAGE_REFS) is handled by DROPPING that one ref and recording why — this function
 * never throws and never fails the caller's node.
 *
 * MAX_IMAGE_REFS reading: the brief caps imageRefs at 8 without saying reject-vs-truncate. This
 * truncates to the first 8 (dropping the rest with a warning) rather than rejecting the whole node,
 * consistent with the "a bad/excess ref never costs the node" policy applied to every other failure
 * mode here — a caller that sends 9 reference images almost certainly still wants the node to run
 * with 8 of them, not to see the entire generation refused over one extra image.
 *
 * When a ref carries BOTH `url` and `base64`, `base64` wins and no fetch is attempted — it is already
 * the bytes the model needs, so fetching would be redundant network cost for no benefit.
 */
export async function resolveImageRefs(rawRefs: unknown[] | undefined, opts: { fetchImpl?: typeof fetch } = {}): Promise<ResolveImageRefsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const warnings: ImageRefWarning[] = [];
  if (!rawRefs || rawRefs.length === 0) return { resolved: [], warnings };

  const accepted = rawRefs.length > MAX_IMAGE_REFS ? rawRefs.slice(0, MAX_IMAGE_REFS) : rawRefs;
  if (rawRefs.length > MAX_IMAGE_REFS) {
    warnings.push({ reason: `${rawRefs.length} imageRefs provided, exceeding the ${MAX_IMAGE_REFS}-ref cap; kept the first ${MAX_IMAGE_REFS} and dropped ${rawRefs.length - MAX_IMAGE_REFS}.` });
  }

  const resolved: ResolvedImageRef[] = [];
  for (const raw of accepted) {
    if (!isImageRefShaped(raw)) { warnings.push({ reason: "dropped: not an object with a mediaType." }); continue; }
    const label = typeof raw.label === "string" ? raw.label : undefined;
    if (!ALLOWED_MEDIA_TYPES.includes(raw.mediaType)) {
      warnings.push({ label, reason: `dropped: unsupported mediaType "${String(raw.mediaType)}".` });
      continue;
    }
    if (typeof raw.base64 === "string" && raw.base64) {
      const bytes = base64ByteLength(raw.base64);
      if (bytes > MAX_IMAGE_BYTES) {
        warnings.push({ label, reason: `dropped: oversize (${bytes} bytes exceeds the ${MAX_IMAGE_BYTES}-byte cap).` });
        continue;
      }
      resolved.push({ base64: raw.base64, mediaType: raw.mediaType, label });
      continue;
    }
    if (typeof raw.url === "string" && raw.url) {
      const outcome = await fetchAsBase64(raw.url, fetchImpl);
      if ("error" in outcome) { warnings.push({ label, reason: `dropped: fetch failed (${outcome.error}).` }); continue; }
      resolved.push({ base64: outcome.base64, mediaType: raw.mediaType, label });
      continue;
    }
    warnings.push({ label, reason: "dropped: neither url nor base64 was provided." });
  }

  for (const warning of warnings) console.warn("agent.imageRefs.dropped", warning);
  return { resolved, warnings };
}

// ---- Provider-shaped content blocks -----------------------------------------------------------
// Each provider's Vision/multimodal input uses its own block shape. The runner then assembles
// `content: [...imageBlocks, { type: "text", text: <the node's JSON payload> }]` — images first,
// the node's existing JSON text last, unchanged in every way except imageRefs itself being stripped
// out of it (see stripImageRefs above).

// Anthropic Messages API content block (docs.anthropic.com/en/api/messages — image content blocks).
export type AnthropicImageBlock = { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };
export const buildAnthropicImageBlocks = (resolved: ResolvedImageRef[]): AnthropicImageBlock[] =>
  resolved.map((ref) => ({ type: "image", source: { type: "base64", media_type: ref.mediaType, data: ref.base64 } }));

// OpenAI Agents SDK user-message content item (agents-core/dist/types/protocol.d.ts InputImage): a
// data: URI carries the mediaType alongside the bytes, so the block is self-contained.
export type OpenAIImageBlock = { type: "input_image"; image: string };
export const buildOpenAIImageBlocks = (resolved: ResolvedImageRef[]): OpenAIImageBlock[] =>
  resolved.map((ref) => ({ type: "input_image", image: `data:${ref.mediaType};base64,${ref.base64}` }));

// MockNodeRunner calls no real provider, so there is no wire format to match — it reuses the
// Anthropic shape purely as a stable, inspectable convention for dry-run/tests.
export type MockImageBlock = AnthropicImageBlock;
export const buildMockImageBlocks = buildAnthropicImageBlocks;
