/**
 * C2 (part 2) — SCOPED PLAYBOOKS: retrieval, composition, storage keys, and the cross-tenant leak
 * this half of the task exists to close.
 *
 * The leak, stated once: `promoteStrategySignals` is reached from a PER-PROJECT ingest, and wrote
 * the signals it derived from one tenant's tracking rollups into `getPlaybook(nodeId)` — the one
 * global playbook that every tenant's dispatch of that node reads. `houseLessons.ts` had already
 * dodged the same problem by hand, encoding the tenant into a fake nodeId.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { BlobImprovementRepository } from "../../../src/agent/repository/blobs/BlobImprovementRepository.js";
import { MemoryImprovementRepository } from "../../../src/agent/repository/memory/MemoryImprovementRepository.js";
import { applyPlaybookDelta, composeScopedPlaybooksForPrompt, createEmptyPlaybook, playbookScopeChain, renderPlaybookForPrompt } from "../../../src/agent/improvement/playbook.js";
import { composePlaybookForDispatch } from "../../../src/agent/improvement/playbookRetrieval.js";
import { promoteStrategySignals } from "../../../src/agent/improvement/strategyLearning.js";
import { CLIENT_MANAGER_PLAYBOOK_NODE_ID, clientManagerPlaybookScope, legacyClientManagerPlaybookNodeId, readClientManagerPlaybook } from "../../../src/agent/conversations/briefing/houseLessons.js";
import type { NodePlaybook } from "../../../src/agent/improvement/improvementTypes.js";
import type { StrategySignalSighting } from "../../../src/agent/improvement/strategyLearning.js";

// MemoryImprovementRepository keys its state by the `backend` string on a STATIC map, so two
// instances built with the same name share records. Each test gets its own name — otherwise a
// record written by one test satisfies the next test's "must be absent" assertion and the
// isolation claims here would pass for the wrong reason.

const NOW = "2026-09-15T10:00:00.000Z";
const lesson = (text: string) => ({ text, kind: "strategy" as const });

// A store double that records exactly which keys were written, because the whole back-compat claim
// is about a key string and nothing weaker would check it.
const storeDouble = () => {
  const blobs = new Map<string, unknown>();
  return {
    blobs,
    client: {
      async get(key: string) { return blobs.has(key) ? blobs.get(key) : null; },
      async setJSON(key: string, value: unknown) { blobs.set(key, value); },
      async list({ prefix }: { prefix: string }) { return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
      async delete(key: string) { blobs.delete(key); }
    } as never
  };
};

describe("playbook storage keys", () => {
  it("leaves the FLEET playbook at exactly the key it already occupies — introducing scope migrates nothing", async () => {
    const { blobs, client } = storeDouble();
    const repository = new BlobImprovementRepository(client);

    await repository.savePlaybook(applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("fleet craft")] }, NOW));

    expect([...blobs.keys()]).toEqual(["improvement/playbooks/draft_writer.json"]);
  });

  it("writes a site-scoped playbook to a NEW key beside it, and reads the two back separately", async () => {
    const { blobs, client } = storeDouble();
    const repository = new BlobImprovementRepository(client);
    const scope = { site: "dr-lurie" };

    await repository.savePlaybook(applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("fleet craft")] }, NOW));
    await repository.savePlaybook(applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("house lesson")] }, NOW, scope));

    expect([...blobs.keys()].sort()).toEqual([
      "improvement/playbooks/by-site/dr-lurie/draft_writer.json",
      "improvement/playbooks/draft_writer.json"
    ]);
    expect((await repository.getPlaybook("draft_writer"))?.items.map((item) => item.text)).toEqual(["fleet craft"]);
    expect((await repository.getPlaybook("draft_writer", scope))?.items.map((item) => item.text)).toEqual(["house lesson"]);
  });

  it("refuses a playbook scope that names a task, because the nodeId already addresses it", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    await expect(repository.getPlaybook("draft_writer", { site: "dr-lurie", task: "draft_writer" })).rejects.toThrow(/must not name a task/);
  });

  it("seeds shipped judgment-node playbooks at the FLEET scope only — a tenant never gets a forked copy of shared craft", async () => {
    const { client } = storeDouble();
    const repository = new BlobImprovementRepository(client);
    // layout_analyst carries a T15.17 seed; the site-scoped read must not materialize one.
    expect(await repository.getPlaybook("layout_analyst", { site: "dr-lurie" })).toBeUndefined();
    expect((await repository.getPlaybook("layout_analyst"))?.items.length).toBeGreaterThan(0);
  });
});

describe("applyPlaybookDelta scope guard", () => {
  it("refuses to apply a delta at a scope the stored record does not belong to", () => {
    const fleet = applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("fleet craft")] }, NOW);
    expect(() => applyPlaybookDelta(fleet, "draft_writer", { add: [lesson("house lesson")] }, NOW, { site: "dr-lurie" }))
      .toThrow(/scope mismatch/);
  });

  it("stamps the scope on a record it creates, and leaves a fleet record unstamped", () => {
    expect(createEmptyPlaybook("draft_writer", NOW).scope).toBeUndefined();
    expect(createEmptyPlaybook("draft_writer", NOW, { site: "dr-lurie" }).scope).toEqual({ site: "dr-lurie" });
  });
});

describe("playbookScopeChain", () => {
  it("is site then fleet, and fleet alone when there is no site — two reads, deliberately bounded", () => {
    expect(playbookScopeChain({ site: "dr-lurie" })).toEqual([{ site: "dr-lurie" }, {}]);
    expect(playbookScopeChain({})).toEqual([{}]);
  });

  it("does not walk the objective dimension, which has no playbook writer and would cost a read per dispatch", () => {
    expect(playbookScopeChain({ site: "dr-lurie" }).some((scope) => "objective" in scope)).toBe(false);
  });
});

describe("composeScopedPlaybooksForPrompt", () => {
  const playbook = (texts: string[], maxChars = 2000): NodePlaybook =>
    applyPlaybookDelta(undefined, "draft_writer", { add: texts.map(lesson) }, NOW) && {
      ...applyPlaybookDelta(undefined, "draft_writer", { add: texts.map(lesson) }, NOW),
      budget: { maxItems: 12, maxChars }
    };

  it("puts the house's lessons first and the fleet's after", () => {
    const composed = composeScopedPlaybooksForPrompt([playbook(["house lesson"]), playbook(["fleet craft"])]);
    expect(composed.split("\n")).toEqual(["- (strategy) house lesson", "- (strategy) fleet craft"]);
  });

  it("renders a lesson held at both scopes once, as the house's", () => {
    const composed = composeScopedPlaybooksForPrompt([playbook(["shared lesson"]), playbook(["shared lesson", "fleet craft"])]);
    expect(composed.split("\n")).toEqual(["- (strategy) shared lesson", "- (strategy) fleet craft"]);
  });

  it("is byte-identical to the single-playbook renderer for a node with only fleet lessons", () => {
    const fleet = playbook(["fleet craft", "another"]);
    expect(composeScopedPlaybooksForPrompt([fleet])).toBe(renderPlaybookForPrompt(fleet));
  });

  it("truncates at the LARGEST budget in the chain, dropping the fleet's tail rather than the house's lessons", () => {
    const house = playbook(["house lesson"], 40);
    const fleet = playbook(["fleet craft one", "fleet craft two"], 40);
    const composed = composeScopedPlaybooksForPrompt([house, fleet]);
    expect(composed).toContain("house lesson");
    expect(composed.length).toBeLessThanOrEqual(40);
  });
});

describe("composePlaybookForDispatch", () => {
  it("composes the chain and names the scopes that contributed", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    await repository.savePlaybook(applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("fleet craft")] }, NOW));
    await repository.savePlaybook(applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("house lesson")] }, NOW, { site: "dr-lurie" }));

    const composed = await composePlaybookForDispatch("draft_writer", { site: "dr-lurie" }, repository);

    expect(composed.text.split("\n")).toEqual(["- (strategy) house lesson", "- (strategy) fleet craft"]);
    expect(composed.scopeKeys).toEqual(["site=dr-lurie", "fleet"]);
    expect(composed.unreadableScopeKeys).toEqual([]);
  });

  it("degrades to the rest of the chain when one scope cannot be read, and reports which", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    await repository.savePlaybook(applyPlaybookDelta(undefined, "draft_writer", { add: [lesson("fleet craft")] }, NOW));
    const flaky = {
      ...repository,
      getPlaybook: async (nodeId: string, scope?: { site?: string }) => {
        if (scope?.site) throw new Error("store unreachable");
        return repository.getPlaybook(nodeId);
      }
    } as never;

    const composed = await composePlaybookForDispatch("draft_writer", { site: "dr-lurie" }, flaky);

    expect(composed.text).toContain("fleet craft");
    expect(composed.unreadableScopeKeys).toEqual(["site=dr-lurie"]);
  });
});

describe("promoteStrategySignals", () => {
  // The same two-window, above-the-n-bar shape the strategyLearning suite uses to make a signal
  // stable enough to promote; what is under test here is only WHERE it lands.
  const stableSightings = [
    { from: "2026-08-17", to: "2026-08-24" },
    { from: "2026-08-24", to: "2026-08-31" }
  ].map((window) => ({
    strategy: "objection_first", intent: "objection_handling", metric: "p75_dwell_ms" as const, direction: "above" as const, n: 400, window,
    finding: { metric: "p75_dwell_ms" as const, direction: "above" as const, value: 42000, siteFigure: 20000, ratio: 2.1 }
  })) as unknown as StrategySignalSighting[];

  it("writes ONE TENANT'S measured signals into that tenant's playbook, and leaves the fleet's alone", async () => {
    // The leak fix. Before scope, these landed on the global per-node playbook — the one every
    // OTHER tenant's dispatch of that node reads — with nothing on the record saying whose
    // evidence it was.
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);

    const outcome = await promoteStrategySignals(stableSightings, { improvementRepository: repository }, { scope: { site: "dr-lurie" }, nodeIds: ["draft_writer"] });

    expect(outcome.promoted.map((entry) => entry.nodeId)).toEqual(["draft_writer"]);
    expect(outcome.scopeKey).toBe("site=dr-lurie");
    const scoped = await repository.getPlaybook("draft_writer", { site: "dr-lurie" });
    expect(scoped?.scope).toEqual({ site: "dr-lurie" });
    expect(scoped?.items).toHaveLength(1);
    expect(await repository.getPlaybook("draft_writer")).toBeUndefined();
  });

  it("still writes the fleet playbook when no scope is named", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    const outcome = await promoteStrategySignals(stableSightings, { improvementRepository: repository }, { nodeIds: ["draft_writer"] });
    expect(outcome.scopeKey).toBe("fleet");
    expect((await repository.getPlaybook("draft_writer"))?.items).toHaveLength(1);
  });
});

describe("readClientManagerPlaybook", () => {
  const houseLessons = (nodeId: string, scope?: { site?: string }) =>
    applyPlaybookDelta(undefined, nodeId, { add: [lesson(`lessons for ${scope?.site ?? "nobody"}`)] }, NOW, scope);

  it("reads the scoped record the vocabulary defines", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    await repository.savePlaybook(houseLessons(CLIENT_MANAGER_PLAYBOOK_NODE_ID, clientManagerPlaybookScope("dr-lurie")));
    expect((await readClientManagerPlaybook("dr-lurie", repository))?.items[0]?.text).toBe("lessons for dr-lurie");
  });

  it("falls back to the legacy nodeId convention for a tenant that has not been migrated", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    await repository.savePlaybook(applyPlaybookDelta(undefined, legacyClientManagerPlaybookNodeId("fernwell"), { add: [lesson("legacy lesson")] }, NOW));
    expect((await readClientManagerPlaybook("fernwell", repository))?.items[0]?.text).toBe("legacy lesson");
  });

  it("NEVER falls back to the fleet playbook — a tenant with no lessons has no lessons", async () => {
    const repository = new MemoryImprovementRepository(`memory-${Math.random()}`);
    await repository.savePlaybook(applyPlaybookDelta(undefined, CLIENT_MANAGER_PLAYBOOK_NODE_ID, { add: [lesson("someone else's correction")] }, NOW));
    expect(await readClientManagerPlaybook("fernwell", repository)).toBeUndefined();
  });
});

describe("the playbook MCP surface", () => {
  const tools = createWorkspaceTools({});
  const call = async (name: string, input: unknown) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`tool not registered: ${name}`);
    return (await found.execute(input)) as { ok: true; data: any };
  };

  beforeEach(() => { resetRepositoryManager(); });
  afterEach(() => { resetRepositoryManager(); });

  it("registers playbook.migrate_scope", () => {
    expect(tools.map((tool) => tool.name)).toContain("playbook.migrate_scope");
  });

  it("reads and writes a tenant's playbook without touching the fleet's, and composes what a dispatch gets", async () => {
    await call("playbook.apply_delta", { nodeId: "draft_writer", delta: { add: [{ text: "fleet craft", kind: "strategy" }] } });
    await call("playbook.apply_delta", { nodeId: "draft_writer", projectId: "dr-lurie", delta: { add: [{ text: "house lesson", kind: "strategy" }] } });

    const fleet = await call("playbook.get", { nodeId: "draft_writer" });
    expect(fleet.data.scope).toBe("fleet");
    expect(fleet.data.playbook.items.map((item: { text: string }) => item.text)).toEqual(["fleet craft"]);

    const tenant = await call("playbook.get", { nodeId: "draft_writer", projectId: "dr-lurie" });
    expect(tenant.data.scope).toBe("site=dr-lurie");
    expect(tenant.data.playbook.items.map((item: { text: string }) => item.text)).toEqual(["house lesson"]);
    expect(tenant.data.composed.text.split("\n")).toEqual(["- (strategy) house lesson", "- (strategy) fleet craft"]);
    expect(tenant.data.composed.scopeKeys).toEqual(["site=dr-lurie", "fleet"]);

    // Another tenant reads the fleet's lessons and nothing of dr-lurie's.
    const other = await call("playbook.get", { nodeId: "draft_writer", projectId: "fernwell" });
    expect(other.data.playbook).toBeNull();
    expect(other.data.composed.text).toBe("- (strategy) fleet craft");
  });

  it("migrate_scope is DRY BY DEFAULT and writes nothing until told to", async () => {
    await repositoryManager.getImprovementRepository().savePlaybook(
      applyPlaybookDelta(undefined, legacyClientManagerPlaybookNodeId("dr-lurie"), { add: [lesson("legacy correction")] }, NOW)
    );

    const preview = await call("playbook.migrate_scope", { projectIds: ["dr-lurie"] });
    expect(preview.data).toMatchObject({ dryRun: true, copied: ["dr-lurie"], alreadyScoped: [], noLegacyRecord: [] });
    expect(await repositoryManager.getImprovementRepository().getPlaybook(CLIENT_MANAGER_PLAYBOOK_NODE_ID, clientManagerPlaybookScope("dr-lurie"))).toBeUndefined();

    const applied = await call("playbook.migrate_scope", { projectIds: ["dr-lurie"], dryRun: false });
    expect(applied.data.copied).toEqual(["dr-lurie"]);
    const migrated = await repositoryManager.getImprovementRepository().getPlaybook(CLIENT_MANAGER_PLAYBOOK_NODE_ID, clientManagerPlaybookScope("dr-lurie"));
    expect(migrated?.items.map((item) => item.text)).toEqual(["legacy correction"]);
    // Non-destructive: the legacy record is still there, so the briefing's fallback still works and
    // a migration run against the wrong tenant loses nothing.
    expect(await repositoryManager.getImprovementRepository().getPlaybook(legacyClientManagerPlaybookNodeId("dr-lurie"))).toBeDefined();
  });

  it("skips a tenant that already has a scoped playbook rather than merging two curated lists", async () => {
    const repository = repositoryManager.getImprovementRepository();
    await repository.savePlaybook(applyPlaybookDelta(undefined, legacyClientManagerPlaybookNodeId("dr-lurie"), { add: [lesson("legacy correction")] }, NOW));
    await repository.savePlaybook(applyPlaybookDelta(undefined, CLIENT_MANAGER_PLAYBOOK_NODE_ID, { add: [lesson("already migrated")] }, NOW, clientManagerPlaybookScope("dr-lurie")));

    const result = await call("playbook.migrate_scope", { projectIds: ["dr-lurie", "fernwell"], dryRun: false });

    expect(result.data).toMatchObject({ copied: [], alreadyScoped: ["dr-lurie"], noLegacyRecord: ["fernwell"] });
    expect((await repository.getPlaybook(CLIENT_MANAGER_PLAYBOOK_NODE_ID, clientManagerPlaybookScope("dr-lurie")))?.items.map((item) => item.text)).toEqual(["already migrated"]);
  });
});

/**
 * SOURCE-PINNED, deliberately — the same device #360 used for the rail's dead query, and for the same
 * reason: what has to hold here is that the runner ASKS FOR THE TENANT'S CHAIN, and a behavioural
 * test that drives a whole model dispatch would still pass if `{ site: run.projectId }` quietly
 * became `{}`. Every tenant would silently fall back to fleet-only lessons and every other assertion
 * in this file would stay green. This is the one regression scope cannot detect from its own output.
 */
describe("both node runners read the tenant's chain, not one global playbook", () => {
  const runners = ["OpenAINodeRunner", "AnthropicNodeRunner"];

  it("calls composePlaybookForDispatch with the run's own projectId as the site", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const runner of runners) {
      const source = await readFile(new URL(`../../../src/agent/execution/runners/${runner}.ts`, import.meta.url), "utf8");
      expect(source, runner).toContain("composePlaybookForDispatch(node.id, { site: context.run.projectId }");
      // And no direct per-node read survives beside it: one such call is a playbook that skips the chain.
      expect(source.includes("getPlaybook("), `${runner} reads a playbook directly`).toBe(false);
    }
  });
});

beforeEach(() => { vi.stubEnv("WORKSPACE_STORE", "memory"); });
afterEach(() => { vi.unstubAllEnvs(); });
