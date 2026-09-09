import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenTenantVerbError, UNATTRIBUTED_NODE_ID, UNATTRIBUTED_RUN_ID, invokeTenantReadTool, invokeTenantTool, tenantCallToolFor } from "../../../src/agent/tools/tenantInvoke.js";
import { ProjectMcpAdapter } from "../../../src/agent/projects/projectMcpAdapter.js";
import { FORBIDDEN_PROJECT_VERBS, PROJECT_VERB_AUTHORIZED_NODE_IDS } from "../../../src/agent/tools/forbiddenProjectVerbs.js";
import { READ_TOOL_ALLOWLIST } from "../../../src/agent/projects/projectMcpAdapter.js";
import { getRepositoryManager, repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { flushToolExecutionLedger } from "../../../src/agent/tools/toolExecutionLedger.js";
import { BlobToolExecutionRepository } from "../../../src/agent/repository/blobs/BlobToolExecutionRepository.js";
import type { McpTransport } from "../../../src/agent/projects/mcpClient.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// ACCEPTANCE — W3.2.1 (2026-09-09). The choke point every tenant call passes through.
//
// The bar this wave was given is "behaviour byte-identical", so the first thing pinned here is that
// a call through the choke point returns EXACTLY what the same call made directly against the adapter
// returns — same object, field for field, unwrapped and unannotated. Those results are embedded
// verbatim in run records; if this equality holds, the run snapshot cannot move.
//
// Everything after that is what the choke point ADDS: one durable record per call, naming the caller
// and the route, indexed by run AND by node, written through a writer that cannot throw.

const config: ProjectConnectionConfig = {
  projectId: "tenant-x",
  name: "Tenant X",
  mcpEndpointEnvVar: "TENANT_X_MCP_ENDPOINT",
  tokenEnvVar: "TENANT_X_MCP_TOKEN",
  allowedTools: [],
  defaultToolPolicy: "allowed",
  status: "active"
} as unknown as ProjectConnectionConfig;

const env = { TENANT_X_MCP_ENDPOINT: "https://tenant-x.example/mcp", TENANT_X_MCP_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const okTransport: McpTransport = async (_endpoint, init) => jsonResponse({ jsonrpc: "2.0", id: JSON.parse(init.body as string).id, result: { structuredContent: { object_id: "obj_1" } } });
const adapterDeps = { env, transport: okTransport };

// Ledger writes are started off the caller's clock (toolExecutionLedger), so a reader flushes first
// — exactly as the MCP read tools do. Reading without it would pass or fail on scheduling luck.
const ledger = () => repositoryManager.getToolExecutionRepository();
const readLedger = async (filters: Parameters<ReturnType<typeof ledger>["list"]>[0] = {}) => {
  await flushToolExecutionLedger();
  return ledger().list(filters);
};

beforeEach(() => {
  resetRepositoryManager();
});

describe("W3.2.1 — the call itself is unchanged", () => {
  it("returns exactly what a direct adapter call returns", async () => {
    const direct = await new ProjectMcpAdapter(config, adapterDeps).callTool("object_get", { object_id: "obj_1" });
    const through = await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "object_get", caller: "engine", runId: "run_1", nodeId: "clone_intake",
      routeId: "clone_stage", phaseId: "intake", args: { object_id: "obj_1" }
    });
    expect(through).toEqual(direct);
    // Specifically: no toolExecutionId, no wrapper, no extra key. A caller that spreads this into a
    // stage output must produce the same bytes it produced before the choke point existed.
    expect(Object.keys(through).sort()).toEqual(Object.keys(direct).sort());
  });

  it("keeps the adapter's read-only allowlist as the authority on the read path", async () => {
    const refused = await invokeTenantReadTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "object_create", caller: "engine", runId: "run_1", nodeId: "n"
    });
    expect(refused.ok).toBe(false);
    expect((refused as { code?: string }).code).toBe("read_tool_operation_not_permitted");
    // ...and the refusal is still recorded: a call that never reached the wire is still a call.
    expect((await readLedger({ runId: "run_1" })).map((record) => record.toolId)).toEqual(["object_create"]);
  });
});

