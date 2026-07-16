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
});
