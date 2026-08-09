import { describe, expect, it } from "vitest";
import { applyConversationTurnGcPlan, planConversationTurnGc } from "../../src/agent/conversations/conversationTurnGc.js";
import type { ConversationTurnRecord } from "../../src/agent/conversations/conversationTurnTypes.js";
import { runConversationTurnGcJob } from "../../src/agent/entrypoints/conversationTurnGcJob.js";
import { BlobConversationTurnRepository } from "../../src/agent/repository/blobs/BlobConversationTurnRepository.js";
import type { BlobStoreClient } from "../../src/agent/repository/blobs/blobClient.js";
import { MemoryConversationTurnRepository } from "../../src/agent/repository/memory/MemoryConversationTurnRepository.js";
import { MemoryLearningRepository } from "../../src/agent/repository/memory/MemoryLearningRepository.js";
import { MemoryWorkspaceRepository } from "../../src/agent/repository/memory/MemoryWorkspaceRepository.js";

const turn = (turnId: string, createdAt: string, conversationId = "chat_1", projectId = "platform"): ConversationTurnRecord => ({
  recordType: "turn", turnId, conversationId, projectId, agentRef: "agt_client_manager", agentRev: "1",
  actor: { kind: "human", id: "usr_1" }, requestPreview: { messageCount: 1 }, assistantText: `content ${turnId}`,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsdEstimate: 0 }, createdAt
});

const evidence = (supersededTurnId = "old", supersedingTurnId = "new", conversationId = "chat_1", projectId = "platform") => ({
  supersessionId: `sup_${projectId}_${conversationId}_${supersededTurnId}_${supersedingTurnId}`, projectId, conversationId, supersededTurnId, supersedingTurnId,
  reason: "A later confirmed interaction replaced the earlier learning example.", source: "learning" as const, sourceId: "obs_1", recordedAt: "2026-08-09T01:00:00.000Z"
});

const setup = () => {
  const conversations = new MemoryConversationTurnRepository();
  const learning = new MemoryLearningRepository(new MemoryWorkspaceRepository());
  return { conversations, learning };
};

const seedPair = async (conversations: MemoryConversationTurnRepository, conversationId = "chat_1", projectId = "platform") => {
  await conversations.record(turn("old", "2026-08-09T00:00:00.000Z", conversationId, projectId));
  await conversations.record(turn("new", "2026-08-09T00:01:00.000Z", conversationId, projectId));
};

