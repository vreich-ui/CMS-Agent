import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { BlobProjectRepository } from "../../../src/agent/repository/blobs/BlobProjectRepository.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";

const blobData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@netlify/blobs", () => ({
  getStore: vi.fn(() => ({
    get: vi.fn(async (key: string) => blobData.has(key) ? structuredClone(blobData.get(key)) : null),
    setJSON: vi.fn(async (key: string, value: unknown) => { blobData.set(key, structuredClone(value)); return { modified: true, etag: `etag-${key}` }; }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({ blobs: [...blobData.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })), directories: [] })),
    delete: vi.fn(async (key: string) => { blobData.delete(key); })
  }))
}));

describe("Blob project repository", () => {
  beforeEach(() => blobData.clear());

  it("is exposed by RepositoryManager for the blobs backend", () => {
    expect(new RepositoryManager({ backend: "blobs" }).getProjectRepository()).toBeInstanceOf(BlobProjectRepository);
  });

  it("seeds and persists dr-lurie under a stable projects/ key without storing resolved secrets", async () => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "resolved-secret-value";
    try {
      const repository = new RepositoryManager({ backend: "blobs" }).getProjectRepository();

      const projects = await repository.list();
      expect(projects.map((project) => project.projectId)).toContain("dr-lurie");
      expect(blobData.has("projects/dr-lurie.json")).toBe(true);

      const persisted = JSON.stringify([...blobData.values()]);
      // The resolved endpoint value and token value are never persisted — only env var references.
      expect(persisted).not.toContain("resolved-secret-value");
      expect(persisted).not.toContain("https://dr-lurie.example/mcp");
      expect(persisted).toContain("DR_LURIE_MCP_ENDPOINT");
      expect(persisted).toContain("DR_LURIE_MCP_TOKEN");

      const reread = await new RepositoryManager({ backend: "blobs" }).getProjectRepository().get("dr-lurie");
      expect(reread?.contentContract.canonicalArticleBody).toBe("article_body.v1");
    } finally {
      delete process.env.DR_LURIE_MCP_ENDPOINT;
      delete process.env.DR_LURIE_MCP_TOKEN;
    }
  });

  it("self-heals a workspace blob poisoned with an invalid node on read", async () => {
    const { createDefaultWorkspaceDocument } = await import("../../../src/agent/mcp/workspace/store.js");
    const { BlobWorkspaceRepository } = await import("../../../src/agent/repository/blobs/BlobWorkspaceRepository.js");
    const base = createDefaultWorkspaceDocument();
    const validCount = base.nodes.length;
    // A node with no id/name/prompt — the shape that bricked the live workspace.
    const poisoned = { ...base, nodes: [...base.nodes, { "0": "{", kind: "workspace", updatedAt: new Date().toISOString() }] };
    blobData.set("workspace/current.json", poisoned);

    const repository = new BlobWorkspaceRepository();
    const nodes = await repository.getNodes();
    expect(nodes).toHaveLength(validCount);
    // The heal is persisted: the stored blob no longer contains the poisoned record.
    const healed = blobData.get("workspace/current.json") as { nodes: unknown[] };
    expect(healed.nodes).toHaveLength(validCount);
    // ...and observable: health reports how many records self-healing dropped.
    expect((await repository.health()).details).toEqual({ healedDroppedNodes: 1 });
  });

  it("deletes a custom project blob and reports whether it existed", async () => {
    blobData.set("projects/custom.json", { ...structuredClone(drLurieProjectConfig), projectId: "custom", name: "Custom" });
    const repository = new RepositoryManager({ backend: "blobs" }).getProjectRepository();

    expect(await repository.delete("custom")).toBe(true);
    expect(blobData.has("projects/custom.json")).toBe(false);
    expect(await repository.delete("custom")).toBe(false);
  });

  it("upgrades stale persisted dr-lurie defaults without removing custom project configs", async () => {
    blobData.set("projects/dr-lurie.json", { ...structuredClone(drLurieProjectConfig), definitionVersion: 1, allowedTools: ["ping"] });
    blobData.set("projects/custom.json", { ...structuredClone(drLurieProjectConfig), projectId: "custom", name: "Custom", definitionVersion: 1, allowedTools: ["custom_read"] });

    const repository = new RepositoryManager({ backend: "blobs" }).getProjectRepository();
    const drLurie = await repository.get("dr-lurie");
    const custom = await repository.get("custom");

    expect(drLurie?.definitionVersion).toBe(drLurieProjectConfig.definitionVersion);
    expect(drLurie?.allowedTools).toEqual(drLurieProjectConfig.allowedTools);
    expect(custom?.allowedTools).toEqual(["custom_read"]);
  });

  // G3 (T-2 re-run, run_1785405350649_9u5mjz): platform's live record had no objectDialect at all
  // and nothing reported it. A custom, non-default project (never migrated) is the stand-in here for
  // exactly that window between "registered live" and "picked up by a default-project re-seed".
  it("reports a missing objectDialect through health() for a publish-capable project that lacks one", async () => {
    const { platformProjectConfig } = await import("../../../src/agent/projects/platform/definition.js");
    // definitionVersion MUST match the current default's, or ensureSeeded's own migration would
    // overwrite this deliberately-incomplete record with the correct one before health() ever reads
    // it — this is standing in for the live window before a version bump ever reaches a project.
    blobData.set("projects/platform.json", { ...structuredClone(platformProjectConfig), objectDialect: undefined });
    const repository = new RepositoryManager({ backend: "blobs" }).getProjectRepository();

    const health = await repository.health();

    expect(health.readable).toBe(true);
    expect(health.writable).toBe(true);
    expect(health.details).toEqual({ objectDialectFindings: ["platform: missing objectDialect.siteObjectId, objectDialect.taxonomyRegistryObjectId, objectDialect.objectIdSource, objectDialect.defaultObjectType"] });
  });
});
