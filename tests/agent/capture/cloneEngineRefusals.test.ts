import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneThemeBindStep, __test__ as cloneEngineTest, type CloneDeps } from "../../../src/agent/capture/cloneEngine.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T13.1 — the clone_conductor write laws that HARD RULES calls out by name, tested directly against
// cloneEngine.ts (mirroring the capture engine's own unit-level refusal coverage):
//   (f) FORBIDDEN_VERBS is refused BEFORE any wire call, for every clone stage — proven here at the
//       shared callProjectTool seam every write-capable stage goes through.
//   (g) theme_bind REFUSES, and does not partially execute, when the theme apply plan carries a
//       theme_not_total refusal.
describe("clone_conductor pre-transport refusals", () => {
  it("(f) refuses a forbidden verb before any wire call — the project is never even looked up", async () => {
    for (const verb of ["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]) {
      const getSpy = vi.fn();
      const deps: CloneDeps = { projectRepository: { get: getSpy } as unknown as ProjectRepository };
      await expect(cloneEngineTest.callProjectTool("some-target", verb, {}, deps)).rejects.toMatchObject({ code: "forbidden_verb" });
      expect(getSpy, `${verb} must never reach the project repository, let alone the wire`).not.toHaveBeenCalled();
    }
  });

  it("(f) every FORBIDDEN_VERBS member clone_conductor's contract names is covered", () => {
    expect([...cloneEngineTest.FORBIDDEN_VERBS].sort()).toEqual(["deploy", "object_publish", "release_to_production", "trigger_netlify_build"]);
  });
});

const TARGET = "theme-refusal-target";
const TARGET_ENDPOINT = "https://theme-refusal-target.example/mcp";
const SITE_ID = "site_x";
const THEME_ID = "thm_capture_x";

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("clone_conductor theme_bind totality refusal", () => {
  let calledVerbs: string[];

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

  beforeEach(async () => {
    resetRepositoryManager();
    calledVerbs = [];
    process.env.THEME_REFUSAL_TARGET_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calledVerbs.push(name);
        if (name === "object_get" && args.object_type === "site") {
          return respond(request.id, {
            record: { object_id: SITE_ID, body: { brandTokens: { colors: { "brand-primary": "#111111", "brand-secondary": "#222222" }, fonts: { body: "Inter, sans-serif" } } } }
          });
        }
        if (name === "object_get" && args.object_type === "theme") {
          return respond(request.id, { record: { object_id: THEME_ID, body: { tokens: {} } } });
        }
        // A totality refusal must stop the stage before ANY of these are ever reached — checkout,
        // patch, checkin, or site_apply_theme reaching the transport is the "partially executed" bug
        // the contract forbids.
        throw new Error(`Unexpected verb reached transport during a theme_not_total refusal: ${name}`);
      })
    );

    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Theme refusal acceptance target",
        mcpEndpointEnvVar: "THEME_REFUSAL_TARGET_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed"
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.THEME_REFUSAL_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("(g) refuses without executing any step when the proposal covers only some of the site's color slots", async () => {
    const intake = {
      artifact: "clone_intake.v1",
      target: TARGET,
      captureRunId: "run_capture_1",
      source: { snapshot: null, mapping: null, theme: null },
      inventory: { page: [], template: [], section_template: [], theme: [], navigation: [], site: { object_id: SITE_ID, status: "active" } },
      emitted: {
        report: { creates: [{ objectType: "theme", requestedId: THEME_ID }], createdObjects: [{ objectType: "theme", objectId: THEME_ID }] },
        pages: []
      },
      registry: { sectionTypes: {}, pageTypes: {} },
      policy: {}
    };
    // The site declares TWO color slots (brand-primary, brand-secondary); this proposal covers only
    // one, so validateThemeProposal's missingKeys is non-empty and buildThemeApplyPlan must refuse
    // rather than apply an exact-replace that would delete brand-secondary.
    const themeProposal = { colors: { "brand-primary": "#333333" }, fonts: {} };

    await expect(cloneThemeBindStep({ targetProjectId: TARGET, intake, themeProposal })).rejects.toMatchObject({ code: "theme_not_total" });

    // Belt-and-braces: nothing beyond the two read-only object_get calls (site + theme) ever reached
    // the wire — no checkout was taken (so nothing needed releasing), no patch, no site_apply_theme.
    expect(calledVerbs.sort()).toEqual(["object_get", "object_get"]);
  });

  it("refuses with the named policy reason, before any lock, when site_apply_theme is blocked by tool policy", async () => {
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: `${TARGET}-blocked`,
        name: "Theme policy-blocked target",
        mcpEndpointEnvVar: "THEME_REFUSAL_TARGET_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "blocked"
      })
    );
    const intake = {
      artifact: "clone_intake.v1",
      target: `${TARGET}-blocked`,
      captureRunId: "run_capture_1",
      source: { snapshot: null, mapping: null, theme: null },
      inventory: { page: [], template: [], section_template: [], theme: [], navigation: [], site: { object_id: SITE_ID, status: "active" } },
      emitted: {
        report: { creates: [{ objectType: "theme", requestedId: THEME_ID }], createdObjects: [{ objectType: "theme", objectId: THEME_ID }] },
        pages: []
      },
      registry: { sectionTypes: {}, pageTypes: {} },
      policy: {}
    };
    const themeProposal = { colors: { "brand-primary": "#333333", "brand-secondary": "#444444" }, fonts: {} };

    await expect(cloneThemeBindStep({ targetProjectId: `${TARGET}-blocked`, intake, themeProposal })).rejects.toMatchObject({ code: "clone_theme_apply_policy_blocked" });
    // The policy gate runs BEFORE any object_get / checkout — nothing reached the wire at all.
    expect(calledVerbs).toEqual([]);
  });
});
