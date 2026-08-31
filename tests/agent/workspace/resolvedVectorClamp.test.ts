import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENGINE_RESOLVED_VECTOR_POLICY,
  applyResolvedVectorClamp,
  declaresResolvedVector,
  readResolvedVectorSources
} from "../../../src/agent/workspace/resolvedVectorClamp.js";
import { AGGRESSION_DIALS, type AggressionVector } from "../../../src/agent/workspace/aggressionVector.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { declaresContractPrefetch } from "../../../src/agent/workspace/nodeGatingSeed.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// W6 item 3 (determinism program, 2026-08-12). `resolved = min(ceiling, target)` is arithmetic the
// engine owns. The live run shipped it unclamped because the contract prefetch ran AFTER
// brief_architect, so the model filled a required field from the only vector in sight — the target —
// and the ceiling blocker surfaced after the draft was already written against it.

const vector = (values: [number, number, number, number]): AggressionVector =>
  Object.fromEntries(AGGRESSION_DIALS.map((dial, index) => [dial, values[index]])) as AggressionVector;

const ceiling = vector([0.6, 0.4, 0.5, 0.7]);
const target = vector([0.8, 0.3, 0.9, 0.5]);
// min componentwise: claim 0.6 (bound), urgency 0.3 (target), emotional 0.5 (bound), cta 0.5 (target).
const expected = vector([0.6, 0.3, 0.5, 0.5]);

const brief = (resolved?: unknown, extra: Record<string, unknown> = {}) => ({ artifact: "article_brief.v1", summary: "s", ...(resolved === undefined ? {} : { resolved }), ...extra });

describe("the clamp is arithmetic, and it wins", () => {
  it("computes min(ceiling, target) componentwise and overwrites whatever the model emitted", () => {
    const result = applyResolvedVectorClamp(brief(target), { ceiling, target });
    expect(result.resolved).toEqual(expected);
    expect((result.output as { resolved: AggressionVector }).resolved).toEqual(expected);
    expect(result.corrected).toBe(true);
    expect(result.clampedDials).toEqual(["claim_strength", "emotional_agitation"]);
    expect(result.warnings).toContain("resolved_vector_corrected:claim_strength,emotional_agitation");
  });

  it("writes the vector even when the model omitted the field entirely", () => {
    const result = applyResolvedVectorClamp(brief(undefined, { resolvedBasis: "" }), { ceiling, target }, { properties: { resolved: {} } });
    expect((result.output as { resolved: AggressionVector }).resolved).toEqual(expected);
    expect(result.corrected).toBe(true);
  });

  it("is still engine-computed when the model happened to agree — no warning, no churn", () => {
    const result = applyResolvedVectorClamp(brief(expected), { ceiling, target });
    expect(result.corrected).toBe(false);
    expect(result.warnings).toEqual([]);
    expect((result.output as { resolved: AggressionVector }).resolved).toEqual(expected);
    // The ceiling still bound two dials; that is a fact about the vectors, not about the model.
    expect(result.clampedDials).toEqual(["claim_strength", "emotional_agitation"]);
  });

  it("records nothing as clamped when the target was already under the ceiling everywhere", () => {
    const soft = vector([0.1, 0.1, 0.1, 0.1]);
    const result = applyResolvedVectorClamp(brief(soft), { ceiling, target: soft });
    expect(result.clampedDials).toEqual([]);
    expect(result.corrected).toBe(false);
  });

  it("never mutates the model's own output object", () => {
    const emitted = brief(target);
    applyResolvedVectorClamp(emitted, { ceiling, target });
    expect(emitted.resolved).toEqual(target);
  });
});

