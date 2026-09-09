import { describe, expect, it } from "vitest";
import { isTenantApprovalHeld } from "../../../src/agent/tools/tenantInvoke.js";
import { CaptureRefusal, __test__ as captureEngineTest, type CaptureDeps } from "../../../src/agent/capture/captureEngine.js";
import { CloneRefusal, callProjectTool as cloneCallProjectTool, type CloneDeps } from "../../../src/agent/capture/cloneEngine.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { McpTransport } from "../../../src/agent/projects/mcpClient.js";

// W4-followup acceptance — a call the tenant is HOLDING for a human is not a call that failed.
//
// isTenantApprovalHeld / tenantApprovalHeldDetail (tenantInvoke.ts) are exercised directly, then at
// two of the four engine call sites that used to collapse a held verb into their generic refusal:
// captureEngine.callProjectTool and cloneEngine.callProjectTool. Both are proven on the SAME axis —
// the held case gets a NAMED refusal instead of the generic one, and the generic refusal still fires,
// unchanged, for a non-held failure — so the new branch is narrow.

describe("isTenantApprovalHeld", () => {
  it("is true for a requiresApproval refusal", () => {
    expect(isTenantApprovalHeld({ ok: false, requiresApproval: true })).toBe(true);
  });

  it("is true for a permission:needs_approval refusal", () => {
    expect(isTenantApprovalHeld({ ok: false, permission: "needs_approval" })).toBe(true);
  });

  it("is false for a successful result", () => {
    expect(isTenantApprovalHeld({ ok: true })).toBe(false);
  });

  it("is false for a plain failure that names no approval hold", () => {
    // A real CallToolResult also carries `error` and other fields isTenantApprovalHeld's own
    // parameter type does not name; routed through a typed variable rather than an inline literal so
    // TypeScript's excess-property check on object literals does not get in the way of the assertion.
    const genericFailure: { ok: boolean; error?: string } = { ok: false, error: "boom" };
    expect(isTenantApprovalHeld(genericFailure)).toBe(false);
  });
});

const PROJECT_ID = "tenant-held";
const ENDPOINT_ENV = "TENANT_HELD_MCP_ENDPOINT";
const TOKEN_ENV = "TENANT_HELD_MCP_TOKEN";

const configWith = (toolPolicies: Record<string, "allowed" | "blocked" | "needs_approval">): ProjectConnectionConfig =>
  ({
    projectId: PROJECT_ID,
    name: "Tenant Held",
    mcpEndpointEnvVar: ENDPOINT_ENV,
    tokenEnvVar: TOKEN_ENV,
    allowedTools: [],
    defaultToolPolicy: "allowed",
    toolPolicies,
    status: "active"
  }) as unknown as ProjectConnectionConfig;

const repositoryFor = (config: ProjectConnectionConfig): ProjectRepository => ({ get: async () => config }) as unknown as ProjectRepository;

const env = { [ENDPOINT_ENV]: "https://tenant-held.example/mcp", [TOKEN_ENV]: "t" } as unknown as NodeJS.ProcessEnv;

describe("captureEngine.callProjectTool — held verb surfaces a named refusal", () => {
  it("throws tenant_verb_needs_approval, never the generic project_tool_call_failed, and never touches transport", async () => {
    const config = configWith({ registry_get: "needs_approval" });
    let transportCalls = 0;
    const transport: McpTransport = async () => {
      transportCalls += 1;
      throw new Error("transport must not be reached for a held verb");
    };
    const deps: CaptureDeps = { projectRepository: repositoryFor(config), tenantContext: { caller: "engine", adapterDeps: { env, transport } } };

    await expect(captureEngineTest.callProjectTool(PROJECT_ID, "registry_get", { registry: "component" }, deps)).rejects.toMatchObject({
      code: "tenant_verb_needs_approval"
    });
    expect(transportCalls).toBe(0);
  });

  it("keeps the original generic refusal for a non-held failure", async () => {
    const config = configWith({ registry_get: "allowed" });
    const transport: McpTransport = async () => {
      throw new Error("network is down");
    };
    const deps: CaptureDeps = { projectRepository: repositoryFor(config), tenantContext: { caller: "engine", adapterDeps: { env, transport } } };

    await expect(captureEngineTest.callProjectTool(PROJECT_ID, "registry_get", { registry: "component" }, deps)).rejects.toMatchObject({
      code: "project_tool_call_failed"
    });
  });
});

describe("cloneEngine.callProjectTool — held verb never enters the object_checkout retry loop", () => {
  it("throws tenant_verb_needs_approval on the first attempt and never calls the wire", async () => {
    const config = configWith({ object_checkout: "needs_approval" });
    let transportCalls = 0;
    const transport: McpTransport = async () => {
      transportCalls += 1;
      throw new Error("transport must not be reached for a held verb");
    };
    const deps: CloneDeps = { projectRepository: repositoryFor(config), tenantContext: { caller: "engine", adapterDeps: { env, transport } } };

    await expect(cloneCallProjectTool(PROJECT_ID, "object_checkout", { objectType: "site", objectId: "site_x" }, deps)).rejects.toMatchObject({
      code: "tenant_verb_needs_approval"
    });
    // A held call is refused identically on every attempt — it is never a lock a retry could clear.
    // Proving zero transport calls is the same proof that it never entered the retry loop.
    expect(transportCalls).toBe(0);
  });

  it("keeps the original generic refusal for a non-held object_checkout failure", async () => {
    const config = configWith({ object_checkout: "allowed" });
    const transport: McpTransport = async () => {
      throw new Error("network is down");
    };
    const deps: CloneDeps = { projectRepository: repositoryFor(config), tenantContext: { caller: "engine", adapterDeps: { env, transport } } };

    await expect(cloneCallProjectTool(PROJECT_ID, "object_checkout", { objectType: "site", objectId: "site_x" }, deps)).rejects.toMatchObject({
      code: "project_tool_call_failed"
    });
  });
});

// Both refusal classes carry the same shape this suite relies on: a named `code` and a message that
// states the operator's actual next step (tenantApprovalHeldDetail), not a transport diagnosis.
describe("the held refusal names the operator's actual next step", () => {
  it("CaptureRefusal's message points at the project's tool policy, not a transport failure", async () => {
    const config = configWith({ site_apply_theme: "needs_approval" });
    const deps: CaptureDeps = { projectRepository: repositoryFor(config) };
    try {
      await captureEngineTest.callProjectTool(PROJECT_ID, "site_apply_theme", {}, deps);
      throw new Error("expected callProjectTool to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureRefusal);
      const message = (error as Error).message;
      expect(message).toContain("needs approval");
      expect(message).toContain(PROJECT_ID);
      expect(message).toContain("site_apply_theme");
    }
  });

  it("CloneRefusal's message points at the project's tool policy, not a transport failure", async () => {
    const config = configWith({ site_apply_theme: "needs_approval" });
    const deps: CloneDeps = { projectRepository: repositoryFor(config) };
    try {
      await cloneCallProjectTool(PROJECT_ID, "site_apply_theme", { siteId: "site_x", themeId: "thm_1" }, deps);
      throw new Error("expected callProjectTool to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CloneRefusal);
      const message = (error as Error).message;
      expect(message).toContain("needs approval");
      expect(message).toContain(PROJECT_ID);
      expect(message).toContain("site_apply_theme");
    }
  });
});
