// Pure planning/diffing/refusal logic for scripts/reseedStoreFromCanonical.ts, exercised against
// SYNTHETIC canonical/store node sets — no live repository, no process spawn. main() is guarded
// behind an isDirectRun check (mirroring scripts/twoPlaneDrift.ts) so importing this module never
// touches the store or calls process.exit.
import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_SHRINK,
  PUBLISH_EXECUTOR_MODE_VALUES,
  RESEED_ALLOWLIST,
  TOPOLOGY_FIELDS,
  planPublishExecutorMode,
  planReseed
} from "../../../scripts/reseedStoreFromCanonical.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const makeNode = (partial: Partial<WorkspaceNode> & { id: string }): WorkspaceNode => ({
  name: partial.id,
  kind: "test",
  description: "a test node",
  prompt: "base prompt text",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  allowedTools: [],
  assignedSkills: [],
  requiredInputs: [],
  produces: [],
  riskLevel: "read",
  dependsOn: [],
  status: "active",
  position: { x: 0, y: 0 },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...partial
});

// Base fixture: one node per real allowlist entry, canonical/store identical to start. Each test
// mutates exactly the field(s) it needs, so an assertion of "exactly one write" is meaningful.
const baseCanonical = (): WorkspaceNode[] => [
  makeNode({ id: "topic_opportunity", allowedTools: ["stage.get_output", "stage.list_outputs"] }),
  makeNode({
    id: "brief_architect",
    prompt: "Brief architect canonical prompt describing mediaSlots requirements in reasonable detail.",
    outputSchema: { type: "object", required: ["mediaSlots"] }
  }),
  makeNode({
    id: "artifact_plan",
    prompt: "Artifact plan canonical prompt describing the one-turn materialization spec it emits, in reasonable detail.",
    // W8 — the five fields the store overrides wholesale and that a redeploy alone does not move.
    outputSchema: { type: "object", required: ["slots"] },
    schema: { type: "object", required: ["slots"] },
    allowedTools: ["stage.get_output", "stage.list_outputs"],
    assignedSkills: ["contract_intelligence"],
    modelConfig: { maxTurns: 1, toolCallLimit: 0, budgetUsd: 0.5 }
  }),
  makeNode({
    id: "article_body",
    prompt: "Article body canonical prompt describing verified media binding into body.image in detail."
  }),
  makeNode({
    id: "publish_executor",
    riskLevel: "publish",
    allowedTools: ["project.call_tool", "stage.get_output"],
    metadata: { publishExecutorDeterministic: "execute" }
  })
];
const baseStore = (): WorkspaceNode[] => baseCanonical().map((node) => structuredClone(node));

// Per-field mutator producing a value that visibly differs from canonical, used to synthesize drift.
// allowedTools drops a tool from the STORE side (canonical GAINS one) rather than adding a stray one,
// so this generic "one field drifted" loop never trips the new capability-loss guard — that guard has
// its own dedicated tests below, deliberately built to fire.
const mutateField = (node: WorkspaceNode, field: string): WorkspaceNode => {
  switch (field) {
    case "allowedTools": return { ...node, allowedTools: node.allowedTools.slice(0, -1) };
    case "prompt": return { ...node, prompt: `${node.prompt} (stale store copy)` };
    case "outputSchema": return { ...node, outputSchema: { type: "object" } };
    // W8 fields. Like allowedTools above, the two list-valued ones drift by the STORE holding MORE
    // than canonical, so this generic loop never trips the capability-loss guard — that guard has its
    // own dedicated tests, and W8's real re-seed does trip it on purpose.
    case "schema": return { ...node, schema: { type: "object" } };
    case "assignedSkills": return { ...node, assignedSkills: [...(node.assignedSkills ?? []), "stale_skill"] };
    case "modelConfig": return { ...node, modelConfig: { ...(node.modelConfig ?? {}), toolCallLimit: 8, budgetUsd: 2 } };
    default: throw new Error(`no mutator for field "${field}"`);
  }
};

