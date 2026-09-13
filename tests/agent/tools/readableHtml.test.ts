import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_FETCH_MAX_CHARS, MAX_FETCH_MAX_CHARS, extractReadable, readableFetchBody } from "../../../src/agent/tools/readableHtml.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/web/${name}`, import.meta.url)), "utf8");
// Shaped like the pages research actually choked on in run_1789303857536_obd2fd: a vet content page
// that is mostly inlined app state, a 120-item nav, a cookie form and a trailing script.
const scriptHeavy = fixture("vet-article.script-heavy.html");

describe("readable extraction (B3)", () => {
  it("returns the article prose and none of the chrome", () => {
    const page = extractReadable(scriptHeavy);

    expect(page.source).toBe("article");
    expect(page.text).toContain("Osteoarthritis is the most common cause of chronic pain in older dogs");
    expect(page.text).toContain("Acute intervertebral disc disease and cruciate rupture");
    // The three things that filled the old 250 000-character response.
    expect(page.text).not.toContain("window.__STATE__");
    expect(page.text).not.toContain("Section 42");
    expect(page.text).not.toContain("We use cookies");
    expect(page.text).not.toContain("Privacy");
    // Nothing that looks like markup survives.
    expect(page.text).not.toMatch(/<\/?[a-z]/i);
  });

  it("reads the title, canonical url and publication date the page declares", () => {
    const page = extractReadable(scriptHeavy);
    expect(page.title).toBe("Senior Dog Mobility: Stairs and Hesitation");
    expect(page.canonicalUrl).toBe("https://vet.example.org/know-your-pet/senior-dog-stairs");
    expect(page.publishedAt).toBe("2025-11-04T09:00:00Z");
  });

  it("falls back to JSON-LD datePublished when there is no meta date", () => {
    const html = '<html><head><script type="application/ld+json">{"datePublished":"2024-02-09T00:00:00Z"}</script></head><body><article>' + "Prose. ".repeat(60) + "</article></body></html>";
    expect(extractReadable(html).publishedAt).toBe("2024-02-09T00:00:00Z");
  });

  it("falls back to a <time datetime> when there is neither", () => {
    const html = "<html><body><article><time datetime='2023-07-01'>July</time>" + "Prose. ".repeat(60) + "</article></body></html>";
    expect(extractReadable(html).publishedAt).toBe("2023-07-01");
  });

  it("decodes entities and keeps block boundaries as line breaks", () => {
    const page = extractReadable("<html><body><p>Dogs &amp; cats</p><p>Second&nbsp;line &#8212; dash</p></body></html>");
    // Paragraph breaks survive as a blank line — a wall of run-together prose costs the model the
    // structure it uses to attribute a claim to a passage.
    expect(page.text).toBe("Dogs & cats\n\nSecond line — dash");
  });

  it("does not let an unclosed dropped element eat the rest of the page", () => {
    const page = extractReadable("<html><body><nav><a>menu</a><p>Real prose that must survive.</p></body></html>");
    expect(page.text).toContain("Real prose that must survive.");
  });

  it("prefers the body over a short teaser <article>", () => {
    const page = extractReadable("<html><body><article><p>Teaser.</p></article><div>" + "The real content. ".repeat(40) + "</div></body></html>");
    expect(page.source).toBe("body");
    expect(page.text).toContain("The real content.");
  });
});

describe("web.fetch body shaping (B3)", () => {
  it("caps the script-heavy page well under 8k and reports what it left out", () => {
    const body = readableFetchBody(scriptHeavy, "text/html; charset=utf-8");

    expect(body.extraction).toBe("readable");
    expect(body.text.length).toBeLessThanOrEqual(DEFAULT_FETCH_MAX_CHARS);
    expect(body.truncated).toBe(false);
    // The whole point: the model reads a small fraction of what it used to be handed.
    expect(body.rawChars).toBe(scriptHeavy.length);
    expect(body.text.length).toBeLessThan(body.rawChars / 4);
    expect(body.title).toBe("Senior Dog Mobility: Stairs and Hesitation");
    expect(body.publishedAt).toBe("2025-11-04T09:00:00Z");
    expect(body.contentSource).toBe("article");
  });

  it("honours maxChars and flags the cut", () => {
    const body = readableFetchBody(scriptHeavy, "text/html", 300);
    expect(body.text).toHaveLength(300);
    expect(body.truncated).toBe(true);
  });

  it("clamps an absurd maxChars instead of overflowing the context", () => {
    const body = readableFetchBody("x".repeat(200_000), "text/plain", 500_000);
    expect(body.text).toHaveLength(MAX_FETCH_MAX_CHARS);
    expect(body.truncated).toBe(true);
  });

  it("passes JSON and plain text through untouched — those are already the payload", () => {
    const json = JSON.stringify({ sources: [{ id: "a", url: "https://example.org" }] });
    const body = readableFetchBody(json, "application/json");
    expect(body.extraction).toBe("raw");
    expect(body.text).toBe(json);
  });

  it("falls back to the raw body for a JS-rendered shell rather than returning nothing", () => {
    // An empty result reads to a model as "the page said nothing", which is a much worse claim than
    // "this page is mostly script" — so a shell degrades to the old behaviour, capped.
    const body = readableFetchBody(fixture("spa-shell.html"), "text/html");
    expect(body.extraction).toBe("raw");
    expect(body.text.length).toBeGreaterThan(0);
    expect(body.text.length).toBeLessThanOrEqual(DEFAULT_FETCH_MAX_CHARS);
  });

  it("detects HTML sent with a careless content-type", () => {
    expect(readableFetchBody(scriptHeavy, "text/plain").extraction).toBe("readable");
  });
});
