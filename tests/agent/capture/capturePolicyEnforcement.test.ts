import { describe, expect, it, vi, afterEach } from "vitest";
import {
  __test__ as captureInternals,
  captureCrawlStep,
  captureEmitStep,
  captureMapStep,
  captureScoreStep,
  captureThemeStep,
  CaptureRefusal,
  type RegeneratedBody
} from "../../../src/agent/capture/captureEngine.js";
import { EmissionError, buildEmissionPlan, type EmissionPlan } from "../../../src/agent/capture/engine/emit.mjs";
import { extractTheme } from "../../../src/agent/capture/engine/theme.mjs";
import { mapSnapshot } from "../../../src/agent/capture/engine/map.mjs";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectCapturePolicy, ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixture = async (name: string) => JSON.parse(await readFile(fileURLToPath(new URL(`../../fixtures/capture/${name}`, import.meta.url)), "utf8"));

const AUTHORIZED_POLICY: ProjectCapturePolicy = {
  maxPages: 20,
  allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
  allowedPathPrefixes: ["/"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 0,
  authenticatedAccess: "prohibited",
  rights: { content: "retain_allowed_origin_content", media: "prohibited" },
  designReferences: [],
  fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
};

const projectConfig = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => ({
  projectId: "zb-test",
  name: "Zilberman capture test",
  mcpEndpointEnvVar: "ZB_TEST_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  defaultToolPolicy: "allowed",
  contentContract: { contentContract: "content_source.v1" },
  capturePolicy: structuredClone(AUTHORIZED_POLICY),
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
  status: "active",
  ...overrides
});

const stubRepository = (config?: ProjectConnectionConfig): ProjectRepository => ({
  list: async () => (config ? [config] : []),
  get: async (projectId: string) => (config && config.projectId === projectId ? config : undefined),
  save: async (value) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} } as never)
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZB_TEST_MCP_ENDPOINT;
});

// T12.9 — every capture.* step enforces resolveProjectCapturePolicy bounds SERVER-SIDE. The
// registry's deny-all default (or a missing policy on a legacy record) refuses every stage; nothing
// a caller passes can widen a bound.
describe("capture policy enforcement (server-side, every step)", () => {
  it("refuses every stage for a project whose policy is the deny-all default", async () => {
    const deps = { projectRepository: stubRepository(projectConfig({ capturePolicy: undefined })) };
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    for (const attempt of [
      () => captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: "https://www.zilbermanfilmfoundation.com/" }, deps),
      () => captureMapStep({ targetProjectId: "zb-test", snapshot }, deps),
      () => captureThemeStep({ targetProjectId: "zb-test", snapshot }, deps),
      () => captureEmitStep({ targetProjectId: "zb-test", mapping: {}, theme: {} }, deps),
      () => captureScoreStep({ targetProjectId: "zb-test", snapshot, mapping: {}, theme: {} }, deps)
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "capture_policy_denies" });
    }
  });

  it("refuses an unknown project and a disabled project", async () => {
    await expect(captureCrawlStep({ targetProjectId: "nobody", sourceUrl: "https://www.zilbermanfilmfoundation.com/" }, { projectRepository: stubRepository() }))
      .rejects.toMatchObject({ code: "unknown_project" });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: "https://www.zilbermanfilmfoundation.com/" }, { projectRepository: stubRepository(projectConfig({ status: "disabled" })) }))
      .rejects.toMatchObject({ code: "project_disabled" });
  });

  it("refuses a source URL outside the policy's origins/prefixes — bounds are ceilings, not suggestions", async () => {
    const deps = { projectRepository: stubRepository(projectConfig()) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: "https://prconsulting.net/" }, deps))
      .rejects.toMatchObject({ code: "capture_source_out_of_policy" });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: "http://www.zilbermanfilmfoundation.com/" }, deps))
      .rejects.toMatchObject({ code: "capture_source_invalid" });
  });

  it("refuses lowering the mapping confidence threshold below the engine default (never loosen)", async () => {
    const deps = { projectRepository: stubRepository(projectConfig()) };
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    await expect(captureMapStep({ targetProjectId: "zb-test", snapshot, threshold: 0.5 }, deps))
      .rejects.toMatchObject({ code: "capture_threshold_below_default" });
  });
});

