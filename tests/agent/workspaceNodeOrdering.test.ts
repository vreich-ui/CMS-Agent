import { beforeEach, describe, expect, it, vi } from "vitest";
import { listWorkspaceNodes, sortWorkspaceNodes } from "../../src/agent/workspace/nodes.js";
import { MemoryWorkspaceRepository } from "../../src/agent/repository/memory/MemoryWorkspaceRepository.js";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";

const canonicalOrder = listWorkspaceNodes().map((node) => node.id);
const RESEARCH_INDEX = canonicalOrder.indexOf("research");

describe("sortWorkspaceNodes", () => {
  it("orders shuffled nodes into canonical conductor order", () => {
    const shuffled = [...listWorkspaceNodes()].reverse();
    expect(sortWorkspaceNodes(shuffled).map((node) => node.id)).toEqual(canonicalOrder);
  });

  it("keeps canonical order when a node lost its stored position (legacy data)", () => {
    const nodes = listWorkspaceNodes().map((node) => node.id === "research" ? { ...node, position: undefined as never } : node);
    const moved = [...nodes.filter((node) => node.id !== "research"), nodes.find((node) => node.id === "research")!];
    expect(sortWorkspaceNodes(moved).map((node) => node.id)).toEqual(canonicalOrder);
  });

  it("does not mutate the input array", () => {
    const input = [...listWorkspaceNodes()].reverse();
    const snapshot = input.map((node) => node.id);
    sortWorkspaceNodes(input);
    expect(input.map((node) => node.id)).toEqual(snapshot);
  });
});

describe("Memory workspace repository ordering", () => {
  let repository: MemoryWorkspaceRepository;
  beforeEach(() => { repository = new MemoryWorkspaceRepository(); });

  it("updating the research prompt does not move research to the end", async () => {
    await repository.updateNodePrompt("research", "Updated research prompt for ordering.");
    const ids = (await repository.getNodes()).map((node) => node.id);

    expect(ids.indexOf("research")).toBe(RESEARCH_INDEX);
    expect(ids.indexOf("research")).toBeLessThan(ids.indexOf("objection_mapping"));
    expect(ids[ids.length - 1]).not.toBe("research");
  });

  it("workspace.get_nodes returns canonical order after a prompt update", async () => {
    await repository.updateNodePrompt("research", "Another research prompt edit.");
    expect((await repository.getNodes()).map((node) => node.id)).toEqual(canonicalOrder);

    const node = await repository.getNode("research");
    expect(node?.prompt).toBe("Another research prompt edit.");
  });

  it("updating a node schema also preserves canonical order", async () => {
    await repository.updateNodeSchema("reader_insight", { type: "object", properties: { extra: { type: "string" } } });
    expect((await repository.getNodes()).map((node) => node.id)).toEqual(canonicalOrder);
  });
});

const blobData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@netlify/blobs", () => ({
  getStore: vi.fn(() => ({
    get: vi.fn(async (key: string) => blobData.has(key) ? structuredClone(blobData.get(key)) : null),
    setJSON: vi.fn(async (key: string, value: unknown) => { blobData.set(key, structuredClone(value)); return { modified: true, etag: `etag-${key}` }; }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({ blobs: [...blobData.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })), directories: [] }))
  }))
}));

describe("Blob workspace repository ordering", () => {
  beforeEach(() => blobData.clear());

  it("get_nodes stays canonical after a persisted prompt update, across instances", async () => {
    const first = new RepositoryManager({ backend: "blobs" }).getWorkspaceRepository();
    await first.updateNodePrompt("research", "Persisted research prompt under blobs.");

    const second = new RepositoryManager({ backend: "blobs" }).getWorkspaceRepository();
    const ids = (await second.getNodes()).map((node) => node.id);
    expect(ids).toEqual(canonicalOrder);
    expect(ids.indexOf("research")).toBe(RESEARCH_INDEX);
  });
});
