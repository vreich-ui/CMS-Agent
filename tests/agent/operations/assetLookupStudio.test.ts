import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperationWorkflowBinding, UNBOUND_OPERATION_IMPLEMENTING_TASK } from "../../../src/agent/operations/operationWorkflowBindings.js";
import { applyWorkflowInitialInput } from "../../../src/agent/workspace/workflowInitialInput.js";
import { ASSET_LOOKUP_WORKFLOW_ID } from "../../../src/agent/workspace/assetLookupWorkflow.js";
import { listAssetLookupNodes } from "../../../src/agent/workspace/assetLookupNodes.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { buildAssetLookupBrief } from "../../../src/agent/capture/assetLookupBriefBuilder.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// =================================================================================================
// A5 (Milestone A remainder, runner 3c) — asset_lookup_adopt, end to end. OFFLINE: the tenant's MCP
// surface is a fetch double. The operation's own completion criterion is "exactly one asset resolved
// and adopted", so most of what is asserted here is what happens when that is NOT true.
// =================================================================================================

const TARGET = "zilberman-a5-assets";
const MCP_ENV_VAR = "ZILBERMAN_A5_ASSETS_MCP_ENDPOINT";
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);

type WireCall = { verb: string; args: Record<string, unknown> };
let wire: WireCall[];
let artifacts: Array<Record<string, unknown>>;
let metadataExtra: Record<string, unknown>;

const imageRow = (seed: string, tag: string, kind = "image"): Record<string, unknown> => ({
  blobKey: `image/req_${seed}/${SHA(seed)}.webp`,
  sizeBytes: 1024,
  sha256: SHA(seed),
  contentType: "image/webp",
  createdAtISO: "2026-09-01T10:00:00.000Z",
  artifactKind: kind,
  filename: `${seed}.webp`,
  tags: [tag],
  metadata: {}
});

const installFetchDouble = () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }) }) as unknown as Response;
    if (request.method !== "tools/call") return ok({});
    const verb = String(request.params?.name);
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    wire.push({ verb, args });
    if (verb === "search_artifacts") {
      const matched = artifacts.filter((row) => !args.tag || (Array.isArray(row.tags) && (row.tags as string[]).includes(String(args.tag))));
      return ok({ artifacts: matched, limit: args.limit ?? 50, cursor: "0", nextCursor: null, outcome: matched.length > 0 ? "ok" : "unknown_tag", remedy: matched.length > 0 ? undefined : `No artifact carries the tag "${String(args.tag)}".` });
    }
    if (verb === "get_artifact_metadata") {
      const row = artifacts.find((entry) => entry.sha256 === args.sha256) ?? {};
      return ok({ ...row, ...metadataExtra });
    }
    if (verb === "object_checkout") return ok({ lockToken: "lock_1", recordVersion: 7 });
    if (verb === "object_patch") return ok({ applied: true, recordVersion: 8 });
    if (verb === "object_checkin") return ok({ released: true });
    throw new Error(`Unexpected verb in this fixture: ${verb}`);
  }) as unknown as typeof fetch;
};

const nodes = new Map(listAssetLookupNodes().map((node) => [node.id, node]));

const runWith = (initialInput: Record<string, unknown>): WorkflowExecutionRecord =>
  ({ projectId: TARGET, workflowId: ASSET_LOOKUP_WORKFLOW_ID, initialInput, stageOutputs: {} }) as unknown as WorkflowExecutionRecord;

const stage = async (run: WorkflowExecutionRecord, nodeId: string) => {
  const node = nodes.get(nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  const outcome = await runCloneStage({ run, node, stage: nodeId as never });
  if (outcome.kind === "completed") run.stageOutputs[nodeId] = outcome.output;
  return outcome;
};

const briefRun = (brief: Record<string, unknown>) => runWith({ targetProjectId: TARGET, assetLookupBrief: { tenantId: TARGET, ...brief } });

const runBoth = async (brief: Record<string, unknown>) => {
  const run = briefRun(brief);
  const search = await stage(run, "asset_lookup_search");
  const adopt = await stage(run, "asset_lookup_adopt");
  return { run, search, adopt };
};

beforeEach(async () => {
  resetRepositoryManager();
  wire = [];
  artifacts = [imageRow("a", "hero")];
  metadataExtra = {};
  process.env[MCP_ENV_VAR] = `https://${TARGET}.example/mcp`;
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "A5 asset fixture", mcpEndpointEnvVar: MCP_ENV_VAR, authMode: "none", defaultToolPolicy: "allowed" })
  );
  installFetchDouble();
});

afterEach(() => {
  delete process.env[MCP_ENV_VAR];
  resetRepositoryManager();
});

describe("A5 — the binding", () => {
  it("asset_lookup_adopt is bound to a registered workflow, and nothing is left unbound", () => {
    expect(UNBOUND_OPERATION_IMPLEMENTING_TASK).toEqual({});
    expect(getOperationWorkflowBinding("asset_lookup_adopt")?.workflowId).toBe(ASSET_LOOKUP_WORKFLOW_ID);
  });

  it("a Platform-shaped dispatch is CONSTRUCTED into the nested brief, and a cross-tenant adopt target is refused before a run exists", () => {
    const built = applyWorkflowInitialInput(ASSET_LOOKUP_WORKFLOW_ID, {
      tenantId: TARGET,
      query: "hero",
      adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET, nodeId: "n_1" }
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.input as Record<string, unknown>).assetLookupBrief).toEqual({
      tenantId: TARGET,
      query: "hero",
      adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET, nodeId: "n_1" }
    });

    const crossTenant = buildAssetLookupBrief({ tenantId: TARGET, query: "hero", adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: "someone-else" } });
    expect(crossTenant.ok).toBe(false);
    if (crossTenant.ok) return;
    expect(crossTenant.code).toBe("asset_lookup_brief_adopt_target_cross_tenant");
  });
});

