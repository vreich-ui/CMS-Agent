import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_REFS,
  IMAGE_FETCH_TIMEOUT_MS,
  buildAnthropicImageBlocks,
  buildOpenAIImageBlocks,
  buildMockImageBlocks,
  extractImageRefs,
  resolveImageRefs,
  stripImageRefs
} from "../../../src/agent/execution/runners/imageRefs.js";

// C4 — node runner image support (BRIEF 3.9). Unit-level coverage of the shared imageRefs module:
// validation, size/count caps, URL fetch (success/oversize/failure/timeout), base64 handling, and
// provider-shaped content block builders. Runner-level integration (the actual content array a
// runner sends) is covered separately in runnerImageRefs.test.ts.

const PNG_1x1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const smallRef = (over: Record<string, unknown> = {}) => ({ base64: PNG_1x1_BASE64, mediaType: "image/png", ...over });

describe("extractImageRefs / stripImageRefs", () => {
  it("returns undefined for non-object input, missing imageRefs, or a non-array value", () => {
    expect(extractImageRefs(undefined)).toBeUndefined();
    expect(extractImageRefs("a string")).toBeUndefined();
    expect(extractImageRefs({})).toBeUndefined();
    expect(extractImageRefs({ imageRefs: "not-an-array" })).toBeUndefined();
  });

  it("reads a present, array-shaped imageRefs", () => {
    const refs = [smallRef()];
    expect(extractImageRefs({ imageRefs: refs })).toBe(refs);
  });

  it("stripImageRefs returns the SAME object reference when there is nothing to strip", () => {
    const input = { question: "hi" };
    expect(stripImageRefs(input)).toBe(input);
  });

  it("stripImageRefs removes only the imageRefs key, leaving every other key untouched", () => {
    const input = { question: "hi", imageRefs: [smallRef()], nested: { a: 1 } };
    const stripped = stripImageRefs(input) as Record<string, unknown>;
    expect(stripped).toEqual({ question: "hi", nested: { a: 1 } });
    expect(stripped).not.toHaveProperty("imageRefs");
  });

  it("stripImageRefs is a no-op on non-object input", () => {
    expect(stripImageRefs("plain string" as unknown as Record<string, unknown>)).toBe("plain string");
    expect(stripImageRefs(undefined as unknown as Record<string, unknown>)).toBeUndefined();
  });
});

describe("resolveImageRefs — base64 refs", () => {
  it("resolves an empty/undefined list to no images and no warnings", async () => {
    expect(await resolveImageRefs(undefined)).toEqual({ resolved: [], warnings: [] });
    expect(await resolveImageRefs([])).toEqual({ resolved: [], warnings: [] });
  });

  it("accepts a valid inline base64 ref for each allowed mediaType", async () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/webp"]) {
      const { resolved, warnings } = await resolveImageRefs([smallRef({ mediaType, label: mediaType })]);
      expect(warnings).toEqual([]);
      expect(resolved).toEqual([{ base64: PNG_1x1_BASE64, mediaType, label: mediaType }]);
    }
  });

  it("drops a ref with an unsupported mediaType, with a warning, and never throws", async () => {
    const { resolved, warnings } = await resolveImageRefs([smallRef({ mediaType: "image/gif", label: "bad-type" })]);
    expect(resolved).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ label: "bad-type" });
    expect(warnings[0].reason).toContain("unsupported mediaType");
  });

  it("drops a ref with neither url nor base64", async () => {
    const { resolved, warnings } = await resolveImageRefs([{ mediaType: "image/png", label: "empty" }]);
    expect(resolved).toEqual([]);
    expect(warnings[0].reason).toContain("neither url nor base64");
  });

  it("drops a malformed (non-object / no mediaType) entry", async () => {
    const { resolved, warnings } = await resolveImageRefs(["not-an-object", { url: "https://x" }]);
    expect(resolved).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it("drops an oversize inline base64 ref (> 1.5MB decoded) with a warning, and keeps a good sibling", async () => {
    const oversizeBase64 = Buffer.alloc(MAX_IMAGE_BYTES + 1024).toString("base64");
    const { resolved, warnings } = await resolveImageRefs([
      smallRef({ label: "good" }),
      { base64: oversizeBase64, mediaType: "image/png", label: "too-big" }
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].label).toBe("good");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ label: "too-big" });
    expect(warnings[0].reason).toContain("oversize");
  });

  it("when both url and base64 are given, base64 wins and no fetch is attempted", async () => {
    const fetchImpl = vi.fn();
    const { resolved, warnings } = await resolveImageRefs([smallRef({ url: "https://example.com/x.png" })], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(resolved).toEqual([{ base64: PNG_1x1_BASE64, mediaType: "image/png", label: undefined }]);
  });
});