describe("what it refuses to do", () => {
  it("invents no ceiling: with none in the run the model's value is LEFT ALONE and warned about loudly", () => {
    const result = applyResolvedVectorClamp(brief(target), { target });
    expect((result.output as { resolved: AggressionVector }).resolved).toEqual(target);
    expect(result.corrected).toBe(false);
    expect(result.warnings).toEqual(["resolved_vector_unclamped:no_ceiling"]);
    // ...and a run that has neither a ceiling nor a value says exactly that.
    expect(applyResolvedVectorClamp(brief(undefined), {}, { properties: { resolved: {} } }).warnings).toEqual(["resolved_vector_unclamped:no_ceiling_and_no_value"]);
  });

  it("with a ceiling but no target, still enforces resolved ≤ ceiling and says the target was missing", () => {
    const result = applyResolvedVectorClamp(brief(target), { ceiling });
    expect(result.resolved).toEqual(vector([0.6, 0.3, 0.5, 0.5]));
    expect(result.warnings).toContain("resolved_vector_clamped_without_target");
  });

  it("touches nothing on a node that carries no resolved vector at all", () => {
    const output = { artifact: "content_source.v1", summary: "s" };
    const result = applyResolvedVectorClamp(output, { ceiling, target });
    expect(result.output).toBe(output);
    expect(result.warnings).toEqual([]);
    expect(declaresResolvedVector(output)).toBe(false);
    expect(declaresResolvedVector(output, { properties: { resolved: { type: "object" } } })).toBe(true);
  });

  it("ignores a malformed emitted vector rather than clamping garbage — the engine recomputes anyway", () => {
    const result = applyResolvedVectorClamp(brief({ claim_strength: "high" }), { ceiling, target });
    expect(result.resolved).toEqual(expected);
    expect(result.corrected).toBe(true);
  });
});

describe("the audit trail says what it computed from", () => {
  it("writes resolvedBasis as prose by default, naming both vectors, the formula and the bound dials", () => {
    const result = applyResolvedVectorClamp(brief(target), { ceiling, target, ceilingSource: "this dispatch's contract prefetch", targetSource: "placement_resolver (this run)" });
    const basis = (result.output as { resolvedBasis: string }).resolvedBasis;
    expect(basis).toMatch(/resolved = min\(ceiling, target\)/);
    expect(basis).toMatch(/never model-authored/);
    expect(basis).toMatch(/ceiling: claim_strength=0\.6/);
    expect(basis).toMatch(/placement_resolver \(this run\)/);
    expect(basis).toMatch(/BOUND the target on: claim_strength, emotional_agitation/);
  });

  it("matches the shape the node's own schema declares, so it cannot fail R-16 one line later", () => {
    const asObject = applyResolvedVectorClamp(brief(target), { ceiling, target }, { properties: { resolvedBasis: { type: "object" } } });
    expect((asObject.output as { resolvedBasis: Record<string, unknown> }).resolvedBasis).toMatchObject({ method: "engine_min_ceiling_target", ceiling, clampedDials: ["claim_strength", "emotional_agitation"] });
    const asArray = applyResolvedVectorClamp(brief(target), { ceiling, target }, { properties: { resolvedBasis: { type: "array" } } });
    expect(Array.isArray((asArray.output as { resolvedBasis: unknown }).resolvedBasis)).toBe(true);
  });

  it("says plainly when there was no target to resolve against", () => {
    const result = applyResolvedVectorClamp(brief(target), { ceiling });
    expect((result.output as { resolvedBasis: string }).resolvedBasis).toMatch(/target: not available to this run/);
  });
});