describe("supersession-aware conversation turn GC", () => {
  it("deletes only explicitly superseded turns and leaves a content-free audit tombstone", async () => {
    const { conversations, learning } = setup();
    await seedPair(conversations);
    await learning.recordConversationTurnSupersession(evidence());

    const plan = await planConversationTurnGc({ conversationTurnRepository: conversations, learningRepository: learning, projectId: "platform", conversationId: "chat_1" });
    expect(plan).toMatchObject({ eligible: 1, selected: 1, reasons: { superseded: 1 } });
    await expect(applyConversationTurnGcPlan({ conversationTurnRepository: conversations, plan })).resolves.toEqual({ deleted: 1, alreadyDeleted: 0 });
    const entries = await conversations.list("chat_1");
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: "turn", turnId: "new" }), expect.objectContaining({ recordType: "supersession_tombstone", supersededTurnId: "old", supersedingTurnId: "new", sourceId: "obs_1" })]));
    expect(JSON.stringify(entries.find((entry) => entry.recordType === "supersession_tombstone"))).not.toContain("content old");
  });

  it("keeps turns with no durable supersession evidence", async () => {
    const { conversations, learning } = setup();
    await seedPair(conversations);
    const plan = await planConversationTurnGc({ conversationTurnRepository: conversations, learningRepository: learning, projectId: "platform", conversationId: "chat_1" });
    expect(plan).toMatchObject({ selected: 0, reasons: { no_supersession_evidence: 2 } });
  });

  it("protects pending replay claims and explicit learning/evaluation/improvement references", async () => {
    const { conversations, learning } = setup();
    await seedPair(conversations);
    await learning.recordConversationTurnSupersession(evidence());
    await conversations.claim("chat_1", "old", "request_hash");
    let plan = await planConversationTurnGc({ conversationTurnRepository: conversations, learningRepository: learning, projectId: "platform", conversationId: "chat_1" });
    expect(plan).toMatchObject({ selected: 0, reasons: { active_replay_claim: 1 } });

    const { conversations: referenced, learning: referenceLearning } = setup();
    await seedPair(referenced);
    await referenceLearning.recordConversationTurnSupersession(evidence());
    await referenceLearning.recordConversationTurnReference({ referenceId: "ref_eval_1", projectId: "platform", conversationId: "chat_1", turnId: "old", artifactType: "evaluation", artifactId: "eval_1", recordedAt: "2026-08-09T01:01:00.000Z" });
    plan = await planConversationTurnGc({ conversationTurnRepository: referenced, learningRepository: referenceLearning, projectId: "platform", conversationId: "chat_1" });
    expect(plan).toMatchObject({ selected: 0, reasons: { referenced_by_artifact: 1 } });
  });

  it("is idempotent and coexists with the existing 200-turn trim marker", async () => {
    const { conversations, learning } = setup();
    for (let index = 0; index <= 200; index++) await conversations.record(turn(`turn_${index}`, new Date(Date.UTC(2026, 7, 9, 0, 0, index)).toISOString()));
    await learning.recordConversationTurnSupersession(evidence("turn_1", "turn_200"));
    const plan = await planConversationTurnGc({ conversationTurnRepository: conversations, learningRepository: learning, projectId: "platform", conversationId: "chat_1" });
    await applyConversationTurnGcPlan({ conversationTurnRepository: conversations, plan });
    await expect(applyConversationTurnGcPlan({ conversationTurnRepository: conversations, plan })).resolves.toEqual({ deleted: 0, alreadyDeleted: 1 });
    const entries = await conversations.list("chat_1");
    expect(entries.find((entry) => entry.recordType === "trim_marker")).toMatchObject({ trimmedTurnCount: 1 });
    expect(entries.filter((entry) => entry.recordType === "turn")).toHaveLength(199);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: "supersession_tombstone", supersededTurnId: "turn_1" })]));
  });

  it("does not cross project or conversation boundaries", async () => {
    const { conversations, learning } = setup();
    await seedPair(conversations, "chat_platform", "platform");
    await seedPair(conversations, "chat_other", "other");
    await learning.recordConversationTurnSupersession(evidence("old", "new", "chat_platform", "platform"));
    const result = await runConversationTurnGcJob({ projectId: "platform", apply: true, conversationTurnRepository: conversations, learningRepository: learning, maxConversations: 10 });
    expect(result.deleted).toBe(1);
    expect((await conversations.list("chat_other")).filter((entry) => entry.recordType === "turn")).toHaveLength(2);
  });

  it("is bounded and defaults to a non-mutating dry-run", async () => {
    const { conversations, learning } = setup();
    await seedPair(conversations, "a_chat");
    await seedPair(conversations, "b_chat");
    await learning.recordConversationTurnSupersession(evidence("old", "new", "a_chat"));
    await learning.recordConversationTurnSupersession(evidence("old", "new", "b_chat"));
    const dryRun = await runConversationTurnGcJob({ projectId: "platform", conversationTurnRepository: conversations, learningRepository: learning, maxConversations: 1, maxDeletesPerConversation: 1 });
    expect(dryRun).toMatchObject({ mode: "dry_run", conversationsScanned: 1, selected: 1, deleted: 0 });
    expect((await conversations.list("a_chat")).some((entry) => entry.recordType === "supersession_tombstone")).toBe(false);
    const applied = await runConversationTurnGcJob({ projectId: "platform", apply: true, conversationTurnRepository: conversations, learningRepository: learning, maxConversations: 1, maxDeletesPerConversation: 1 });
    expect(applied).toMatchObject({ mode: "apply", conversationsScanned: 1, deleted: 1 });
    expect((await conversations.list("b_chat")).some((entry) => entry.recordType === "supersession_tombstone")).toBe(false);
  });
});

describe("GCS-shaped supersession GC CAS", () => {
  it("retries a concurrent conditional-write conflict without clobbering the winning mirror", async () => {
    const values = new Map<string, { data: unknown; etag: string }>();
    let revision = 0;
    const store = {
      get: async (key: string) => values.has(key) ? structuredClone(values.get(key)!.data) : null,
      getWithMetadata: async (key: string) => values.has(key) ? structuredClone(values.get(key)!) : null,
      setJSON: async (key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
        const current = values.get(key);
        if ((options?.onlyIfNew && current) || (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
        const etag = String(++revision); values.set(key, { data: structuredClone(data), etag }); return { modified: true, etag };
      },
      list: async () => ({ blobs: [], directories: [] }), delete: async () => undefined
    } as unknown as BlobStoreClient;
    const conversations = new BlobConversationTurnRepository(store);
    const concurrent = new BlobConversationTurnRepository(store);
    await conversations.record(turn("old", "2026-08-09T00:00:00.000Z"));
    await conversations.record(turn("new", "2026-08-09T00:01:00.000Z"));
    const learning = setup().learning;
    await learning.recordConversationTurnSupersession(evidence());
    const plan = await planConversationTurnGc({ conversationTurnRepository: conversations, learningRepository: learning, projectId: "platform", conversationId: "chat_1" });
    const [first, second] = await Promise.all([
      applyConversationTurnGcPlan({ conversationTurnRepository: conversations, plan }),
      applyConversationTurnGcPlan({ conversationTurnRepository: concurrent, plan })
    ]);
    expect([first.deleted, second.deleted].sort()).toEqual([0, 1]);
    expect((await conversations.list("chat_1")).some((entry) => entry.recordType === "supersession_tombstone")).toBe(true);
  });
});
