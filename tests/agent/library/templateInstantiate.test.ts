import { describe, expect, it, vi } from "vitest";
import { instantiateLibraryTemplate } from "../../../src/agent/library/templateInstantiate.js";
import type { TemplateLibraryRecord } from "../../../src/agent/library/templateLibraryTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

const sectionTemplateRecord = (): TemplateLibraryRecord => ({
  templateId: "zilberman::section_template::req_hero",
  version: 1,
  objectType: "section_template",
  name: "Hero",
  recipe: { name: "Hero", blueprint: { type: "hero", data: {} } },
  sectionTypesUsed: ["hero"],
  provenance: { sourceUrl: "https://zilberman.example/", captureRunId: "run_1", engineHashes: {}, standardsPack: "unpinned-pending-T15.33" },
  sourceProjectId: "zilberman",
  contentHash: "hash",
  publishedAt: "2026-08-25T00:00:00.000Z"
});

const fakeProjectRepository = (config: ProjectConnectionConfig | undefined): ProjectRepository => ({
  get: vi.fn(async () => config),
  list: vi.fn(async () => (config ? [config] : [])),
  save: vi.fn(async (c) => c),
  delete: vi.fn(async () => false),
  health: vi.fn(async () => ({ backend: "memory", readable: true, writable: true }) as never)
});

const activeConfig = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig =>
  ({
    projectId: "target-tenant",
    name: "Target tenant",
    mcpEndpointEnvVar: "TARGET_TENANT_MCP_ENDPOINT",
    authMode: "none",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" } as never,
    publishingPolicy: {},
    status: "active",
    ...overrides
  }) as unknown as ProjectConnectionConfig;

describe("instantiateLibraryTemplate", () => {
  it("halts unconditionally on an explicit operator withheld, before touching the target at all", async () => {
    const callTool = vi.fn();
    const callReadTool = vi.fn();
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "target-tenant", record: sectionTemplateRecord(), operatorPublishDecision: "withheld" },
      { projectRepository: fakeProjectRepository(activeConfig()), adapter: { callReadTool, callTool } as never }
    );
    expect(outcome).toEqual({ ok: false, refusal: { code: "operator_withheld", reason: expect.stringContaining("withheld") } });
    expect(callReadTool).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses an unknown target project", async () => {
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "nope", record: sectionTemplateRecord() },
      { projectRepository: fakeProjectRepository(undefined) }
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "unknown_project" } });
  });

  it("refuses a disabled target project", async () => {
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "target-tenant", record: sectionTemplateRecord() },
      { projectRepository: fakeProjectRepository(activeConfig({ status: "disabled" })) }
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "project_disabled" } });
  });

  it("rejects with a capabilityBacklog entry, never coerced, when the target registry lacks a required section type", async () => {
    const callReadTool = vi.fn(async () => ({ ok: true, result: { definitions: [{ type: "faq" }] } }));
    const callTool = vi.fn();
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "target-tenant", record: sectionTemplateRecord() },
      { projectRepository: fakeProjectRepository(activeConfig()), adapter: { callReadTool, callTool } as never }
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "template_section_type_unsupported", capabilityBacklog: [{ sectionType: "hero", templateId: "zilberman::section_template::req_hero" }] }
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("calls the EXISTING object_instantiate_section_template verb — no new instantiation mechanism", async () => {
    const callReadTool = vi.fn(async () => ({ ok: true, result: { definitions: [{ type: "hero" }] } }));
    const callTool = vi.fn(async (verb: string) => ({ ok: true, tool: verb, result: { objectId: "page_new_1" } }));
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "target-tenant", record: sectionTemplateRecord() },
      { projectRepository: fakeProjectRepository(activeConfig()), adapter: { callReadTool, callTool } as never }
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.verb).toBe("object_instantiate_section_template");
    expect(callTool).toHaveBeenCalledWith("object_instantiate_section_template", expect.objectContaining({ templateId: "zilberman::section_template::req_hero", version: 1 }));
  });

  it("calls object_instantiate_template for a page-template record", async () => {
    const callReadTool = vi.fn(async () => ({ ok: true, result: { definitions: [{ type: "hero" }] } }));
    const callTool = vi.fn(async (verb: string) => ({ ok: true, tool: verb, result: {} }));
    const record: TemplateLibraryRecord = { ...sectionTemplateRecord(), objectType: "template" };
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "target-tenant", record },
      { projectRepository: fakeProjectRepository(activeConfig()), adapter: { callReadTool, callTool } as never }
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.verb).toBe("object_instantiate_template");
  });

  it("surfaces a needs_approval hold as operator_approval_absent, never silently succeeding", async () => {
    const callReadTool = vi.fn(async () => ({ ok: true, result: { definitions: [{ type: "hero" }] } }));
    const callTool = vi.fn(async () => ({ ok: false, requiresApproval: true, error: "Tool requires approval before it can run: object_instantiate_section_template" }));
    const outcome = await instantiateLibraryTemplate(
      { targetProjectId: "target-tenant", record: sectionTemplateRecord() },
      { projectRepository: fakeProjectRepository(activeConfig()), adapter: { callReadTool, callTool } as never }
    );
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "operator_approval_absent" } });
  });
});
