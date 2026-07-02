import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceStore, createWorkspaceStoreFromEnv, InMemoryWorkspaceStore, JsonWorkspaceStore } from "../../../src/agent/mcp/workspace/store.js";

let tempDirs: string[] = [];

const makeTempWorkspacePath = async () => {
  const dir = await mkdtemp(join(tmpdir(), "cms-agent-workspace-"));
  tempDirs.push(dir);
  return join(dir, "workspace.json");
};

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("workspace store", () => {
  it("defaults to an in-memory workspace store", async () => {
    const store = createWorkspaceStore();

    expect(store).toBeInstanceOf(InMemoryWorkspaceStore);
    expect((await store.getNodes()).map((node) => node.id)).toContain("article_body");
  });

  it("uses memory when WORKSPACE_STORE is missing", () => {
    const store = createWorkspaceStoreFromEnv({ NODE_ENV: "production" });

    expect(store).toBeInstanceOf(InMemoryWorkspaceStore);
  });

  it("allows WORKSPACE_STORE=json outside production", async () => {
    const filePath = await makeTempWorkspacePath();
    const store = createWorkspaceStoreFromEnv({ NODE_ENV: "development", WORKSPACE_STORE: "json", WORKSPACE_STORE_PATH: filePath });

    expect(store).toBeInstanceOf(JsonWorkspaceStore);
    expect((await store.getNodes()).map((node) => node.id)).toContain("article_body");
  });

  it("throws for WORKSPACE_STORE=json in production", () => {
    expect(() => createWorkspaceStoreFromEnv({ NODE_ENV: "production", WORKSPACE_STORE: "json" })).toThrow(/JSON workspace storage is local\/dev only/);
    expect(() => createWorkspaceStoreFromEnv({ NODE_ENV: "production", WORKSPACE_STORE: "json" })).toThrow(/Netlify serverless filesystem is not durable storage/);
    expect(() => createWorkspaceStoreFromEnv({ NODE_ENV: "production", WORKSPACE_STORE: "json" })).toThrow(/database\/object-store adapter/);
  });

  it("initializes a JSON workspace store from default nodes", async () => {
    const filePath = await makeTempWorkspacePath();
    const store = new JsonWorkspaceStore(filePath);

    const exported = await store.exportWorkspace();

    expect(exported.schemaVersion).toBe(1);
    expect(exported.workspaceVersion).toBe(0);
    expect(exported.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["article_body", "publish_payload"]));
  });

  it("persists node prompt updates after reloading the JSON workspace store", async () => {
    const filePath = await makeTempWorkspacePath();
    const store = new JsonWorkspaceStore(filePath);
    await store.updateNodePrompt("article_body", "Persisted prompt");

    const reloadedStore = new JsonWorkspaceStore(filePath);

    await expect(reloadedStore.getNode("article_body")).resolves.toMatchObject({ prompt: "Persisted prompt" });
  });

  it("increments workspaceVersion after mutations", async () => {
    const store = createWorkspaceStore("memory");
    const initialVersion = await store.getWorkspaceVersion();

    await store.updateNodeSchema("article_body", { type: "object", properties: { headline: { type: "string" } } });

    expect(await store.getWorkspaceVersion()).toBe(initialVersion + 1);
    expect((await store.exportWorkspace()).workspaceVersion).toBe(initialVersion + 1);
  });
});
