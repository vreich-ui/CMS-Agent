import { describe, expect, it, vi } from "vitest";
import { AGGRESSION_DIALS, type AggressionVector } from "../../../src/agent/workspace/aggressionVector.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// S3 item 3 — a model that emits NO `resolved` (or an all-zero placeholder) never ships that: the
// engine writes its own value and stamps `resolved_vector_engine_owned`. With a ceiling in the run the
// clamp supplies min(ceiling, target); with only a target the engine writes the target (unclamped,
// still loudly warned — Wolf's no-ceiling ruling is unchanged upstream).

const vector = (values: [number, number, number, number]): AggressionVector =>
  Object.fromEntries(AGGRESSION_DIALS.map((dial, index) => [dial, values[index]])) as AggressionVector;
const ceiling = vector([0.6, 0.4, 0.5, 0.7]);
const target = vector([0.8, 0.3, 0.9, 0.5]);
const zero = vector([0, 0, 0, 0]);

const runWith = async (emitted: Record<string, unknown>, stage: Record<string, unknown>) => {
  const node = getWorkspaceNode("input_triage")!;
  const schemaWithVector = { ...(node.outputSchema as Record<string, unknown>), properties: { ...((node.outputSchema as { properties: Record<string, unknown> }).properties), resolved: { type: "object" }, resolvedBasis: { type: "string" } } };
  const workspaceRepository = new RepositoryManager().getWorkspaceRepository();
  await workspaceRepository.updateNode(node.id, { outputSchema: schemaWithVector }, { actor: "test" });
  const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
    supports: () => true,
    validateConfiguration: () => ({ ok: true as const }),
    run: async () => ({ ok: true as const, output: { artifact: "content_source.v1", summary: "Triaged.", ...emitted } })
  } as never);
  try {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "openai", projectId: "project-a", input: { topic: "resolved vector fixture", placement: "x" } }, store);
    const seeded = (await getRun(started.runId, store))!;
    seeded.stageOutputs.contract_intelligence = stage;
    await store.saveRun(seeded);
    const advanced = await runNextNode(started.runId, { executionRepository: store, workspaceRepository });
    return advanced.nodes.find((entry) => entry.nodeId === "input_triage")!;
  } finally {
    spy.mockRestore();
  }
};

describe("engine-owned resolved vector when the model leaves it blank", () => {
  it("missing `resolved` with a ceiling → engine value min(ceiling, target) and resolved_vector_engine_owned", async () => {
    const state = await runWith({}, { resolvedAggression: { ceiling, target } });
    expect(state.status).toBe("completed");
    expect((state.output as { resolved: AggressionVector }).resolved).toEqual(vector([0.6, 0.3, 0.5, 0.5]));
    expect(state.warnings).toContain("resolved_vector_engine_owned");
  });

  it("all-zero `resolved` with only a target → engine writes the target and names the takeover", async () => {
    const state = await runWith({ resolved: zero, resolvedBasis: "placeholder" }, { resolvedAggression: { target } });
    expect(state.status).toBe("completed");
    expect((state.output as { resolved: AggressionVector }).resolved).toEqual(target);
    expect((state.output as { resolvedBasis: string }).resolvedBasis).toMatch(/engine-owned/);
    expect(state.warnings).toContain("resolved_vector_engine_owned");
    expect(state.warnings?.some((warning) => warning.startsWith("resolved_vector_unclamped"))).toBe(true);
  });

  it("a model value that already agrees is left alone with no engine-owned warning", async () => {
    const state = await runWith({ resolved: vector([0.6, 0.3, 0.5, 0.5]), resolvedBasis: "min(ceiling, target)" }, { resolvedAggression: { ceiling, target } });
    expect(state.warnings ?? []).not.toContain("resolved_vector_engine_owned");
  });
});
