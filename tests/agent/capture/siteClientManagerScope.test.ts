import { describe, expect, it, vi } from "vitest";
import { SITE_CLIENT_MANAGER_TOOLS, SiteGenesisRefusal, verifyCmsAgentScopedCredential } from "../../../src/agent/capture/siteGenesis.js";

// The per-tenant scoped bearer's allowlist IS this constant: reconcileSiteClientManagerCredentials
// re-mints every registered tenant from it and retires the previous credential. When it lagged
// behind Platform's bridge, a rotation silently narrowed live tenants and admin chat's
// run_workspace_workflow began failing with an opaque 401 that named only "wrong token" and
// "wrong project" — neither of which was true.
//
// This test is the lock, and it is only as good as its list: PLATFORM_BRIDGE_CALLS has to be
// updated by hand whenever Platform adds a bridge call. It caught nothing in the 2026-08-24
// repeat because the new call sites (admin-request-activity.ts) were added on the Platform side
// and nobody came back here — which is exactly the failure this comment now exists to prevent.
describe("site client_manager scoped-token allowlist", () => {
  // Mirrors every ctx.cmsAgent.callTool(...) site in platform
  // packages/core/server/lib/agent/tools.ts, plus the two engine.ts calls.
  const PLATFORM_BRIDGE_CALLS = [
    "agent_resolve",
    "agent_converse",
    "workspace_get_nodes",
    "workflow_start_dry_run",
    "workflow_run_all",
    "workflow_get_run",
    // W19 activity card + approve button (platform admin-request-activity.ts):
    // the cost ledger behind the ETA, and the durable operator decision the
    // button records before it advances a run waiting at publication_controller.
    "workflow_get_run_cost",
    "workflow_publish_readiness",
    "workflow_publish_run",
    "workflow_set_operator_publish_decision"
  ];

  it("covers exactly Platform's bridge — no missing tool (401 at the door) and no extra (blast radius)", () => {
    expect([...SITE_CLIENT_MANAGER_TOOLS].sort()).toEqual([...PLATFORM_BRIDGE_CALLS].sort());
  });

  it("excludes release_workspace_run, which rides Platform's own operational bridge", () => {
    expect(SITE_CLIENT_MANAGER_TOOLS).not.toContain("release_workspace_run");
    expect(SITE_CLIENT_MANAGER_TOOLS).not.toContain("release_to_production");
  });

  it("grants no workspace-authoring or destructive tool", () => {
    for (const forbidden of ["workspace_update_node", "workspace_update_graph", "skill_delete", "project_delete", "workflow_run_node"]) {
      expect(SITE_CLIENT_MANAGER_TOOLS).not.toContain(forbidden);
    }
  });
});

describe("verifyCmsAgentScopedCredential", () => {
  const initializeOk = { ok: true, status: 200, json: async () => ({}), headers: { get: () => "sess-1" } };
  const listing = (names: string[]) => ({ ok: true, status: 200, json: async () => ({ result: { tools: names.map((name) => ({ name })) } }) });

  it("refuses a credential whose listing is missing a bridge tool — the case initialize alone cannot catch", async () => {
    // initialize is allowed for ANY scoped bearer regardless of allowlist, which is exactly how a
    // too-narrow token passed verification and reached production.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(initializeOk)
      .mockResolvedValueOnce(listing(["agent_resolve", "agent_converse"]));

    await expect(verifyCmsAgentScopedCredential("https://cms-agent.example/mcp", "tok", fetchImpl as never))
      .rejects.toMatchObject({ code: "cms_agent_credential_scope_incomplete" });
    await expect(verifyCmsAgentScopedCredential("https://cms-agent.example/mcp", "tok", vi.fn()
      .mockResolvedValueOnce(initializeOk)
      .mockResolvedValueOnce(listing(["agent_resolve", "agent_converse"])) as never))
      .rejects.toBeInstanceOf(SiteGenesisRefusal);
  });

  it("names the missing tools so the failure is actionable, and never leaks the token", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(initializeOk)
      .mockResolvedValueOnce(listing(["agent_resolve", "agent_converse"]));
    // The call resolves to void on success, so narrow explicitly rather than catching into a
    // `void | Error` union — and assert it actually rejected, so a silently-passing probe cannot
    // make this test vacuous.
    const error = await verifyCmsAgentScopedCredential("https://cms-agent.example/mcp", "super-secret-token", fetchImpl as never)
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error);
    expect(error, "an incomplete scope must reject").toBeInstanceOf(Error);
    expect(error!.message).toContain("workflow_start_dry_run");
    expect(error!.message).not.toContain("super-secret-token");
  });

  it("passes a credential whose listing covers the bridge", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(initializeOk)
      .mockResolvedValueOnce(listing([...SITE_CLIENT_MANAGER_TOOLS, "ping"]));
    await expect(verifyCmsAgentScopedCredential("https://cms-agent.example/mcp", "tok", fetchImpl as never)).resolves.toBeUndefined();
  });

  it("degrades rather than blocks: no session header, unreachable listing, or unparseable body all skip the probe", async () => {
    const noSession = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await expect(verifyCmsAgentScopedCredential("https://x/mcp", "tok", noSession as never)).resolves.toBeUndefined();
    expect(noSession).toHaveBeenCalledTimes(1);

    const listingThrows = vi.fn().mockResolvedValueOnce(initializeOk).mockRejectedValueOnce(new Error("network"));
    await expect(verifyCmsAgentScopedCredential("https://x/mcp", "tok", listingThrows as never)).resolves.toBeUndefined();

    const listingBad = vi.fn().mockResolvedValueOnce(initializeOk).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: {} }) });
    await expect(verifyCmsAgentScopedCredential("https://x/mcp", "tok", listingBad as never)).resolves.toBeUndefined();
  });

  it("still refuses when initialize itself is rejected", async () => {
    const rejected = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await expect(verifyCmsAgentScopedCredential("https://x/mcp", "tok", rejected as never))
      .rejects.toMatchObject({ code: "cms_agent_credential_verification_failed" });
  });
});