describe("planReseed — a matching store", () => {
  // main() maps an empty plan (no writes, no refusals) to exit 0; this test proves the plan itself
  // is empty, which is the part that logic bug could get wrong.
  it("produces an empty plan when the store already matches canonical for every allowlisted pair", () => {
    const plan = planReseed({ canonical: baseCanonical(), store: baseStore() });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.upToDate).toHaveLength(RESEED_ALLOWLIST.length);
  });
});

describe("planReseed — drift detection", () => {
  it.each(RESEED_ALLOWLIST)("plans exactly one write for $nodeId.$field when only that field drifts", (entry) => {
    const canonical = baseCanonical();
    const store = baseStore().map((node) => (node.id === entry.nodeId ? mutateField(node, entry.field) : node));
    const plan = planReseed({ canonical, store });

    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].nodeId).toBe(entry.nodeId);
    expect(plan.writes[0].field).toBe(entry.field);
    expect(plan.writes[0].note).toBe(entry.note);
  });

  it("never plans a non-allowlisted field, even when it visibly differs", () => {
    const canonical = baseCanonical();
    const store = baseStore().map((node) => (node.id === "topic_opportunity" ? { ...node, description: "stale description nobody re-seeds" } : node));
    const plan = planReseed({ canonical, store, requests: [{ nodeId: "topic_opportunity", field: "description" }] });

    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/not in RESEED_ALLOWLIST/);
  });
});

