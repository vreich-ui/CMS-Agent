import { describe, expect, it } from "vitest";
import { MemorySkillRepository } from "../../../src/agent/skills/skillRegistry.js";
import { resolveSkillsForNode } from "../../../src/agent/skills/skillResolver.js";
import type { SkillDefinition } from "../../../src/agent/skills/skillTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const node = (patch: Partial<WorkspaceNode> = {}): WorkspaceNode => ({ id: "n1", name: "Node", kind: "test", description: "", prompt: "Node prompt", inputSchema: { type: "object" }, outputSchema: { type: "object" }, allowedTools: ["web.fetch", "safe.tool"], assignedSkills: [], requiredInputs: [], produces: [], riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: new Date().toISOString(), ...patch });

const customSkill = (skillId: string): SkillDefinition => ({ skillId, name: "Custom", description: "Custom skill", version: "1.0.0", status: "active", instructions: "Use custom behavior.", inputSchema: { type: "object", required: ["brief"], properties: { brief: { type: "string" } } }, outputSchema: { type: "object" }, allowedTools: ["web.fetch", "publish.post"], requiredArtifacts: [], producedArtifacts: [], examples: [{ name: "ok", input: { brief: "x" }, output: {} }], preconditions: [], completionCriteria: [], blockerCriteria: [], memoryPolicy: { namespaces: [skillId], read: true, write: false }, toolPolicy: { requestedTools: ["web.fetch", "publish.post"], mutatingToolsRequireApproval: true }, riskLevel: "read", metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

describe("versioned skill registry", () => {
  it("creates, updates, versions, restores, clones, and deletes skills", async () => {
    const repo = new MemorySkillRepository("json");
    const created = await repo.create(customSkill("custom_registry_test"));
    expect(created.skill.skillId).toBe("custom_registry_test");
    const updated = await repo.update("custom_registry_test", { instructions: "Updated instructions." });
    expect(updated.skill.instructions).toBe("Updated instructions.");
    const versions = await repo.listVersions("custom_registry_test");
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const restored = await repo.restoreVersion("custom_registry_test", versions[0].versionId);
    expect(restored.skill.instructions).toBe("Use custom behavior.");
    const cloned = await repo.clone("custom_registry_test", "custom_registry_clone");
    expect(cloned.skill.skillId).toBe("custom_registry_clone");
    await repo.delete("custom_registry_clone");
    expect(await repo.get("custom_registry_clone")).toBeUndefined();
  });

  it("composes instructions deterministically and intersects tools without self-elevation", async () => {
    const repo = new MemorySkillRepository("json");
    await repo.create(customSkill("custom_resolver_test"));
    const resolved = await resolveSkillsForNode(node({ assignedSkills: ["custom_resolver_test"] }), repo, { workspaceSystemPolicy: "System", projectPolicy: "Project", runInstructions: "Run", platformTools: ["web.fetch", "publish.post"], runAuthorizedTools: ["web.fetch", "publish.post"], riskPolicy: "read" });
    expect(resolved.instructions.indexOf("System")).toBeLessThan(resolved.instructions.indexOf("Node prompt"));
    expect(resolved.instructions.indexOf("Node prompt")).toBeLessThan(resolved.instructions.indexOf("Use custom behavior"));
    expect(resolved.instructions.indexOf("Project")).toBeLessThan(resolved.instructions.indexOf("Run"));
    expect(resolved.effectiveTools).toEqual(["web.fetch"]);
    expect(resolved.deniedTools).toContain("publish.post");
  });

  it("blocks incompatible output schema composition", async () => {
    const repo = new MemorySkillRepository("json");
    await repo.create({ ...customSkill("custom_schema_test"), outputSchema: { type: "object", required: ["skillOnly"], properties: { skillOnly: { type: "string" } } }, examples: [{ name: "ok", input: { brief: "x" }, output: { skillOnly: "y" } }] });
    const resolved = await resolveSkillsForNode(node({ outputSchema: { type: "object", required: ["nodeOnly"], properties: { nodeOnly: { type: "string" } } }, assignedSkills: ["custom_schema_test"] }), repo);
    expect(resolved.conflicts.some((conflict) => conflict.severity === "blocker")).toBe(true);
  });
});

describe("BlobSkillRepository", () => {
  it("persists skills across repository instances", async () => {
    const { BlobSkillRepository } = await import("../../../src/agent/skills/skillRegistry.js");
    const blobs = new Map<string, unknown>();
    const store = {
      async get(key: string) { return blobs.get(key) ?? null; },
      async setJSON(key: string, value: unknown) { blobs.set(key, value); },
      async delete(key: string) { blobs.delete(key); },
      async list(options?: { prefix?: string }) { return { blobs: [...blobs.keys()].filter((key) => !options?.prefix || key.startsWith(options.prefix)).map((key) => ({ key })) }; }
    };
    await new BlobSkillRepository(store as never).create(customSkill("blob_persisted_skill"));
    await expect(new BlobSkillRepository(store as never).get("blob_persisted_skill")).resolves.toMatchObject({ skillId: "blob_persisted_skill" });
  });
});