describe("capture emission stays drafts-only", () => {
  const planFor = async (): Promise<{ plan: EmissionPlan; mapping: unknown; theme: unknown }> => {
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    const mapping = mapSnapshot(snapshot);
    const theme = extractTheme(snapshot).body;
    return { plan: buildEmissionPlan({ target: "zb-test", mapping, theme }), mapping, theme };
  };

  it("the dry-run default makes no MCP call and carries the forbidden-verb set", async () => {
    const deps = { projectRepository: stubRepository(projectConfig()) };
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);
    const { mapping, theme } = await planFor();
    const envelope = await captureEmitStep({ targetProjectId: "zb-test", mapping, theme }, deps);
    expect(envelope.live).toBe(false);
    expect(envelope.plan.forbiddenVerbs).toEqual(["deploy", "object_publish", "release_to_production", "trigger_netlify_build"]);
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("the adapter-backed transport refuses every forbidden verb BEFORE any transport", async () => {
    const { plan } = await planFor();
    const transport = captureInternals.buildAdapterTransport("zb-test", new Set(plan.forbiddenVerbs), { projectRepository: stubRepository(projectConfig()) });
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);
    for (const verb of plan.forbiddenVerbs) {
      await expect(transport.call(verb, {})).rejects.toBeInstanceOf(EmissionError);
    }
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("quarantines (never keeps) a create whose response is not a verified draft", async () => {
    process.env.ZB_TEST_MCP_ENDPOINT = "https://zb-test.example/mcp";
    const deps = { projectRepository: stubRepository(projectConfig()) };
    const { mapping, theme } = await planFor();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const name = request.params?.name;
      const data =
        name === "object_inventory" && request.params?.arguments?.object_type === "site"
          ? { objects: [{ object_type: "site", object_id: "site_zb", status: "active" }] }
          : name === "object_inventory"
            ? { objects: [] }
            : name === "object_contract"
              ? { contract: { creation_policy: { agents: "open" } } }
              : name === "object_validate"
                ? { summary: { eligible: true } }
                : name === "object_create"
                  // NOT a draft: published_time is set. The emitter must quarantine, never keep it.
                  ? { record: { object_id: String(request.params?.arguments?.requested_id ?? "obj"), publication: { published_time: "2026-08-13T00:00:00Z" } } }
                  : {};
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data } } }) } as unknown as Response;
    }));
    const envelope = await captureEmitStep({ targetProjectId: "zb-test", mapping, theme, live: true }, deps);
    const report = envelope.report as { createdObjects: Array<{ draftVerified: boolean }>; quarantines: Array<{ reason: string }> };
    expect(report.createdObjects.length).toBeGreaterThan(0);
    expect(report.createdObjects.every((object) => object.draftVerified === false)).toBe(true);
    expect(report.quarantines.some((entry) => entry.reason === "not_draft_only_response")).toBe(true);
  });

  it("rights that prohibit extracted copy REQUIRE a regenerated body per operation; a missing one quarantines the operation", async () => {
    const { plan } = await planFor();
    const adapter = captureInternals.buildRegenerationAdapter(plan, [] as RegeneratedBody[]);
    const pageCreate = plan.creates.find((create) => create.objectType === "page")!;
    await expect(adapter.regenerateBody({ body: structuredClone(pageCreate.body), objectType: "page", target: "zb-test", source: plan.source }))
      .rejects.toBeInstanceOf(EmissionError);
    const regenerated: RegeneratedBody[] = [{ requestedId: pageCreate.requestedId, objectType: "page", body: { ...structuredClone(pageCreate.body), title: "Regenerated title" } }];
    const supplied = captureInternals.buildRegenerationAdapter(plan, regenerated);
    await expect(supplied.regenerateBody({ body: structuredClone(pageCreate.body), objectType: "page", target: "zb-test", source: plan.source }))
      .resolves.toMatchObject({ title: "Regenerated title" });
  });

  it("wraps engine refusals in typed CaptureRefusal codes", async () => {
    const deps = { projectRepository: stubRepository(projectConfig()) };
    await expect(captureEmitStep({ targetProjectId: "zb-test", mapping: { schemaVersion: "wrong" }, theme: {} }, deps))
      .rejects.toBeInstanceOf(CaptureRefusal);
  });
});
