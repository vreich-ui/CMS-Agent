import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}").result.structuredContent;
};

const validArticleBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", public: { title: "T", body: "Reader-facing body." } }] };

describe("per-project hooks: validate_handoff policy + knowledge", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("applies Dr. Lurie artifact policy: raw image artifact URLs are blocking errors", async () => {
    const articleBody = {
      schema_version: "article_body.v1",
      nodes: [{ id: "n_img", kind: "content", public: { title: "T", body: "Body.", media: { type: "image", src: "image/req_x/abc123.png", alt: "x" } } }]
    };
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
    const articleBody = {
      schema_version: "article_body.v1",
      nodes: [{ id: "n_doc", kind: "content", public: { title: "T", body: "Full methodology in pdf/req_1/abc123.pdf for reviewers." } }]
    };
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

  it("surfaces Dr. Lurie knowledge rules on project.get and null for hookless projects", async () => {
    const drLurie = await call("project.get", { projectId: "dr-lurie" });
    expect(drLurie.data.knowledge.projectId).toBe("dr-lurie");
    expect(drLurie.data.knowledge.rules.artifactReferences.length).toBeGreaterThan(0);

    await call("project.create", { project: { projectId: "acme-know", name: "Acme", mcpEndpointEnvVar: "ACME_KNOW_MCP_ENDPOINT", authMode: "none" } });
    const acme = await call("project.get", { projectId: "acme-know" });
    expect(acme.data.knowledge).toBeNull();
  });
});
