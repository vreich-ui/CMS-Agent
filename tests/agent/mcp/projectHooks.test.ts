import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}").result.structuredContent;
};

// The client-shaped envelope the article_body node emits — validate_handoff checks it against the
// node's OWN outputSchema (R-6/R-23 deleted the workspace-local {schema_version, nodes} monolith).
// The Dr. Lurie artifact-policy walker is shape-agnostic (it recurses the whole payload), so policy
// findings still fire on refs nested under `body`.
const envelope = (body: Record<string, unknown>) => ({
  artifact: "article_body.v1",
  summary: "Reader-facing body.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body
});
const validArticleBody = envelope({ slug: "example", title: "T", nodes: [{ id: "n_x", kind: "content", public: { title: "T", body: "Reader-facing body." } }] });

describe("per-project hooks: validate_handoff policy + knowledge", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("applies Dr. Lurie artifact policy: raw image artifact URLs are blocking errors", async () => {
    const articleBody = envelope({ slug: "img", title: "T", nodes: [{ id: "n_img", kind: "content", public: { title: "T", body: "Body.", media: { type: "image", src: "image/req_x/abc123.png", alt: "x" } } }] });
    const { data } = await call("project.validate_handoff", { projectId: "dr-lurie", articleBody });
    const validation = data.validation;

    expect(validation.projectPolicy.applied).toBe(true);
    const codes = validation.projectPolicy.findings.map((finding: { code: string }) => finding.code);
    expect(codes).toContain("raw_image_artifact_public_url");
    // Error-severity findings mark the handoff invalid and land in issues.
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(" ")).toContain("raw_image_artifact_public_url");
  });

  it("keeps warning-severity findings advisory (PDF fallback advisory does not flip valid)", async () => {
    const articleBody = envelope({ slug: "doc", title: "T", nodes: [{ id: "n_doc", kind: "content", public: { title: "T", body: "Full methodology in pdf/req_1/abc123.pdf for reviewers." } }] });
    const { data } = await call("project.validate_handoff", { projectId: "dr-lurie", articleBody });
    const validation = data.validation;

    const warning = validation.projectPolicy.findings.find((finding: { code: string }) => finding.code === "pdf_artifact_route_allowed");
    expect(warning?.severity).toBe("warning");
    expect(validation.valid).toBe(true);
  });

  it("passes a clean Dr. Lurie handoff with the hook applied and no findings", async () => {
    const { data } = await call("project.validate_handoff", { projectId: "dr-lurie", articleBody: validArticleBody });
    expect(data.validation).toMatchObject({ valid: true, projectPolicy: { applied: true, findings: [] } });
  });

  it("reports hooks as not applied for projects without a hook module", async () => {
    await call("project.create", { project: { projectId: "acme-hooks", name: "Acme", mcpEndpointEnvVar: "ACME_HOOKS_MCP_ENDPOINT", authMode: "none" } });
    const { data } = await call("project.validate_handoff", { projectId: "acme-hooks", articleBody: validArticleBody });
    expect(data.validation.projectPolicy).toEqual({ applied: false, findings: [] });
    expect(data.validation.valid).toBe(true);
  });

  it("coerces a stringified articleBody payload (MCP client serialization) before validation", async () => {
    // Observed live: the connector delivered articleBody as a JSON string. The hook must still run
    // over the parsed object and report policy findings.
    const articleBody = JSON.stringify(envelope({ slug: "img", title: "T", nodes: [{ id: "n_img", kind: "content", public: { title: "T", body: "Body.", media: { type: "image", src: "image/req_x/abc123.png", alt: "x" } } }] }));
    const { data } = await call("project.validate_handoff", { projectId: "dr-lurie", articleBody });
    const validation = data.validation;

    expect(validation.checks.articleBody.valid).toBe(true);
    expect(validation.projectPolicy.findings.map((finding: { code: string }) => finding.code)).toContain("raw_image_artifact_public_url");
    expect(validation.valid).toBe(false);
  });

  it("surfaces Dr. Lurie knowledge rules on project.get and null for hookless projects", async () => {
    const drLurie = await call("project.get", { projectId: "dr-lurie" });
    expect(drLurie.data.knowledge.projectId).toBe("dr-lurie");
    expect(drLurie.data.knowledge.rules.artifacts.length).toBeGreaterThan(0);
    // The knowledge block describes the OBJECT path and names the retired one as retired, so an
    // agent reading it can never be led back into the frozen pipeline.
    expect(drLurie.data.knowledge.rules.noLegacyPath.join(" ")).toContain("object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin");
    // Per-site identifiers come from the connection config, so prose and publish hook cannot drift.
    expect(drLurie.data.knowledge.site).toMatchObject({ siteObjectId: "site_drlurie", taxonomyRegistryObjectId: "tax_drlurie" });

    await call("project.create", { project: { projectId: "acme-know", name: "Acme", mcpEndpointEnvVar: "ACME_KNOW_MCP_ENDPOINT", authMode: "none" } });
    const acme = await call("project.get", { projectId: "acme-know" });
    expect(acme.data.knowledge).toBeNull();
  });
});