describe("W3.2.1 — one durable record per call, on both axes", () => {
  it("records caller, routeId, durationMs and outcome, and finds it by run and by node", async () => {
    await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "site_apply_theme", caller: "engine", runId: "run_2", nodeId: "theme_bind",
      routeId: "clone_stage", phaseId: "theme_bind", args: { theme: "t" }
    });

    const byRun = await readLedger({ runId: "run_2" });
    const byNode = await readLedger({ nodeId: "theme_bind" });
    expect(byRun).toHaveLength(1);
    expect(byNode).toEqual(byRun);

    const [record] = byRun;
    expect(record.caller).toBe("engine");
    expect(record.routeId).toBe("clone_stage");
    expect(record.projectId).toBe("tenant-x");
    expect(record.status).toBe("success");
    expect(typeof record.durationMs).toBe("number");
    // The manifest DOES list site_apply_theme for the theme_bind stage, so nothing is flagged.
    expect(record.engineVerbUnlisted).toBeUndefined();
  });

  it("filters by caller and routeId, which is what makes an engine call findable at all", async () => {
    const engine = { projectId: config.projectId, project: config, adapterDeps, caller: "engine" as const, runId: "run_3" };
    await invokeTenantTool({ ...engine, toolId: "object_get", nodeId: "clone_intake", routeId: "clone_stage", phaseId: "intake" });
    await invokeTenantTool({ ...engine, toolId: "object_get", nodeId: "article_body", caller: "model" });

    expect(await readLedger({ runId: "run_3", caller: "engine" })).toHaveLength(1);
    expect(await readLedger({ runId: "run_3", caller: "model" })).toHaveLength(1);
    expect(await readLedger({ runId: "run_3", routeId: "clone_stage" })).toHaveLength(1);
  });

  it("records an unattributed call under a named sentinel rather than dropping it", async () => {
    await invokeTenantTool({ projectId: config.projectId, project: config, adapterDeps, toolId: "object_inventory", caller: "engine" });
    const [record] = await readLedger({ runId: UNATTRIBUTED_RUN_ID });
    expect(record.nodeId).toBe(UNATTRIBUTED_NODE_ID);
  });

  it("does not fail the tenant call when the ledger write fails", async () => {
    // `repositoryManager` is a Proxy facade; the spy goes on the manager it forwards to.
    const broken = { record: async () => { throw new Error("store down"); } };
    vi.spyOn(getRepositoryManager(), "getToolExecutionRepository").mockReturnValue(broken as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps, toolId: "object_get", caller: "engine", runId: "run_4", nodeId: "n"
    });
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("W3.2.1 — FORBIDDEN_PROJECT_VERBS, one rule for both callers", () => {
  // The rule the model path already had, now evaluated in one place for both. It is a NO-OP today in
  // both directions, and that is the property worth pinning: AGENTS.md invariant 4 says only
  // publish_executor speaks object_publish and only release_executor speaks release_to_production
  // from engine code, and both are in the exemption set. A future route that starts speaking a
  // publish verb from a third node fails here instead of publishing quietly.
  // The rule is enforced on the WRITE entry point only. That is safe precisely because the read
  // entry point's own authority is strictly narrower, and this is the assertion that keeps it so: if
  // someone ever adds a forbidden verb to the read allowlist, this fails rather than opening a path
  // that skips the rule.
  it("keeps the read allowlist and the forbidden set disjoint", () => {
    expect(READ_TOOL_ALLOWLIST.filter((operation) => FORBIDDEN_PROJECT_VERBS.has(operation))).toEqual([]);
  });

  it("keeps the two authorized publish nodes authorized", () => {
    expect([...PROJECT_VERB_AUTHORIZED_NODE_IDS].sort()).toEqual(["publish_executor", "release_executor"]);
  });

  it("refuses object_publish from an unauthorized node, whichever caller asks", async () => {
    for (const caller of ["model", "engine"] as const) {
      await expect(invokeTenantTool({
        projectId: config.projectId, project: config, adapterDeps,
        toolId: "object_publish", caller, runId: "run_5", nodeId: "article_body"
      })).rejects.toBeInstanceOf(ForbiddenTenantVerbError);
    }
    const denied = await readLedger({ runId: "run_5" });
    expect(denied).toHaveLength(2);
    expect(denied.every((record) => record.status === "denied" && record.errorCode === "publish_verb_not_permitted")).toBe(true);
  });

  it("lets the authorized nodes through", async () => {
    const published = await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "object_publish", caller: "engine", runId: "run_6", nodeId: "publish_executor"
    });
    expect(published.ok).toBe(true);
    const released = await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "release_to_production", caller: "engine", runId: "run_6", nodeId: "release_executor", routeId: "release_executor"
    });
    expect(released.ok).toBe(true);
  });

  // FAIL-OPEN ON MISSING INFORMATION. A call that cannot say which node it speaks for is allowed and
  // recorded, never refused: this wave may not make anything newly unpublishable.
  it("allows a forbidden verb when no nodeId is stated, and records it", async () => {
    const result = await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps, toolId: "object_publish", caller: "engine", runId: "run_7"
    });
    expect(result.ok).toBe(true);
    expect((await readLedger({ runId: "run_7" }))[0].nodeId).toBe(UNATTRIBUTED_NODE_ID);
  });
});