describe("where the vectors come from — never a model's retyped copy", () => {
  it("prefers THIS dispatch's own resolution", () => {
    const sources = readResolvedVectorSources({
      resolution: { ok: true, ceiling, target },
      stageOutputs: { contract_intelligence: { resolvedAggression: { ceiling: vector([1, 1, 1, 1]) } } }
    });
    expect(sources.ceiling).toEqual(ceiling);
    expect(sources.ceilingSource).toMatch(/prefetch/);
  });

  it("falls back to the deterministic contract_intelligence artifact, then to placement_resolver for the target", () => {
    const fromArtifact = readResolvedVectorSources({ stageOutputs: { contract_intelligence: { resolvedAggression: { ceiling, target } } } });
    expect(fromArtifact.ceiling).toEqual(ceiling);
    expect(fromArtifact.target).toEqual(target);

    const targetOnly = readResolvedVectorSources({ stageOutputs: { placement_resolver: { artifact: "placement_resolution.v1", target } } });
    expect(targetOnly.ceiling).toBeUndefined();
    expect(targetOnly.target).toEqual(target);
    expect(targetOnly.targetSource).toBe("placement_resolver stage output");
  });

  it("reads the ceiling straight off this dispatch's reduced contract when no resolution was computed", () => {
    expect(readResolvedVectorSources({ reducedCeiling: ceiling }).ceiling).toEqual(ceiling);
    expect(readResolvedVectorSources({ reducedCeiling: { claim_strength: 0.6 } }).ceiling).toBeUndefined();
  });

  it("refuses a mock placement placeholder as a target", () => {
    expect(readResolvedVectorSources({ stageOutputs: { placement_resolver: { dryRun: true, target } } }).target).toBeUndefined();
  });
});

// The topology half of W6.3: brief_architect now declares the contract prefetch, so the ceiling is a
// fact of the dispatch that WRITES the brief rather than of a node three steps later.
describe("wired into the conductor: the ceiling exists before the brief is written", () => {
  it("brief_architect declares contractPrefetch in the gating seed, and depends on placement_resolver for the target", () => {
    const node = getWorkspaceNode("brief_architect")!;
    expect(declaresContractPrefetch(node)).toBe(true);
    expect(node.dependsOn).toContain("placement_resolver");
    // contract_intelligence keeps its own prefetch (run-scoped cache makes the second one free) and
    // its position in the DAG is unchanged — the tail's declared edges are a hard invariant.
    expect(getWorkspaceNode("contract_intelligence")!.dependsOn).toEqual(["brief_architect"]);
  });

  it("tells the model the engine owns the field, so it does not spend a turn deriving one that is overwritten", () => {
    expect(ENGINE_RESOLVED_VECTOR_POLICY).toMatch(/min\(client ceiling, placement target\)/);
    expect(ENGINE_RESOLVED_VECTOR_POLICY).toMatch(/overwritten/);
  });

  it("overwrites a model-emitted resolved vector on a live dispatch, and stamps the audit warning", async () => {
    // A live-mode run whose runner is stubbed: input_triage emits an over-aggressive resolved vector
    // on a schema that declares the field, exactly as brief_architect did on the live run.
    const node = getWorkspaceNode("input_triage")!;
    const schemaWithVector = { ...(node.outputSchema as Record<string, unknown>), properties: { ...((node.outputSchema as { properties: Record<string, unknown> }).properties), resolved: { type: "object" }, resolvedBasis: { type: "string" } } };
    const workspaceRepository = new RepositoryManager().getWorkspaceRepository();
    await workspaceRepository.updateNode(node.id, { outputSchema: schemaWithVector }, { actor: "test" });

    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async () => ({ ok: true as const, output: { artifact: "content_source.v1", summary: "Triaged.", resolved: target, resolvedBasis: "I decided this myself." } })
    } as never);
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "openai", projectId: "project-a", input: { topic: "resolved vector fixture", placement: "x" } }, store);
      // Seed the vectors the engine resolves against, as an earlier deterministic node would have.
      const seeded = (await getRun(started.runId, store))!;
      seeded.stageOutputs.contract_intelligence = { resolvedAggression: { ceiling, target } };
      await store.saveRun(seeded);

      const advanced = await runNextNode(started.runId, { executionRepository: store, workspaceRepository });
      const state = advanced.nodes.find((entry) => entry.nodeId === "input_triage")!;
      expect(state.status).toBe("completed");
      expect((state.output as { resolved: AggressionVector }).resolved).toEqual(expected);
      expect((state.output as { resolvedBasis: string }).resolvedBasis).toMatch(/Engine-computed/);
      expect(state.warnings).toContain("resolved_vector_clamped:claim_strength,emotional_agitation");
      expect(state.warnings?.some((warning) => warning.startsWith("resolved_vector_corrected:"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
