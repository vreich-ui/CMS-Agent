import { describe, expect, it } from "vitest";
import { BlobChangeRepository } from "../../src/agent/repository/blobs/BlobChangeRepository.js";
import { MemoryChangeRepository } from "../../src/agent/repository/memory/MemoryChangeRepository.js";
import type { BlobStoreClient } from "../../src/agent/repository/blobs/blobClient.js";
import type { WorkspaceChangeEvent, WorkspaceRevision } from "../../src/agent/workspace/changeTypes.js";

// Narrow in-memory BlobStoreClient (same substitution pattern as skillRegistryAdvanced.test.ts).
const makeFakeStore = () => {
  const blobs = new Map<string, unknown>();
  const store = {
    get: async (key: string) => (blobs.has(key) ? structuredClone(blobs.get(key)) : null),
    setJSON: async (key: string, value: unknown) => { blobs.set(key, structuredClone(value)); },
    list: async ({ prefix }: { prefix?: string } = {}) => ({ blobs: [...blobs.keys()].filter((key) => !prefix || key.startsWith(prefix)).map((key) => ({ key })) }),
    delete: async (key: string) => { blobs.delete(key); }
  };
  return { blobs, store: store as unknown as BlobStoreClient };
};

const makeEvent = (overrides: Partial<WorkspaceChangeEvent>): WorkspaceChangeEvent => ({
  eventId: "evt_1",
  type: "node.prompt_updated",
  operation: "update",
  target: { type: "node", id: "input_triage" },
  actor: { kind: "agent", label: "test" },
  source: "mcp",
  workspaceVersion: 1,
  createdAt: "2026-07-01T10:00:00.000Z",
  ...overrides
});

const makeRevision = (overrides: Partial<WorkspaceRevision>): WorkspaceRevision => ({
  revisionId: "rev_1",
  workspaceVersion: 1,
  createdAt: "2026-07-01T10:00:00.000Z",
  actor: { kind: "agent" },
  source: "mcp",
  nodes: [],
  relationships: [],
  ...overrides
});

describe("BlobChangeRepository", () => {
  it("persists events and revisions as RecordEnvelope blobs under changes/ and revisions/", async () => {
    const { blobs, store } = makeFakeStore();
    const repository = new BlobChangeRepository(store);
    await repository.record({ event: makeEvent({}), revision: makeRevision({}) });

    const eventEnvelope = blobs.get("changes/evt_1.json") as Record<string, unknown>;
    expect(eventEnvelope.record_type).toBe("workspace_change_event");
    expect(eventEnvelope.schema_version).toBe("workspace_change_event.v1");
    expect(eventEnvelope.id).toBe("evt_1");
    const revisionEnvelope = blobs.get("revisions/rev_1.json") as Record<string, unknown>;
    expect(revisionEnvelope.record_type).toBe("workspace_revision");
    expect(revisionEnvelope.schema_version).toBe("workspace_revision.v1");
  });

  it("reads records back across repository instances (persistence)", async () => {
    const { store } = makeFakeStore();
    await new BlobChangeRepository(store).record({ event: makeEvent({}), revision: makeRevision({}) });
    const second = new BlobChangeRepository(store);
    expect((await second.listEvents()).events).toHaveLength(1);
    expect(await second.getEvent("evt_1")).toMatchObject({ eventId: "evt_1" });
    expect(await second.getRevision("rev_1")).toMatchObject({ revisionId: "rev_1" });
    expect(await second.getEvent("evt_missing")).toBeUndefined();
    expect(await second.getRevision("rev_missing")).toBeUndefined();
  });

  it("lists revisions ascending by workspaceVersion", async () => {
    const { store } = makeFakeStore();
    const repository = new BlobChangeRepository(store);
    await repository.record({ event: makeEvent({ eventId: "evt_b", workspaceVersion: 2 }), revision: makeRevision({ revisionId: "rev_b", workspaceVersion: 2 }) });
    await repository.record({ event: makeEvent({ eventId: "evt_a", workspaceVersion: 1 }), revision: makeRevision({ revisionId: "rev_a", workspaceVersion: 1 }) });
    expect((await repository.listRevisions()).map((revision) => revision.revisionId)).toEqual(["rev_a", "rev_b"]);
  });
});

describe("change event listing (shared filter/pagination)", () => {
  const seed = async (repository: MemoryChangeRepository) => {
    const specs = [
      { eventId: "evt_1", createdAt: "2026-07-01T10:00:00.000Z", operation: "create" as const, actor: { kind: "human" as const, id: "v" }, source: "ui" as const, target: { type: "node" as const, id: "a" } },
      { eventId: "evt_2", createdAt: "2026-07-01T11:00:00.000Z", operation: "update" as const, actor: { kind: "agent" as const }, source: "mcp" as const, target: { type: "node" as const, id: "a" } },
      { eventId: "evt_3", createdAt: "2026-07-01T12:00:00.000Z", operation: "update" as const, actor: { kind: "system" as const }, source: "system" as const, target: { type: "workspace" as const } },
      { eventId: "evt_4", createdAt: "2026-07-01T13:00:00.000Z", operation: "delete" as const, actor: { kind: "human" as const, id: "v" }, source: "ui" as const, target: { type: "node" as const, id: "b" } },
      { eventId: "evt_5", createdAt: "2026-07-01T14:00:00.000Z", operation: "restore" as const, actor: { kind: "human" as const, id: "v" }, source: "ui" as const, target: { type: "node" as const, id: "a" } }
    ];
    for (const spec of specs) await repository.record({ event: makeEvent(spec) });
  };

  it("returns newest-first and filters by node, operation, actor kind, source, and time range", async () => {
    const repository = new MemoryChangeRepository();
    await seed(repository);
    expect((await repository.listEvents()).events.map((event) => event.eventId)).toEqual(["evt_5", "evt_4", "evt_3", "evt_2", "evt_1"]);
    expect((await repository.listEvents({ nodeId: "a" })).events.map((event) => event.eventId)).toEqual(["evt_5", "evt_2", "evt_1"]);
    expect((await repository.listEvents({ operation: "delete" })).events.map((event) => event.eventId)).toEqual(["evt_4"]);
    expect((await repository.listEvents({ actorKind: "human" })).events).toHaveLength(3);
    expect((await repository.listEvents({ source: "system" })).events.map((event) => event.eventId)).toEqual(["evt_3"]);
    expect((await repository.listEvents({ from: "2026-07-01T11:30:00.000Z", to: "2026-07-01T13:30:00.000Z" })).events.map((event) => event.eventId)).toEqual(["evt_4", "evt_3"]);
  });

  it("paginates with a stable cursor and no overlap or omission", async () => {
    const repository = new MemoryChangeRepository();
    await seed(repository);
    const page1 = await repository.listEvents({ limit: 2 });
    expect(page1.events.map((event) => event.eventId)).toEqual(["evt_5", "evt_4"]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await repository.listEvents({ limit: 2, cursor: page1.nextCursor });
    expect(page2.events.map((event) => event.eventId)).toEqual(["evt_3", "evt_2"]);
    const page3 = await repository.listEvents({ limit: 2, cursor: page2.nextCursor });
    expect(page3.events.map((event) => event.eventId)).toEqual(["evt_1"]);
    expect(page3.nextCursor).toBeUndefined();
  });
});
