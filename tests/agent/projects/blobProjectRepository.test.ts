import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { BlobProjectRepository } from "../../../src/agent/repository/blobs/BlobProjectRepository.js";

const blobData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@netlify/blobs", () => ({
  getStore: vi.fn(() => ({
    get: vi.fn(async (key: string) => blobData.has(key) ? structuredClone(blobData.get(key)) : null),
    setJSON: vi.fn(async (key: string, value: unknown) => { blobData.set(key, structuredClone(value)); return { modified: true, etag: `etag-${key}` }; }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({ blobs: [...blobData.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })), directories: [] }))
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
});
