import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { visualStandardIdFor } from "../../../src/agent/workspace/visualStandardIds.js";

// FIX (chat-recovery) — "NO HOUSE STANDARD YET" IS A STATE, NOT A FAILURE, AND IT REACHES THE NODE
// AS ONE. End to end, through the real dispatch, because the defect this pins was never visible in
// the prefetch alone: `visualStandard.houseId` being undefined is what a node actually receives, and
// undefined said two different things at once — "this site has none" and "I could not find out".
//
// The live incident it comes from: a fresh chat on a tenant whose house look had never been written
// ran object_list(visual_standard) (correctly empty — that tenant's backfill has not run), then
// emitted a step labelled "Read visual_standard vis_site_drlurie" and called object_get on it. The
// convention is `vis_<site slug>` — the site object `site_drlurie` names `vis_drlurie` — so
// `vis_site_drlurie` is an id no writer in either repo can mint, and a brand-new tenant got a red
// "object get failed — Object record not found" card. Two defects, neither of them object_get's: an
// id assembled by a model, and an ordinary absence rendered as a breakage.
const ENDPOINT = "https://dr-lurie.example/mcp";

const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 10) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

const startWriterRun = async (note: string) => {
  const store = new RepositoryManager().getExecutionRepository();
  const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", workflowId: "visual_identity", input: { mode: "house", brief: note } }, store);
  const run = await drive(started.runId, store, "brand_imagery_writer");
  return { run, state: run.nodes.find((node) => node.nodeId === "brand_imagery_writer")! };
};

describe("a site with no house visual standard reaches the writer as a positive 'none'", () => {
  // The un-backfilled tenant's real shape: a site object with no visual-standard reference on it, and
  // a visual_standard list that answers, and answers empty.
  let visualStandardItems: unknown[] = [];
  let listOk = true;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    visualStandardItems = [];
    listOk = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const tool = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (!listOk && tool === "object_list" && args.object_type === "visual_standard") {
        return { ok: false, status: 503, text: async () => "unavailable", json: async () => ({}) } as unknown as Response;
      }
      const result =
        request.method !== "tools/call"
          ? {}
          : tool === "object_get" && args.object_type === "site"
            ? { structuredContent: { object: { body: { brandTokens: { colors: { primary: "#2E5C42" } } } } } }
            : tool === "object_list" && args.object_type === "visual_standard"
              ? { structuredContent: { items: visualStandardItems } }
              : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("says 'none' rather than leaving an undefined that reads as 'go and find it'", async () => {
    const { state } = await startWriterRun("no house standard yet");

    const input = state.input as { prefetchedContract?: { visualStandard?: Record<string, unknown> } };
    const visualStandard = input.prefetchedContract?.visualStandard;
    expect(visualStandard).toBeDefined();
    // THE ACCEPTANCE: the node can tell "this site has no house standard" from "I was not told".
    expect(visualStandard!.houseStatus).toBe("none");
    expect(visualStandard!.houseId).toBeUndefined();
    // And it is handed the id one WOULD take, derived by the same rule the materializer writes with,
    // so it never has to assemble one — and what it is handed is not the id the incident guessed.
    expect(visualStandard!.derivedHouseId).toBe(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "house" }));
    expect(visualStandard!.derivedHouseId).toBe("vis_drlurie");
    expect(visualStandard!.derivedHouseId).not.toBe("vis_site_drlurie");

    // Absence is a NAMED run-visible degradation, exactly like site_brand_tokens_absent beside it —
    // never a blocked node and never an error card.
    expect(state.status).not.toBe("blocked");
    expect(state.warnings ?? []).toContain("site_prefetch_degraded:visual_standard_house_absent");
  });

  it("says 'present' with the real id, and warns about nothing, once the site has one", async () => {
    visualStandardItems = [{ object_id: "vis_drlurie", body: { kind: "house", label: "House standard" } }];
    const { state } = await startWriterRun("house standard exists");

    const input = state.input as { prefetchedContract?: { visualStandard?: Record<string, unknown> } };
    expect(input.prefetchedContract?.visualStandard).toMatchObject({ houseStatus: "present", houseId: "vis_drlurie", derivedHouseId: "vis_drlurie" });
    expect(state.warnings ?? []).not.toContain("site_prefetch_degraded:visual_standard_house_absent");
  });

  it("says 'unknown', not 'none', when the list that would have proved it never answered", async () => {
    listOk = false;
    const { state } = await startWriterRun("list unreachable");

    const input = state.input as { prefetchedContract?: { visualStandard?: Record<string, unknown> } };
    // Saying "none" here would invite an offer to write a standard that may already exist, against a
    // site nobody successfully read. The derived id still travels; it is never evidence of existence.
    expect(input.prefetchedContract?.visualStandard).toMatchObject({ houseStatus: "unknown", derivedHouseId: "vis_drlurie" });
    expect(input.prefetchedContract?.visualStandard?.houseId).toBeUndefined();
    const warnings = state.warnings ?? [];
    expect(warnings).toContain("site_prefetch_degraded:visual_standard_list_unreachable");
    expect(warnings).not.toContain("site_prefetch_degraded:visual_standard_house_absent");
  });
});

// The prompt half. The contract can only be read as intended if the consuming prompt is told which
// field to read — the incident's node had `houseId` and no instruction, and inferred a lookup.
describe("brand_imagery_writer's prompt names the tri-state and forbids assembling an id", () => {
  it("tells the writer to read houseStatus, and never to build a vis_ id", async () => {
    const { visualIdentityNodes } = await import("../../../src/agent/workspace/visualIdentityNodes.js");
    const writer = visualIdentityNodes.find((node) => node.id === "brand_imagery_writer")!;
    expect(writer.prompt).toContain("visualStandard.houseStatus");
    for (const state of ["'present'", "'none'", "'unknown'"]) expect(writer.prompt).toContain(state);
    expect(writer.prompt).toContain("visualStandard.derivedHouseId");
    expect(writer.prompt).toMatch(/never assemble a `vis_` id/i);
    expect(writer.prompt).toMatch(/NOT evidence that the object exists/i);
  });
});
