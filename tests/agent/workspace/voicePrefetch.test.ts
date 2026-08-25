import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEditorialVoice } from "../../../src/agent/workspace/voicePrefetch.js";
import { RunScopedCache } from "../../../src/agent/workspace/conductor.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { DR_LURIE_VOICE_FALLBACK } from "../../../src/agent/projects/drLurie/editorialVoice.js";

const ENDPOINT = "https://dr-lurie.example/mcp";

// Realistic live editorial_voice body — mirrors the confirmed live voice_drlurie record (2026-08-05):
// object_contract("editorial_voice") is live against Dr. Lurie, and this shape is the one voicePrefetch
// must recognize and hand straight through as `source: "live"`.
const LIVE_VOICE_BODY = {
  name: "Dr. Lurie — evidence-led skin health",
  audience: "Adults making decisions about their own skin, most arriving from a search with a specific worry and no clinical training.",
  tone: ["warm", "calm", "evidence-led", "non-alarmist"],
  cadence: "Conversational but disciplined.",
  lexicon: { prefer: ["evidence", "studies suggest"], avoid: ["miracle", "cure"] },
  claim_policy: "Efficacy statements are hedged to the strength of the evidence behind them.",
  cta_policy: "At most one ask per article, always the low-commitment one.",
  reader_safety_notes: "An over-confident sentence here can delay real care.",
  frameworks: [{ framework_id: "fw_concern", label: "Concern explainer", when_to_use: "The reader arrived with a symptom or a fear." }],
  default_framework: "fw_concern"
};