describe("planReseed — refusals", () => {
  it("refuses when the node does not exist in canonical", () => {
    const canonical = baseCanonical().filter((node) => node.id !== "topic_opportunity");
    const plan = planReseed({ canonical, store: baseStore(), requests: [{ nodeId: "topic_opportunity", field: "allowedTools" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/does not exist in canonical/);
  });

  it("refuses when the node does not exist in the live store", () => {
    const store = baseStore().filter((node) => node.id !== "topic_opportunity");
    const plan = planReseed({ canonical: baseCanonical(), store, requests: [{ nodeId: "topic_opportunity", field: "allowedTools" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/does not exist in the live store/);
  });

  it("refuses a prompt shrink past the ceiling", () => {
    const canonical = baseCanonical().map((node) => (node.id === "artifact_plan" ? { ...node, prompt: "x".repeat(300) } : node));
    const store = baseStore().map((node) => (node.id === "artifact_plan" ? { ...node, prompt: "x".repeat(1000) } : node));
    const plan = planReseed({ canonical, store, requests: [{ nodeId: "artifact_plan", field: "prompt" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/prompt would shrink 1000 -> 300 chars/);
    expect(plan.refusals[0].reason).toMatch(new RegExp(`${Math.round(MAX_PROMPT_SHRINK * 100)}%`));
  });

  it("clears the prompt-shrink refusal with --allow-prompt-shrink and plans the write", () => {
    const canonical = baseCanonical().map((node) => (node.id === "artifact_plan" ? { ...node, prompt: "x".repeat(300) } : node));
    const store = baseStore().map((node) => (node.id === "artifact_plan" ? { ...node, prompt: "x".repeat(1000) } : node));
    const plan = planReseed({ canonical, store, requests: [{ nodeId: "artifact_plan", field: "prompt" }], allowPromptShrink: true });
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].afterLength).toBe(300);
  });

  it("refuses a write that would grant project.call_tool to a publish-risk node", () => {
    const canonical = [makeNode({ id: "publish_executor", riskLevel: "publish", allowedTools: ["project.call_tool", "stage.get_output"] })];
    const store = [makeNode({ id: "publish_executor", riskLevel: "publish", allowedTools: ["stage.get_output"] })];
    const allowlist = [{ nodeId: "publish_executor", field: "allowedTools" as const, note: "test-only" }];
    const plan = planReseed({ canonical, store, allowlist, requests: [{ nodeId: "publish_executor", field: "allowedTools" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/GRANT "project.call_tool"/);
    expect(plan.refusals[0].reason).toMatch(/publish-risk node/);
  });

  it("does NOT refuse an allowedTools write on a publish-risk node that already holds project.call_tool", () => {
    const canonical = [makeNode({ id: "publish_executor", riskLevel: "publish", allowedTools: ["project.call_tool", "stage.save_output"] })];
    const store = [makeNode({ id: "publish_executor", riskLevel: "publish", allowedTools: ["project.call_tool"] })];
    const allowlist = [{ nodeId: "publish_executor", field: "allowedTools" as const, note: "test-only" }];
    const plan = planReseed({ canonical, store, allowlist, requests: [{ nodeId: "publish_executor", field: "allowedTools" }] });
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
  });

  it("refuses when canonical metadata is undefined rather than writing undefined over a populated store row", () => {
    // publish_executor.metadata is deliberately NOT in the real RESEED_ALLOWLIST (see the allowlist's
    // own comment) — this test injects a test-only allowlist entry purely to exercise the guard.
    const canonical = baseCanonical().map((node) => (node.id === "publish_executor" ? { ...node, metadata: undefined } : node));
    const allowlist = [{ nodeId: "publish_executor", field: "metadata" as const, note: "test-only" }];
    const plan = planReseed({ canonical, store: baseStore(), allowlist, requests: [{ nodeId: "publish_executor", field: "metadata" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/canonical "metadata".*is undefined/);
  });

  it("refuses when canonical allowedTools is undefined", () => {
    const canonical = baseCanonical().map((node) => (node.id === "topic_opportunity" ? { ...node, allowedTools: undefined as unknown as string[] } : node));
    const allowlist = [{ nodeId: "topic_opportunity", field: "allowedTools" as const, note: "test-only" }];
    const plan = planReseed({ canonical, store: baseStore(), allowlist, requests: [{ nodeId: "topic_opportunity", field: "allowedTools" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/canonical "allowedTools".*is undefined/);
  });

  it.each(TOPOLOGY_FIELDS)('refuses a "%s" (topology) write and names the redeploy requirement', (field) => {
    const plan = planReseed({ canonical: baseCanonical(), store: baseStore(), requests: [{ nodeId: "artifact_plan", field }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/TOPOLOGY field/);
    expect(plan.refusals[0].reason).toMatch(/re-seed of nodes\.ts .* followed by a REDEPLOY/);
  });
});

describe("planReseed — generalized capability-loss refusal (metadata/allowedTools)", () => {
  it("refuses a metadata write that would remove keys present in the store, naming them", () => {
    const canonical = [makeNode({ id: "brief_architect", metadata: { keep: 1 } })];
    const store = [makeNode({ id: "brief_architect", metadata: { keep: 1, willBeLost: "important" } })];
    const allowlist = [{ nodeId: "brief_architect", field: "metadata" as const, note: "test-only" }];
    const plan = planReseed({ canonical, store, allowlist, requests: [{ nodeId: "brief_architect", field: "metadata" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/would REMOVE 1 entry/);
    expect(plan.refusals[0].reason).toMatch(/willBeLost/);
  });

  it("refuses an allowedTools write that would remove a tool present in the store, naming it (not just project.call_tool)", () => {
    const canonical = baseCanonical().map((node) => (node.id === "topic_opportunity" ? { ...node, allowedTools: ["stage.get_output"] } : node));
    const store = baseStore().map((node) => (node.id === "topic_opportunity" ? { ...node, allowedTools: ["stage.get_output", "stage.list_outputs"] } : node));
    const plan = planReseed({ canonical, store, requests: [{ nodeId: "topic_opportunity", field: "allowedTools" }] });
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/would REMOVE 1 entry/);
    expect(plan.refusals[0].reason).toMatch(/stage\.list_outputs/);
  });

  it("clears the capability-loss refusal with --allow-capability-loss and plans the write", () => {
    const canonical = [makeNode({ id: "brief_architect", metadata: { keep: 1 } })];
    const store = [makeNode({ id: "brief_architect", metadata: { keep: 1, willBeLost: "important" } })];
    const allowlist = [{ nodeId: "brief_architect", field: "metadata" as const, note: "test-only" }];
    const plan = planReseed({ canonical, store, allowlist, requests: [{ nodeId: "brief_architect", field: "metadata" }], allowCapabilityLoss: true });
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].afterValue).toEqual({ keep: 1 });
  });

  it("plans no publish_executor.metadata write via the allowlist path — it was removed by design", () => {
    expect(RESEED_ALLOWLIST.some((entry) => entry.nodeId === "publish_executor" && entry.field === "metadata")).toBe(false);
    const canonical = [makeNode({ id: "publish_executor", metadata: { foo: "canonical-only" } })];
    const store = [makeNode({ id: "publish_executor", metadata: { foo: "store", bar: "kept" } })];
    // Default requests (no explicit `requests`) derive from RESEED_ALLOWLIST, i.e. exactly what
    // `--write` with no --set-publish-executor-mode flag would send.
    const plan = planReseed({ canonical, store });
    expect(plan.writes.some((write) => write.nodeId === "publish_executor")).toBe(false);
    expect(plan.refusals.some((refusal) => refusal.nodeId === "publish_executor")).toBe(false);
  });
});

describe("planPublishExecutorMode — the merge-only replacement for the removed allowlist entry", () => {
  it("merges publishExecutorDeterministic and preserves every sibling metadata key byte-for-byte", () => {
    const store = [makeNode({ id: "publish_executor", metadata: { activationRequired: false, approvalRequired: false, canonicalRules: ["a", "b"], goLive: { enabledAt: "2026-07-31" } } })];
    const result = planPublishExecutorMode({ store, mode: "execute" });
    expect(result.status).toBe("write");
    if (result.status !== "write") throw new Error("expected write");
    expect(result.write.afterValue).toEqual({ activationRequired: false, approvalRequired: false, canonicalRules: ["a", "b"], goLive: { enabledAt: "2026-07-31" }, publishExecutorDeterministic: "execute" });
    expect(result.write.kind).toBe("publish_executor_mode");
  });

  it('writes boolean true for "gate" (matching readPublishExecutorDeterministicMode\'s tri-state contract)', () => {
    const store = [makeNode({ id: "publish_executor", metadata: { keep: "me" } })];
    const result = planPublishExecutorMode({ store, mode: "gate" });
    expect(result.status).toBe("write");
    if (result.status !== "write") throw new Error("expected write");
    expect(result.write.afterValue).toEqual({ keep: "me", publishExecutorDeterministic: true });
  });

  it.each(["off", "GATE", "Execute", "", "true"])('refuses an invalid mode value "%s" by name', (badMode) => {
    const store = [makeNode({ id: "publish_executor", metadata: { keep: "me" } })];
    const result = planPublishExecutorMode({ store, mode: badMode });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("expected refused");
    expect(result.refusal.reason).toContain(JSON.stringify(badMode));
    expect(PUBLISH_EXECUTOR_MODE_VALUES).toEqual(["gate", "execute"]);
  });

  it("refuses when the store's publish_executor node has no metadata object at all", () => {
    const store = [makeNode({ id: "publish_executor", metadata: undefined })];
    const result = planPublishExecutorMode({ store, mode: "execute" });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("expected refused");
    expect(result.refusal.reason).toMatch(/no metadata object at all/);
  });

  it("refuses when publish_executor does not exist in the store", () => {
    const result = planPublishExecutorMode({ store: [], mode: "gate" });
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("expected refused");
    expect(result.refusal.reason).toMatch(/does not exist in the live store/);
  });

  it("reports up_to_date rather than a write when the flag already matches", () => {
    const store = [makeNode({ id: "publish_executor", metadata: { publishExecutorDeterministic: "execute" } })];
    expect(planPublishExecutorMode({ store, mode: "execute" }).status).toBe("up_to_date");
  });
});
