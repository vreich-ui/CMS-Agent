import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { DR_LURIE_VOICE_FALLBACK } from "../../../src/agent/projects/drLurie/editorialVoice.js";

const ENDPOINT = "https://dr-lurie.example/mcp";
const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

const LIVE_VOICE_BODY = {
  name: "Dr. Lurie — evidence-led skin health",
  audience: "Adults making decisions about their own skin.",
  tone: ["warm", "calm"],
  cadence: "Conversational but disciplined.",
  lexicon: { prefer: ["evidence"], avoid: ["miracle"] },
  claim_policy: "Hedge every claim to its evidence.",
  cta_policy: "At most one low-commitment ask.",
  reader_safety_notes: "Never substitute for a clinician.",
  frameworks: [{ framework_id: "fw_concern", label: "Concern explainer", when_to_use: "The reader arrived with a symptom or a fear." }],
  default_framework: "fw_concern"
};

// GUI rework Session B: verifies the actual wiring end to end through the DAG — a voicePrefetch-
// flagged node (topic_opportunity, research, brief_architect, draft_writer, trust_factual) must
// receive `editorialVoice` in its input BEFORE it dispatches, fetched exactly once per run regardless
// of how many of those nodes execute, and the run must still complete when the live voice is
// unreachable (fallback + a named, run-visible warning — never a failed run, never a silent swap).
describe("voice prefetch wired into node dispatch (end to end through the DAG)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const isVoiceGet = request.params?.name === "object_get" && request.params?.arguments?.object_type === "editorial_voice";
      const isContractGet = request.params?.name === "object_contract";
      const result = request.method !== "tools/call"
        ? {}
        : isVoiceGet
          ? { structuredContent: { object: LIVE_VOICE_BODY } }
          : isContractGet
            ? { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, body_schema: { type: "object", required: ["slug"] } } } }
            : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("injects the live editorialVoice into topic_opportunity's input before it dispatches", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "voice e2e" }, store);

    const run = await drive(started.runId, store, "topic_opportunity");
    const state = run.nodes.find((node) => node.nodeId === "topic_opportunity")!;

    expect(state.status).toBe("completed");
    const input = state.input as { editorialVoice?: typeof LIVE_VOICE_BODY; editorialVoiceSource?: string };
    expect(input.editorialVoice).toEqual(LIVE_VOICE_BODY);
    expect(input.editorialVoiceSource).toBe("live");
    expect(state.warnings ?? []).not.toContain(expect.stringMatching(/^voice_prefetch_fallback:/));
  });

  it("fetches the voice exactly once per run across every voicePrefetch node, never per node and never per model turn", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "voice e2e once" }, store);

    // Drive well past every voicePrefetch-flagged node (topic_opportunity, research, brief_architect,
    // draft_writer, trust_factual all execute before article_body completes).
    const run = await drive(started.runId, store, "article_body");
    const voicePrefetchNodeIds = ["topic_opportunity", "research", "brief_architect", "draft_writer", "trust_factual"];
    const executed = run.nodes.filter((node) => voicePrefetchNodeIds.includes(node.nodeId));
    expect(executed.every((node) => node.status === "completed")).toBe(true);
    for (const node of executed) {
      expect((node.input as { editorialVoice?: unknown }).editorialVoice, `${node.nodeId} should carry editorialVoice`).toEqual(LIVE_VOICE_BODY);
    }

    // Exactly one object_get("editorial_voice") call for the whole run, no matter how many of the
    // five voicePrefetch nodes dispatched — this is the RunScopedCache doing its job.
    const voiceCalls = remoteFetch.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as { body: string }).body) as { params?: { name?: string; arguments?: Record<string, unknown> } };
      return body.params?.name === "object_get" && body.params?.arguments?.object_type === "editorial_voice";
    });
    expect(voiceCalls).toHaveLength(1);
  });

  it("falls back to the seeded editorial voice with a run-visible warning, and the run still completes, when the client is unreachable", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT; // simulate an unreachable/unconfigured client connection
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "voice e2e fallback" }, store);

    const run = await drive(started.runId, store, "topic_opportunity");
    const state = run.nodes.find((node) => node.nodeId === "topic_opportunity")!;

    // The node dispatch itself still completes (mock mode) — a voice-prefetch failure never blocks
    // or fails the node, unlike a contract-prefetch failure.
    expect(state.status).toBe("completed");
    const input = state.input as { editorialVoice?: unknown; editorialVoiceSource?: string };
    expect(input.editorialVoice).toEqual(DR_LURIE_VOICE_FALLBACK);
    expect(input.editorialVoiceSource).toBe("fallback");
    // Named, run-visible warning — never a silent substitution (same convention as
    // contract_prefetch_failed / prefetch_object_type_unresolved).
    expect(state.warnings).toContain("voice_prefetch_fallback:voice_prefetch_unreachable");

    // The run keeps going all the way to the publish-risk gate rather than failing outright.
    const blocked = await drive(started.runId, store, "publication_controller");
    expect(blocked.status).toBe("blocked");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("is a clean no-op (no editorialVoice, no warning) for a project with no voice concept wired", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "voice e2e no-op" }, store);

    const run = await drive(started.runId, store, "topic_opportunity");
    const state = run.nodes.find((node) => node.nodeId === "topic_opportunity")!;

    expect(state.status).toBe("completed");
    expect((state.input as { editorialVoice?: unknown }).editorialVoice).toBeUndefined();
    expect(state.warnings ?? []).toEqual([]);
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
