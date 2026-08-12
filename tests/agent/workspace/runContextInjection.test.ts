import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUN_CONTEXT_ENVELOPE_FIELDS,
  applyRunContextEnvelope,
  buildRunContext,
  readRunContext,
  renderRunContextInstruction
} from "../../../src/agent/workspace/runContext.js";
import { getWorkspaceNode, listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// W3 part 3 (determinism program, 2026-08-12). Six nodes echoed clientProjectId / clientObjectType /
// contractSource through their prompts and outputs — contract_intelligence, article_body,
// artifact_plan, publish_payload and publish_executor name all three in prompt AND output schema,
// publication_controller reads contractSource in its prompt. These are RUN facts the conductor
// already holds exactly; every echo is a chance for a model to retype one differently.
//
// This PR does not remove the fields from the schemas (a re-seed topology change). It removes the
// DEPENDENCE on model echo: the facts are injected once as run context, and the engine fills the
// output fields those schemas still declare.

const contractSource = { tool: "object_contract", fetchedAtISO: "2026-08-12T08:00:00.000Z", fingerprint: "fp_ctx" };

describe("buildRunContext — the run's facts, from the fetch that actually happened", () => {
  it("prefers THIS dispatch's prefetched contract over any node's stage output", () => {
    const context = buildRunContext({
      clientProjectId: "platform",
      reducedContract: { clientObjectType: "content_item", contractSource } as never,
      stageOutputs: { contract_intelligence: { clientObjectType: "contentItem", contractSource: { tool: "remembered" } } }
    });
    expect(context).toEqual({ clientProjectId: "platform", clientObjectType: "content_item", contractSource });
  });

  it("falls back to the deterministic contract_intelligence artifact when this node declared no prefetch", () => {
    const context = buildRunContext({
      clientProjectId: "platform",
      stageOutputs: { contract_intelligence: { clientObjectType: "content_item", contractSource } }
    });
    expect(context.clientObjectType).toBe("content_item");
    expect(context.contractSource).toEqual(contractSource);
  });

  it("invents nothing: a run that has not fetched a contract yet names no object type or source", () => {
    expect(buildRunContext({ clientProjectId: "platform", stageOutputs: {} })).toEqual({ clientProjectId: "platform" });
  });

  it("carries the PUBLISH request id from artifact_plan, not the run's platform join key", () => {
    const context = buildRunContext({ clientProjectId: "platform", stageOutputs: { artifact_plan: { requestId: "req_docs_lifecycle_20260812_01" } } });
    expect(context.requestId).toBe("req_docs_lifecycle_20260812_01");
  });
});

describe("renderRunContextInstruction — compact, and paid for once per turn", () => {
  it("states the facts and summarizes contractSource by provenance rather than inlining it", () => {
    const text = renderRunContextInstruction({ clientProjectId: "platform", clientObjectType: "content_item", contractSource, requestId: "req_x_20260812_01" });
    expect(text).toMatch(/clientProjectId: platform/);
    expect(text).toMatch(/clientObjectType: content_item/);
    expect(text).toMatch(/tool=object_contract/);
    expect(text).toMatch(/fingerprint=fp_ctx/);
    expect(text).toMatch(/req_x_20260812_01/);
    // The object itself travels in the input (one serialization), not in the per-turn instructions.
    expect(text).not.toMatch(/fetchedAtISO"/);
    expect(text.length).toBeLessThan(900);
  });

  it("says so plainly when a fact is not established yet, instead of implying one", () => {
    const text = renderRunContextInstruction({ clientProjectId: "platform" });
    expect(text).toMatch(/clientObjectType: not yet established/);
    expect(text).toMatch(/contractSource: not yet established/);
  });

  it("names the policies the engine has taken over, so the model does not spend its budget on them", () => {
    const text = renderRunContextInstruction({ clientProjectId: "platform", enginePolicies: ["Client-object validation is run BY THE ENGINE after you return."] });
    expect(text).toMatch(/Engine-owned for this dispatch/);
    expect(text).toMatch(/run BY THE ENGINE/);
    // A node the engine has taken nothing over for is told nothing extra.
    expect(renderRunContextInstruction({ clientProjectId: "platform" })).not.toMatch(/Engine-owned/);
  });

  it("renders nothing at all for a dispatch with no run context", () => {
    expect(renderRunContextInstruction(undefined)).toBe("");
    expect(readRunContext({ runContext: { clientProjectId: "platform" } })?.clientProjectId).toBe("platform");
    expect(readRunContext({ runContext: { clientProjectId: "" } })).toBeUndefined();
    expect(readRunContext("not an object")).toBeUndefined();
  });
});

describe("applyRunContextEnvelope — the engine echoes what the model used to retype", () => {
  const schema = getWorkspaceNode("article_body")!.outputSchema;
  const context = { clientProjectId: "platform", clientObjectType: "content_item", contractSource };

  it("fills the envelope fields a model omitted, on a node whose schema declares them", () => {
    const result = applyRunContextEnvelope({ artifact: "client_object.v1", summary: "s", body: { slug: "x" } }, context, schema);
    expect(result.filled.sort()).toEqual(["clientObjectType", "clientProjectId", "contractSource"]);
    expect(result.corrected).toEqual([]);
    expect(result.output).toMatchObject(context);
  });

  it("overwrites — and names — a value the model retyped differently from the run's own fact", () => {
    const emitted = { artifact: "client_object.v1", clientProjectId: "platform", clientObjectType: "contentItem", contractSource: { tool: "object_contract" } };
    const result = applyRunContextEnvelope(emitted, context, schema);
    expect(result.corrected.sort()).toEqual(["clientObjectType", "contractSource"]);
    expect(result.filled).toEqual([]);
    expect((result.output as { clientObjectType: string }).clientObjectType).toBe("content_item");
    // Copy-on-write: the model's own output object is never mutated under it.
    expect(emitted.clientObjectType).toBe("contentItem");
  });

  it("is a no-op — identity, not a copy — when the model already agreed with the run", () => {
    const emitted = { artifact: "client_object.v1", ...context };
    const result = applyRunContextEnvelope(emitted, context, schema);
    expect(result.output).toBe(emitted);
    expect(result.filled).toEqual([]);
    expect(result.corrected).toEqual([]);
  });

  it("never writes a field the node's own schema does not declare", () => {
    const inputTriage = getWorkspaceNode("input_triage")!;
    const result = applyRunContextEnvelope({ artifact: "content_source.v1", summary: "s" }, context, inputTriage.outputSchema);
    expect(result.output).not.toHaveProperty("clientObjectType");
    expect(result.filled).toEqual([]);
  });

  it("never fabricates a fact the run does not hold, so R-16 still fails an unfillable envelope", () => {
    const result = applyRunContextEnvelope({ artifact: "client_object.v1" }, { clientProjectId: "platform" }, schema);
    expect(result.output).toMatchObject({ clientProjectId: "platform" });
    expect(result.output).not.toHaveProperty("clientObjectType");
    expect(result.output).not.toHaveProperty("contractSource");
  });

  it("covers exactly the nodes that echo these fields today", () => {
    const echoing = listWorkspaceNodes()
      .filter((node) => RUN_CONTEXT_ENVELOPE_FIELDS.some((field) => Boolean((node.outputSchema as { properties?: Record<string, unknown> })?.properties?.[field])))
      .map((node) => node.id)
      .sort();
    // The five nodes whose OUTPUT schema declares the envelope (publication_controller, the sixth
    // echoing node, reads contractSource in its prompt but does not re-emit it).
    expect(echoing).toEqual(["article_body", "artifact_plan", "contract_intelligence", "publish_executor", "publish_payload"]);
  });
});

describe("wired into a real run: every node is handed the run context", () => {
  it("delivers runContext in the dispatched node's own input", async () => {
    const seen: unknown[] = [];
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ input }: { input: unknown }) => {
        seen.push(input);
        return { ok: true as const, output: { artifact: "content_source.v1", summary: "Triaged." } };
      }
    } as never);
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "run context" }, store);
      const advanced = await runNextNode(started.runId, { executionRepository: store });
      const state = advanced!.nodes.find((node) => node.nodeId === "input_triage")!;

      expect(readRunContext(seen[0])).toEqual({ clientProjectId: "project-a" });
      expect((state.input as { runContext: unknown }).runContext).toEqual({ clientProjectId: "project-a" });
      expect(state.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("wired into a real run: article_body's engine loop and engine echo", () => {
  const ENDPOINT = "https://platform.example/mcp";
  let remoteFetch: ReturnType<typeof vi.fn>;
  let validateCalls: number;

  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = ENDPOINT;
    process.env.PLATFORM_MCP_TOKEN = "secret-token";
    validateCalls = 0;
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string } };
      if (request.method === "tools/call" && request.params?.name === "object_validate") validateCalls += 1;
      const result = request.method === "tools/call" ? { structuredContent: { valid: true, issues: [] } } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATFORM_MCP_ENDPOINT;
    delete process.env.PLATFORM_MCP_TOKEN;
  });

  // Enter late-stage at article_body (which completes every ancestor and seeds a contract_intelligence
  // stage output), then re-queue article_body itself so this run actually DISPATCHES it — with a
  // stubbed runner standing in for the model, emitting an envelope with no client identity in it at
  // all and no clientValidation. Before W3 that output failed article_body's own schema on three
  // required fields; the engine now supplies them, and the engine — not the node's tool budget —
  // earns the client's verdict.
  it("validates engine-side, records the verdict structurally, and fills the envelope the model omitted", async () => {
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async () => ({ ok: true as const, output: { artifact: "client_object.v1", summary: "Built to the fetched contract.", body: { slug: "governed-content", nodes: [{ id: "n1", type: "paragraph" }] }, blockers: [] } })
    } as never);
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({
        executionMode: "openai",
        projectId: "platform",
        input: "W3 e2e",
        budgetUsd: 100,
        entrypoint: { nodeId: "article_body", output: { artifact: "client_object.v1", summary: "seed", clientProjectId: "platform", clientObjectType: "content_item", contractSource, body: { slug: "seed" } } }
      }, store);
      const run = (await getRun(started.runId, store))!;
      // Re-queue article_body so it dispatches for real; its ancestors stay completed.
      const state = run.nodes.find((node) => node.nodeId === "article_body")!;
      state.status = "queued";
      delete state.output;
      delete run.stageOutputs.article_body;
      run.stageOutputs.contract_intelligence = { artifact: "contract_intelligence.v1", clientProjectId: "platform", clientObjectType: "content_item", contractSource };
      run.currentNodeId = "article_body";
      run.status = "queued";
      await store.saveRun(run);

      const advanced = await runNextNode(started.runId, { executionRepository: store });
      const dispatched = advanced!.nodes.find((node) => node.nodeId === "article_body")!;

      expect(dispatched.status).toBe("completed");
      const output = dispatched.output as { clientProjectId: string; clientObjectType: string; contractSource: unknown; clientValidation: { source: string; valid: boolean; engineLoop: { revalidations: number; revisionTurns: number; outcome: string } } };
      // Part 3: the engine echoed the envelope the model never typed.
      expect(output.clientProjectId).toBe("platform");
      expect(output.clientObjectType).toBe("content_item");
      expect(output.contractSource).toEqual(contractSource);
      // Part 1: the engine — not the node's agent loop — earned the verdict, in one client call.
      expect(validateCalls).toBe(1);
      expect(output.clientValidation).toMatchObject({ source: "engine_validation_loop", valid: true, attempted: true });
      expect(output.clientValidation.engineLoop).toMatchObject({ revalidations: 0, revisionTurns: 0, outcome: "valid" });
      const dispatchedContext = (dispatched.input as { runContext: { clientObjectType: string; enginePolicies: string[] } }).runContext;
      expect(dispatchedContext.clientObjectType).toBe("content_item");
      // And the model was TOLD the engine owns validation — the half that stops it spending its own
      // toolCallLimit on the loop, delivered by the engine rather than by a seeded prompt the live
      // store-sourced workspace would not see until a re-seed.
      expect(dispatchedContext.enginePolicies.join(" ")).toMatch(/do not call the client's validator yourself/);
    } finally {
      spy.mockRestore();
    }
  });
});