describe("W3.2.1 — the manifest check records, it does not gate", () => {
  it("flags an engine verb the route manifest does not list, and still makes the call", async () => {
    const result = await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      // clone_stage/intake declares object_get / object_inventory / registry_get. object_patch is not
      // on it — a real mismatch, and the honest response is to record it, not to break the clone.
      toolId: "object_patch", caller: "engine", runId: "run_8", nodeId: "clone_intake", routeId: "clone_stage", phaseId: "intake"
    });
    expect(result.ok).toBe(true);
    expect((await readLedger({ runId: "run_8" }))[0].engineVerbUnlisted).toBe(true);
  });

  it("says nothing about a route it has no manifest for", async () => {
    await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "object_patch", caller: "engine", runId: "run_9", nodeId: "publish_executor", routeId: "publish_executor"
    });
    // An absent manifest is not evidence of an unlisted verb. The publishing-tail routes have none.
    expect((await readLedger({ runId: "run_9" }))[0].engineVerbUnlisted).toBeUndefined();
  });

  // capture_conductor and clone_conductor dispatch the shared publishing tail through their OWN stage
  // switch, so a stage value like "publish_executor" arrives against the capture_stage manifest, which
  // declares no such phase. Falling back to the route's (absent) verb list there would answer [] and
  // flag object_publish as unlisted on every real publish — a false alarm on the one path that must
  // never cry wolf. An undeclared phase is UNKNOWN, not empty.
  it("says nothing about a phase the manifest does not declare", async () => {
    await invokeTenantTool({
      projectId: config.projectId, project: config, adapterDeps,
      toolId: "object_publish", caller: "engine", runId: "run_12", nodeId: "publish_executor",
      routeId: "capture_stage", phaseId: "publish_executor"
    });
    expect((await readLedger({ runId: "run_12" }))[0].engineVerbUnlisted).toBeUndefined();
  });

  it("never flags a model call, whose authority is its grant and not a route", async () => {
    await invokeTenantTool({ projectId: config.projectId, project: config, adapterDeps, toolId: "object_patch", caller: "model", runId: "run_10", nodeId: "article_body" });
    expect((await readLedger({ runId: "run_10" }))[0].engineVerbUnlisted).toBeUndefined();
  });
});

describe("W3.2.1 — the durable store does not scan a prefix it does not need", () => {
  // The trap this programme has hit three times (W0.3, W1.4, W2.1): a read that looks scoped and
  // downloads everything under a prefix. Both of tool.list_executions' filters are KEYS here, so the
  // assertion is on what the store was asked to list, not merely on what came back.
  const store = () => {
    const blobs = new Map<string, unknown>();
    const listed: string[] = [];
    return {
      listed,
      blobs,
      client: {
        setJSON: async (key: string, value: unknown) => { blobs.set(key, value); },
        get: async (key: string) => (blobs.has(key) ? blobs.get(key) : null),
        list: async ({ prefix }: { prefix: string }) => {
          listed.push(prefix);
          return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
        },
        delete: async (key: string) => { blobs.delete(key); }
      }
    };
  };

  it("writes both indexes and reads the narrow prefix for each filter", async () => {
    const double = store();
    const repository = new BlobToolExecutionRepository(double.client as never);
    await repository.record({
      toolExecutionId: "tex_1", runId: "run_a", nodeId: "theme_bind", toolId: "site_apply_theme",
      startedAt: new Date().toISOString(), status: "success", inputSummary: {}, riskLevel: "admin",
      approvalStatus: "not_required", caller: "engine", routeId: "clone_stage"
    });
    expect([...double.blobs.keys()].sort()).toEqual([
      "tool_executions/by-node/theme_bind/tex_1.json",
      "tool_executions/by-run/run_a/tex_1.json"
    ]);

    expect(await repository.list({ runId: "run_a" })).toHaveLength(1);
    expect(await repository.list({ nodeId: "theme_bind" })).toHaveLength(1);
    expect(double.listed).toEqual(["tool_executions/by-run/run_a/", "tool_executions/by-node/theme_bind/"]);

    // A by-id lookup without a run is REFUSED rather than performed as a scan; with a run it is one
    // key read and lists nothing at all.
    expect(await repository.get("tex_1")).toBeUndefined();
    expect(await repository.get("tex_1", "run_a")).toMatchObject({ toolExecutionId: "tex_1" });
    expect(double.listed).toHaveLength(2);
  });
});

describe("W3.2.1 — the closure form the engine routes take", () => {
  it("routes an injected callTool(tool, args) through the choke point unchanged", async () => {
    const callTool = tenantCallToolFor({
      projectId: config.projectId, project: config, adapterDeps,
      caller: "engine", runId: "run_11", nodeId: "release_executor", routeId: "release_executor"
    });
    const result = await callTool("deploy_status", { commit: "abc" });
    expect(result.ok).toBe(true);
    expect((await readLedger({ runId: "run_11" }))[0]).toMatchObject({ toolId: "deploy_status", caller: "engine", routeId: "release_executor" });
  });
});