describe("A5 — the run", () => {
  it("resolves exactly one asset and adopts it through checkout -> patch -> checkin, releasing the lease", async () => {
    const { run, adopt } = await runBoth({ query: "hero", adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET, nodeId: "n_1" } });
    expect(adopt.kind).toBe("completed");
    if (adopt.kind !== "completed") return;

    const search = run.stageOutputs.asset_lookup_search as Record<string, unknown>;
    expect(search.outcome).toBe("resolved");
    expect(wire.map((call) => call.verb)).toEqual(["search_artifacts", "get_artifact_metadata", "object_checkout", "object_patch", "object_checkin"]);

    const patch = wire.find((call) => call.verb === "object_patch")!;
    expect(patch.args.object_type).toBe("content_item");
    expect(patch.args.lock_token).toBe("lock_1");
    expect(patch.args.expected_record_version).toBe(7);
    expect(patch.args.ops).toEqual([{ op: "update_node", node_id: "n_1", fields: { public: { media: { src: `/img/req_a/${SHA("a")}.webp` } } } }]);

    expect(adopt.output.outcome).toBe("adopted");
    expect(adopt.output.assetResolved).toBe(true);
  });

  it("several matches stop at asset_ambiguous — nothing is chosen and nothing is written", async () => {
    artifacts = [imageRow("a", "hero"), imageRow("b", "hero")];
    const { run, adopt } = await runBoth({ query: "hero", adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET, nodeId: "n_1" } });
    if (adopt.kind !== "completed") throw new Error("expected a completed adopt stage");
    expect((run.stageOutputs.asset_lookup_search as Record<string, unknown>).outcome).toBe("ambiguous");
    expect(adopt.output.outcome).toBe("not_adopted");
    expect((adopt.output.blocked as { code: string }).code).toBe("asset_ambiguous");
    expect(adopt.output.assetResolved).toBe(false);
    expect(wire.some((call) => call.verb.startsWith("object_"))).toBe(false);
  });

  it("no match reports platform's OWN remedy (a typo'd tag is not an empty tenant), and writes nothing", async () => {
    const { run, adopt } = await runBoth({ query: "nope", adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET, nodeId: "n_1" } });
    if (adopt.kind !== "completed") throw new Error("expected a completed adopt stage");
    const search = run.stageOutputs.asset_lookup_search as Record<string, unknown>;
    expect(search.outcome).toBe("none_found");
    expect((search.searchPlaneOutcome as { outcome: string }).outcome).toBe("unknown_tag");
    expect((adopt.output.blocked as { code: string }).code).toBe("asset_not_found");
    expect(wire.some((call) => call.verb.startsWith("object_"))).toBe(false);
  });

  it("a resolved asset with no adoption target is reported by name — a search is a legitimate run, not a silent no-op", async () => {
    const { adopt } = await runBoth({ query: "hero" });
    if (adopt.kind !== "completed") throw new Error("expected a completed adopt stage");
    expect((adopt.output.blocked as { code: string }).code).toBe("asset_adopt_target_unspecified");
    expect(adopt.output.assetResolved).toBe(false);
    expect(wire.some((call) => call.verb.startsWith("object_"))).toBe(false);
  });

  it("an adoption target with no nodeId is refused by name — this operation never invents a node", async () => {
    const { adopt } = await runBoth({ query: "hero", adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET } });
    if (adopt.kind !== "completed") throw new Error("expected a completed adopt stage");
    expect((adopt.output.blocked as { code: string }).code).toBe("asset_adopt_target_node_unspecified");
    expect(wire.some((call) => call.verb.startsWith("object_"))).toBe(false);
  });

  it("an assetKind the artifact plane cannot express is refused by name — never silently ignored, never approximated", async () => {
    const run = briefRun({ query: "hero", assetKind: "capture_artifact" });
    const outcome = await stage(run, "asset_lookup_search");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("asset_kind_filter_unsupported");
    expect(wire).toEqual([]); // the search was NOT run unfiltered in its place
  });

  it("stored_media narrows to media artifactKinds, which the plane genuinely states", async () => {
    artifacts = [imageRow("a", "hero"), { ...imageRow("b", "hero"), artifactKind: "document", contentType: "text/html" }];
    const { run } = await runBoth({ query: "hero", assetKind: "stored_media" });
    const search = run.stageOutputs.asset_lookup_search as Record<string, unknown>;
    expect(search.outcome).toBe("resolved");
    expect((search.resolved as { sha256: string }).sha256).toBe(SHA("a"));
  });

  it("a soft-deleted asset is refused by name rather than adopted into a live document", async () => {
    metadataExtra = { deletedAtISO: "2026-09-10T00:00:00.000Z" };
    const run = briefRun({ query: "hero", adoptInto: { objectType: "content_item", objectId: "ci_1", tenantId: TARGET, nodeId: "n_1" } });
    const outcome = await stage(run, "asset_lookup_search");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("asset_soft_deleted");
    expect(wire.some((call) => call.verb.startsWith("object_"))).toBe(false);
  });

  it("a run with no brief is refused by name at the dispatch boundary, and calls nothing", async () => {
    const run = runWith({ targetProjectId: TARGET });
    const outcome = await stage(run, "asset_lookup_search");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("asset_lookup_brief_missing");
    expect(wire).toEqual([]);
  });
});
