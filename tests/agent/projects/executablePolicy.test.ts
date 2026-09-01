import { describe, expect, it } from "vitest";
import { evaluateDrLurieCallToolPolicy, LEGACY_ARTIFACT_FALLBACK_TOOLS } from "../../../src/agent/projects/drLurie/executablePolicy.js";

const codes = (findings: { code: string }[]) => findings.map((finding) => finding.code);

describe("Dr. Lurie executable call-tool policy", () => {
  it("blocks the legacy artifact fallback tools by name", () => {
    for (const tool of LEGACY_ARTIFACT_FALLBACK_TOOLS) {
      const findings = evaluateDrLurieCallToolPolicy({ tool, arguments: {} });
      expect(codes(findings)).toContain("blocked_legacy_artifact_tool");
      expect(findings.every((finding) => finding.severity === "error")).toBe(true);
    }
  });

  it("blocks renamed variants of the fallback tools", () => {
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "save_artifact_v2", arguments: {} }))).toContain("blocked_legacy_artifact_tool");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "create_artifact_from_url_batch", arguments: {} }))).toContain("blocked_legacy_artifact_tool");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "create_upload_intent", arguments: {} }))).toContain("blocked_legacy_artifact_tool");
  });

  it("blocks public remote and data image URL arguments on any tool", () => {
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { source: "https://cdn.example.com/hero.png" } }))).toContain("blocked_remote_image_url");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { source: "//cdn.example.com/hero.jpg" } }))).toContain("blocked_remote_image_url");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { source: "data:image/png;base64,iVBORw0KGgo=" } }))).toContain("blocked_remote_image_url");
  });

  it("blocks copied raw artifact references", () => {
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { reference: "image/req_demo/abc123.png" } }))).toContain("blocked_copied_artifact_ref");
    // Still blocked even where the filename LOOKS machine-ish: the exemption below is a proof, not a
    // resemblance. 63 hex characters is not a sha256, and a hand-typed key is what this rule is for.
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { reference: `image/req_demo/${"a".repeat(63)}.webp` } }))).toContain("blocked_copied_artifact_ref");
  });

  // FIX-2. BRIEF §3.10's sanctioned cover binding — assets.images[] = {assetId, blobKey} naming an
  // image already in the tenant's store, so the bytes never travel over MCP — carries a key in
  // pdf-tool's canonical layout `{artifactKind}/{safeRequestId}/{sha256}{ext}`, which is exactly the
  // shape copiedArtifactRefPattern and handAuthoredBlobKeyPattern both match. On dr-lurie an article
  // PDF with a cover was therefore a blocked slot rather than a render.
  //
  // The distinction the rule actually cares about is HAND-AUTHORED versus MACHINE-MINTED, and a
  // canonical key cannot be hand-authored: its filename is the sha256 of bytes nobody knows until the
  // bytes exist. So a key that parses as canonical is exempt, and everything else is untouched.
  it("exempts machine-minted canonical blob keys, and only those", () => {
    const sha = "b".repeat(64);
    // The §3.10 cover binding itself, in the shape the materializer actually sends it.
    expect(evaluateDrLurieCallToolPolicy({
      tool: "create_agent_artifact_job",
      arguments: { site_id: "site_drlurie", assets: { images: [{ assetId: "hero", blobKey: `image/req_conductor_barrier_20260831_01/${sha}.webp` }] } }
    })).toEqual([]);
    // Every canonical kind, with and without an extension — the layout's own vocabulary.
    for (const key of [`image/req_1/${sha}.webp`, `pdf/req_1/${sha}.pdf`, `binary/req_1/${sha}`]) {
      expect(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: key } }), key).toEqual([]);
    }
    // NOT exempt, because none of these parses as canonical: a hand-typed filename, a multi-segment
    // request id (the layout sanitizes the request id to ONE path segment), an uppercase digest, and a
    // remote URL that merely ends in a canonical-looking path.
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: "image/req_1/cover.webp" } }))).toContain("blocked_copied_artifact_ref");
    // (a multi-segment path is caught by the copied-ref pattern, which is the first classifier that
    // matches it — the code differs, the refusal does not.)
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: `image/req_1/nested/${sha}.webp` } }))).toContain("blocked_copied_artifact_ref");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: `image/req_1/${"B".repeat(64)}.webp` } }))).toContain("blocked_copied_artifact_ref");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: `https://cdn.example.com/image/req_1/${sha}.webp` } }))).toContain("blocked_remote_image_url");
  });

  // REVIEW: the exemption runs FIRST, so it is only ever as narrow as its own pattern. These are the
  // strings that defeated the original `([a-z]+)/([^/]+)/<64 hex>` spelling — each one a shape
  // pdf-tool's canonical layout cannot produce, each one waved past the classifier it was written for.
  it("does not exempt a key outside pdf-tool's actual canonical layout", () => {
    const sha = "c".repeat(64);
    // Namespaces pdf-tool never mints (its kinds are image/pdf/binary) are exactly the roots the
    // hand-authored-key rule exists for; 64 hex characters must not buy passage into them.
    for (const key of [`uploads/req_1/${sha}.webp`, `documents/req_1/${sha}.pdf`, `artifacts/req_1/${sha}.json`, `media/req_1/${sha}.png`]) {
      expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: key } })), key).toContain("blocked_hand_authored_blob_key");
    }
    // A repo path whose filename happens to be 64 hex characters is still a repo path.
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { path: `src/content/${sha}.md` } }))).toContain("blocked_repo_path");
    // pdf-tool sanitizes a request id to [A-Za-z0-9._-]; a segment it could not have produced is not
    // evidence that it did.
    for (const key of [`image/..%2fetc/${sha}.webp`, `image/req~1/${sha}.webp`]) {
      expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: key } })), key).toContain("blocked_copied_artifact_ref");
    }
    // REVIEW: `.` and `..` are inside pdf-tool's own sanitized charset, so a request segment made
    // only of them parsed as canonical and was exempted — a key that addresses its own parent, waved
    // through as machine-minted. The segment now needs at least one alphanumeric.
    for (const key of [`image/../${sha}.webp`, `image/./${sha}.webp`, `image/.../${sha}.webp`]) {
      expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: key } })), key).toContain("blocked_copied_artifact_ref");
    }
    // A real request id keeps every character it is allowed, dots and dashes included.
    expect(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: `image/req_article.v2-01/${sha}.webp` } })).toEqual([]);
  });

  it("blocks hand-authored blob-store keys", () => {
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { blobKey: "document/req_1/methodology.pdf" } }))).toContain("blocked_hand_authored_blob_key");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "restore_artifact", arguments: { key: "artifacts/req_9/report.json" } }))).toContain("blocked_hand_authored_blob_key");
  });

  it("blocks repository / source paths used as artifact sources", () => {
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { path: "src/content/posts/my-post.md" } }))).toContain("blocked_repo_path");
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { path: "../../secrets/keys.md" } }))).toContain("blocked_repo_path");
  });

  it("detects dangerous values nested inside arguments", () => {
    const findings = evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { payload: { items: [{ src: "https://cdn.example.com/hero.webp" }] } } });
    expect(codes(findings)).toContain("blocked_remote_image_url");
    expect(findings[0].path).toContain("payload");
  });

  it("allows sanctioned read-only tools and materialized references", () => {
    expect(evaluateDrLurieCallToolPolicy({ tool: "ping", arguments: { message: "hello" } })).toEqual([]);
    expect(evaluateDrLurieCallToolPolicy({ tool: "search_artifacts", arguments: { query: "climate", kind: "image", prefix: "image/" } })).toEqual([]);
    expect(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { artifactId: "art_123" } })).toEqual([]);
    expect(evaluateDrLurieCallToolPolicy({ tool: "get_pdf_tool_storage_grant", arguments: { requestId: "req_1" } })).toEqual([]);
    // A materialized site path (leading slash) is a valid reference, not a hand-authored key.
    expect(evaluateDrLurieCallToolPolicy({ tool: "verify_article_images", arguments: { src: "/media/req_demo/image.jpg" } })).toEqual([]);
  });

  // REVIEW — the failure C2's own change made reachable. `enforceCallToolPolicy` now runs inside
  // artifactMaterialization.ts, so a PDF slot's create call carries the deterministically derived
  // `data` — including `sources[].url` straight out of draft_writer. `repoFileExtensionPattern` is
  // unanchored and lists .html/.htm/.md/.yaml, so one cited .html source classified the whole
  // article's render data as a repository path and came back `tool_policy_blocked`.
  it("does not misclassify a remote citation URL as a repo path — a scheme and a host is not a source tree", () => {
    const renderData = {
      site_id: "site_drlurie",
      template_id: "article_brochure_v1",
      data: {
        title: "What the guidance actually says",
        sources: [
          { label: "FDA", url: "https://www.fda.gov/drugs/postmarket/guide.html" },
          { label: "Spec", url: "https://example.org/a/b/readme.md" },
          { label: "Config", url: "https://example.org/deploy/values.yaml" }
        ]
      }
    };
    expect(evaluateDrLurieCallToolPolicy({ tool: "create_agent_artifact_job", arguments: renderData })).toEqual([]);

    // A remote IMAGE url is still refused — by the rule that actually governs remote artifact
    // sources, one branch earlier, and under its own code.
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "create_agent_artifact_job", arguments: { src: "https://cdn.example.com/hero.png" } }))).toContain("blocked_remote_image_url");
    // And a genuine repo path is untouched: none of them carries a scheme.
    for (const path of ["src/pages/post.md", "../assets/hero.mdx", "content/blog/x.astro", "packages/core/lib/x.ts"]) {
      expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { path } }))).toContain("blocked_repo_path");
    }
  });

  it("does not misclassify absolute materialized served paths as repo paths", () => {
    // Leading-slash served paths (Astro/static build output) are materialized references, not repo
    // sources, and must not be blocked — even when the directory name matches a repo root.
    for (const src of ["/assets/req_demo/hero.png", "/public/img/logo.svg", "/_astro/index.abc123.js"]) {
      expect(evaluateDrLurieCallToolPolicy({ tool: "verify_article_images", arguments: { src } })).toEqual([]);
    }
    // Relative repo/source paths (no leading slash) are still blocked.
    expect(codes(evaluateDrLurieCallToolPolicy({ tool: "get_artifact_metadata", arguments: { path: "assets/hero.astro" } }))).toContain("blocked_repo_path");
  });
});