// GUI rework Session B (F1's voice counterpart): getEditorialVoice fetches a client's editorial voice
// deterministically — a plain function call the conductor makes once, before a voice-consuming node
// runs — mirroring contractPrefetch.ts's getReducedContract exactly, so this optimization never
// repeats contract_intelligence's per-turn-refetch mistake ($10.87 across this project's history).
describe("getEditorialVoice (voice prefetch)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  const remoteMethods: string[] = [];

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteMethods.length = 0;
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      remoteMethods.push(request.method);
      const result = request.method === "tools/call"
        ? { structuredContent: { object: LIVE_VOICE_BODY } }
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

  it("fetches the live voice_<project> object and resolves the object id from the project's configured convention", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-1", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("live");
    expect(result.voice).toEqual(LIVE_VOICE_BODY);
    expect(result.warningCode).toBeUndefined();
    expect(remoteMethods).toEqual(["tools/call"]);
  });

  it("caches the fetch per run — a second call for the same run/project never refetches", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getEditorialVoice({ runId: "run-voice-2", projectId: "dr-lurie" }, { projectRepository, cache });
    await getEditorialVoice({ runId: "run-voice-2", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteFetch).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache across different runs", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getEditorialVoice({ runId: "run-voice-3a", projectId: "dr-lurie" }, { projectRepository, cache });
    await getEditorialVoice({ runId: "run-voice-3b", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  // Requirement #3: a missing/unreachable voice must never fail the run — it degrades to the seeded
  // fallback, loudly (a distinct warningCode), never silently.
  it("falls back to the seeded editorial voice, loudly, when the client is unreachable", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT; // simulate an unconfigured/unreachable connection
    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-4", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("fallback");
    expect(result.voice).toEqual(DR_LURIE_VOICE_FALLBACK);
    expect(result.warningCode).toBe("voice_prefetch_unreachable");
    expect(result.warning).toContain("dr-lurie");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("falls back to the seeded editorial voice when the live object does not exist (not_found)", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "tools/call" ? { structuredContent: { not_found: true } } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-5", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("fallback");
    expect(result.voice).toEqual(DR_LURIE_VOICE_FALLBACK);
    expect(result.warningCode).toBe("voice_object_not_found");
  });

  it("falls back to the seeded editorial voice when the live object does not match the expected shape", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "tools/call" ? { structuredContent: { object: { some: "unexpected shape" } } } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-6", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("fallback");
    expect(result.warningCode).toBe("voice_object_invalid");
  });

  it("reports unavailable (not an error) for an unknown project with no registered voice fallback", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-7", projectId: "does-not-exist" }, { projectRepository, cache: new RunScopedCache() });

    expect(result).toEqual({ source: "unavailable" });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  // Platform (and any project with no voiceObjectId AND no registered fallback) is a clean no-op:
  // the voice concept is simply not wired for it yet, which is not the same thing as a degradation.
  it("is a silent no-op for a project with no voiceObjectId and no registered fallback", async () => {
    const projectRepository = new MemoryProjectRepository();
    const drLurie = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...drLurie!, projectId: "platform", objectDialect: { ...drLurie!.objectDialect!, voiceObjectId: undefined } });

    const result = await getEditorialVoice({ runId: "run-voice-8", projectId: "platform" }, { projectRepository, cache: new RunScopedCache() });

    expect(result).toEqual({ source: "unavailable" });
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("honors an explicit requestedVoiceObjectId over the project's configured default", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-9", projectId: "dr-lurie", requestedVoiceObjectId: "voice_drlurie_variant" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("live");
    // The stub always returns LIVE_VOICE_BODY regardless of object_id, so this exercises only that the
    // override is what got sent — verified via the recorded request bodies.
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(remoteFetch.mock.calls[0][1].body) as { params?: { arguments?: Record<string, unknown> } };
    expect(sentBody.params?.arguments).toMatchObject({ object_type: "editorial_voice", object_id: "voice_drlurie_variant" });
  });

  // T10 (verified against dr-lurie's live voice_drlurie object, 2026-08-25). A real object_get answers
  // with the whole RECORD — object_id, object_type, status, version, publication, history, review —
  // and the editorial voice sits under `body`. The extractor stopped at the record, isVoiceBody said
  // no, and every live fetch degraded to the seed with voice_object_invalid. dr-lurie's real
  // editorial voice, authored and published on 2026-08-05, had never reached a single run.
  //
  // Invisible precisely because the fallback works: runs completed, articles read plausibly, and the
  // only trace was a per-node warning on a path whose entire design promise is that it degrades
  // quietly.
  const liveRecordEnvelope = (body: unknown) => ({
    record: {
      object_id: "voice_drlurie",
      object_type: "editorial_voice",
      schema_version: "editorial_voice.v1",
      site: "site_drlurie",
      status: "active",
      version: 6,
      content_revision: 1,
      body,
      publication: { published_time: "2026-08-05T16:34:29.470Z" },
      history: [{ at: "2026-08-05T16:28:17.034Z", action: "create" }],
      review: { state: "approved", decisions: [] }
    }
  });

  it("unwraps the live object RECORD to its body instead of falling back", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "tools/call" ? { structuredContent: liveRecordEnvelope(LIVE_VOICE_BODY) } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });

    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-record", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("live");
    expect(result.warningCode).toBeUndefined();
    expect(result.voice).toEqual(LIVE_VOICE_BODY);
  });

  it("unwraps the same record shape when it arrives only as a content[] text block", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify(liveRecordEnvelope(LIVE_VOICE_BODY).record) }] } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });

    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-record-text", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("live");
    expect(result.voice).toEqual(LIVE_VOICE_BODY);
  });

  // The descent is by SHAPE, so a record whose body is genuinely not a voice still degrades loudly
  // rather than handing a node something unusable.
  it("still falls back when the record's body is not a voice", async () => {
    remoteFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "tools/call" ? { structuredContent: liveRecordEnvelope({ some: "unexpected shape" }) } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });

    const projectRepository = new MemoryProjectRepository();
    const result = await getEditorialVoice({ runId: "run-voice-record-bad", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.source).toBe("fallback");
    expect(result.warningCode).toBe("voice_object_invalid");
  });

  it("still honors the project's own executable policy block before any transport", async () => {
    const projectRepository = new MemoryProjectRepository();
    const project = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...project!, toolPolicies: { ...project!.toolPolicies, object_get: "blocked" } });
    const result = await getEditorialVoice({ runId: "run-voice-10", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    // toolPolicies "blocked" is enforced inside callTool itself, so this still surfaces as a clean
    // fallback, not a thrown error, and never reaches the transport.
    expect(result.source).toBe("fallback");
    expect(result.voice).toEqual(DR_LURIE_VOICE_FALLBACK);
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