describe("resolveImageRefs — url fetch", () => {
  it("fetches and base64-encodes a URL ref within the size cap", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer })) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/x.png", mediaType: "image/png", label: "fetched" }], { fetchImpl });
    expect(warnings).toEqual([]);
    expect(resolved).toEqual([{ base64: Buffer.from(bytes).toString("base64"), mediaType: "image/png", label: "fetched" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as any).mock.calls[0][0]).toBe("https://example.com/x.png");
  });

  it("drops (with a warning) a URL ref whose response exceeds the size cap, and does NOT fail the caller", async () => {
    const oversized = new ArrayBuffer(MAX_IMAGE_BYTES + 1);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => oversized })) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/huge.png", mediaType: "image/png", label: "huge" }], { fetchImpl });
    expect(resolved).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ label: "huge" });
    expect(warnings[0].reason).toContain("oversize");
  });

  // REVIEW: the cap must be enforced WHILE the body arrives. Before this, `await
  // response.arrayBuffer()` allocated whatever the server chose to send and only then measured it,
  // so a host streaming gigabytes inside the 10s timeout took the node process down — the timeout
  // bounds duration, never volume. Both guards are pinned here: the advertised length (no body byte
  // read at all) and the running total (the transfer aborted mid-stream).
  it("refuses a URL ref whose Content-Length already exceeds the cap WITHOUT reading the body", async () => {
    const readBody = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(MAX_IMAGE_BYTES + 1) }),
      body: { getReader: readBody },
      arrayBuffer: readBody
    })) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/huge.png", mediaType: "image/png", label: "declared-huge" }], { fetchImpl });
    expect(resolved).toEqual([]);
    expect(warnings[0].reason).toContain("Content-Length");
    expect(readBody).not.toHaveBeenCalled();
  });

  it("aborts a streamed body the moment it passes the cap, instead of buffering all of it", async () => {
    // Three 1MB chunks: the 1.5MB cap is passed on the second, and the third must never be read.
    const chunk = new Uint8Array(1024 * 1024);
    let chunksRead = 0;
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => (chunksRead++ < 3 ? { done: false, value: chunk } : { done: true, value: undefined }),
          cancel
        })
      }
    })) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/stream.png", mediaType: "image/png", label: "streamed" }], { fetchImpl });
    expect(resolved).toEqual([]);
    expect(warnings[0].reason).toContain("aborted");
    expect(chunksRead).toBe(2);
    expect(cancel).toHaveBeenCalled();
  });

  it("streams a body under the cap to completion when there is no Content-Length", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    let sent = false;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: chunk })), cancel: async () => undefined }) }
    })) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/ok.png", mediaType: "image/png" }], { fetchImpl });
    expect(warnings).toEqual([]);
    expect(resolved[0]!.base64).toBe(Buffer.from(chunk).toString("base64"));
  });

  it("never fetches a non-http(s) URL — data:, file: and a malformed URL are dropped before any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const url of ["data:image/png;base64,AAAA", "file:///etc/passwd", "not a url"]) {
      const { resolved, warnings } = await resolveImageRefs([{ url, mediaType: "image/png", label: url }], { fetchImpl });
      expect(resolved).toEqual([]);
      expect(warnings[0].reason).toContain("unsupported URL scheme");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops (with a warning) a URL ref on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/missing.png", mediaType: "image/png", label: "404" }], { fetchImpl });
    expect(resolved).toEqual([]);
    expect(warnings[0].reason).toContain("404");
  });

  it("drops (with a warning) a URL ref whose fetch throws (network error)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const { resolved, warnings } = await resolveImageRefs([{ url: "https://example.com/x.png", mediaType: "image/png", label: "network" }], { fetchImpl });
    expect(resolved).toEqual([]);
    expect(warnings[0].reason).toContain("ECONNRESET");
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("aborts and drops (with a warning) a URL fetch that never settles within the 10s timeout", async () => {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      })) as unknown as typeof fetch;

      const pending = resolveImageRefs([{ url: "https://example.com/slow.png", mediaType: "image/png", label: "slow" }], { fetchImpl });
      await vi.advanceTimersByTimeAsync(IMAGE_FETCH_TIMEOUT_MS);
      const { resolved, warnings } = await pending;

      expect(resolved).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ label: "slow" });
      expect(warnings[0].reason).toContain("timed out");
    });
  });
});

describe("resolveImageRefs — the 8-ref cap", () => {
  it("truncates to the first 8 refs and drops the rest with a single warning naming the count (does not reject the call)", async () => {
    const refs = Array.from({ length: 9 }, (_, i) => smallRef({ label: `ref-${i}` }));
    const { resolved, warnings } = await resolveImageRefs(refs);
    expect(resolved).toHaveLength(MAX_IMAGE_REFS);
    expect(resolved.map((r) => r.label)).toEqual(["ref-0", "ref-1", "ref-2", "ref-3", "ref-4", "ref-5", "ref-6", "ref-7"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain("9 imageRefs provided");
    expect(warnings[0].reason).toContain("8");
  });

  it("exactly 8 refs are all kept, no cap warning", async () => {
    const refs = Array.from({ length: 8 }, (_, i) => smallRef({ label: `ref-${i}` }));
    const { resolved, warnings } = await resolveImageRefs(refs);
    expect(resolved).toHaveLength(8);
    expect(warnings).toEqual([]);
  });
});

describe("provider-shaped content block builders", () => {
  const resolved = [{ base64: "QQ==", mediaType: "image/png" as const, label: "a" }, { base64: "Qg==", mediaType: "image/jpeg" as const }];

  it("buildAnthropicImageBlocks matches the Messages API image content-block shape", () => {
    expect(buildAnthropicImageBlocks(resolved)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Qg==" } }
    ]);
  });

  it("buildOpenAIImageBlocks emits a data: URI input_image block", () => {
    expect(buildOpenAIImageBlocks(resolved)).toEqual([
      { type: "input_image", image: "data:image/png;base64,QQ==" },
      { type: "input_image", image: "data:image/jpeg;base64,Qg==" }
    ]);
  });

  it("buildMockImageBlocks produces blocks (reuses the Anthropic shape; never sent over the wire)", () => {
    expect(buildMockImageBlocks(resolved)).toEqual(buildAnthropicImageBlocks(resolved));
  });

  it("every builder returns an empty array for an empty resolved list", () => {
    expect(buildAnthropicImageBlocks([])).toEqual([]);
    expect(buildOpenAIImageBlocks([])).toEqual([]);
    expect(buildMockImageBlocks([])).toEqual([]);
  });
});
