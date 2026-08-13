import { describe, expect, it } from "vitest";
import { createProject, projectCreateSchema, projectRegistrationContract, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { PLATFORM_CAPTURE_POLICY, PLATFORM_DEFINITION_VERSION, platformProjectConfig } from "../../../src/agent/projects/platform/definition.js";
import { toProjectSummary } from "../../../src/agent/projects/projectRegistry.js";
import { DEFAULT_PROJECT_CAPTURE_POLICY, resolveProjectCapturePolicy, type ProjectCapturePolicy, type ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";

const capturePolicy: ProjectCapturePolicy = {
  maxPages: 75,
  allowedCrawlOrigins: ["https://example.com"],
  allowedPathPrefixes: ["/news"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 2,
  delayMs: 2000,
  authenticatedAccess: "prohibited",
  rights: { content: "retain_allowed_origin_content", media: "retain_referenced_allowed_origin_media" },
  designReferences: [],
  fidelity: {
    mode: "source_faithful",
    sourceDesignTreatment: "source_content_and_design",
    coverageRubricOverride: { minimumMappedBlockCoverage: 0.95, requireCompleteTokens: true, requireEnumeratedGaps: true }
  }
};

const projectInput = {
  projectId: "capture-test",
  name: "Capture Test",
  mcpEndpointEnvVar: "CAPTURE_TEST_MCP_ENDPOINT",
  authMode: "none" as const,
  allowedTools: []
};

describe("project capture governance", () => {
  it("defaults new and legacy project records to an isolated zero-page policy", async () => {
    const repository = new MemoryProjectRepository();
    const created = await createProject(repository, projectCreateSchema.parse(projectInput));

    expect(created.capturePolicy).toEqual(DEFAULT_PROJECT_CAPTURE_POLICY);
    expect((await repository.get("capture-test"))?.capturePolicy).toEqual(DEFAULT_PROJECT_CAPTURE_POLICY);

    const legacy = { ...platformProjectConfig, projectId: "legacy-capture", name: "Legacy Capture" } as ProjectConnectionConfig;
    delete legacy.capturePolicy;
    const safe = toProjectSummary(legacy);
    expect(safe.capturePolicy).toEqual(DEFAULT_PROJECT_CAPTURE_POLICY);
    safe.capturePolicy.allowedCrawlOrigins.push("https://mutated.example");
    expect(resolveProjectCapturePolicy(legacy)).toEqual(DEFAULT_PROJECT_CAPTURE_POLICY);
  });

  it("validates, persists, and safely returns a per-project capture policy", async () => {
    expect(projectCreateSchema.safeParse({ ...projectInput, capturePolicy }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ capturePolicy: { ...capturePolicy, maxPages: 25_000 } }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ capturePolicy }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ capturePolicy: { ...capturePolicy, allowedCrawlOrigins: ["http://example.com"] } }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ capturePolicy: { ...capturePolicy, allowedCrawlOrigins: ["https://example.com/path"] } }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ capturePolicy: { ...capturePolicy, designReferences: [{ ...PLATFORM_CAPTURE_POLICY.designReferences[0], crawlAllowed: true }] } }).success).toBe(false);

    const repository = new MemoryProjectRepository();
    await createProject(repository, projectCreateSchema.parse(projectInput));
    const updated = await updateProject(repository, "capture-test", { capturePolicy });

    expect(updated.capturePolicy).toEqual(capturePolicy);
    expect((await repository.get("capture-test"))?.capturePolicy).toEqual(capturePolicy);
  });

  it("publishes the complete Zilberman policy only on the platform default and migrates stale platform records", async () => {
    expect(platformProjectConfig.capturePolicy).toEqual(PLATFORM_CAPTURE_POLICY);
    expect(PLATFORM_CAPTURE_POLICY).toMatchObject({
      maxPages: 20,
      allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
      allowedPathPrefixes: ["/"],
      sameOriginOnly: true,
      respectRobots: true,
      concurrency: 1,
      delayMs: 1500,
      authenticatedAccess: "prohibited",
      rights: { content: "retain_allowed_origin_content", media: "retain_referenced_allowed_origin_media" },
      fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
    });
    expect(PLATFORM_CAPTURE_POLICY.designReferences).toEqual([{
      origin: "https://prconsulting.net",
      purpose: "design_inspiration_only",
      crawlAllowed: false,
      contentReuse: "prohibited",
      mediaReuse: "prohibited"
    }]);

    const repository = new MemoryProjectRepository();
    const stale = structuredClone(platformProjectConfig);
    stale.definitionVersion = PLATFORM_DEFINITION_VERSION - 1;
    delete stale.capturePolicy;
    await repository.save(stale);
    expect((await repository.get("platform"))?.capturePolicy).toEqual(PLATFORM_CAPTURE_POLICY);
  });

  it("advertises the capture policy and its fail-closed default in the registration contract", () => {
    const contract = projectRegistrationContract();
    expect(contract.fields.capturePolicy).toMatchObject({ required: false, default: DEFAULT_PROJECT_CAPTURE_POLICY });
    expect(contract.fields.capturePolicy.note).toContain("denies all capture");
  });
});
