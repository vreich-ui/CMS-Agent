import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptimizerDeps, NodeAnalysis } from "../../src/agent/improvement/optimizer.js";
import type { EvalResult } from "../../src/agent/improvement/improvementTypes.js";
import { heuristicCurationDelta, curatorDeltaFromOutput, curatePlaybook } from "../../src/agent/improvement/curator.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 7 (docs/platform/DIRECTION.md §7): LLM-driven playbook curation. curatePlaybook has a
// deterministic "mock" heuristic (default) and an "openai" Reflector→Curator pass; the LLM output is
// mapped to a validated PlaybookDelta by the pure curatorDeltaFromOutput. These tests pin the heuristic,
// the pure mapping (malformed-input rejection + provenance), and the mock curation e2e over real repos.

const analysis = (over: Partial<NodeAnalysis> = {}): NodeAnalysis => ({
  nodeId: "n", sampleSize: 4, worstCriteria: [], failureCodes: {},
  feedback: { approvals: 0, rejections: 0, edits: 0, outcomes: 0 },
  evidence: { evalIds: [], runIds: [], feedbackIds: [] }, ...over
});

describe("heuristicCurationDelta", () => {
  it("returns null with no criterion evidence", () => {
    expect(heuristicCurationDelta(analysis({ worstCriteria: [] }))).toBeNull();
  });
  it("turns the weakest criterion into a pitfall lesson with cited evidence", () => {
    const delta = heuristicCurationDelta(analysis({ worstCriteria: [{ criterionId: "clarity", meanScore: 1.2, maxScore: 5 }], evidence: { evalIds: ["e1", "e2", "e3", "e4", "e5", "e6"], runIds: [], feedbackIds: [] } }));
    expect(delta?.add).toHaveLength(1);
    expect(delta!.add![0]!.kind).toBe("pitfall");
    expect(delta!.add![0]!.text).toContain("clarity");
    expect(delta!.add![0]!.provenance?.evalIds).toEqual(["e1", "e2", "e3", "e4", "e5"]); // capped at 5
  });
});

describe("curatorDeltaFromOutput (pure mapping)", () => {
  it("keeps well-formed adds, tags provenance, and caps cited evals at 5", () => {
    const delta = curatorDeltaFromOutput({ add: [{ text: "  Lead with the reader's objection.  ", kind: "strategy" }] }, ["a", "b", "c", "d", "e", "f"]);
    expect(delta.add).toHaveLength(1);
    expect(delta.add![0]).toMatchObject({ text: "Lead with the reader's objection.", kind: "strategy", provenance: { source: "reflector", evalIds: ["a", "b", "c", "d", "e"] } });
  });
  it("drops malformed adds (empty text or unknown kind) and non-string retire ids", () => {
    const delta = curatorDeltaFromOutput({
      add: [{ text: "", kind: "pitfall" }, { text: "keep me", kind: "bogus" }, { text: "valid", kind: "constraint" }],
      retire: ["item_1", 42 as unknown as string, ""]
    }, []);
    expect(delta.add).toEqual([{ text: "valid", kind: "constraint", provenance: { source: "reflector", evalIds: [] } }]);
    expect(delta.retire).toEqual(["item_1"]);
  });
  it("produces an empty delta from an empty/garbage output", () => {
    expect(curatorDeltaFromOutput({}, [])).toEqual({});
    expect(curatorDeltaFromOutput({ add: "nope" as unknown as [] }, [])).toEqual({});
  });
});

describe("curatePlaybook (mock, real repositories)", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  const realDeps = (): OptimizerDeps => ({
    workspaceRepository: repositoryManager.getWorkspaceRepository(),
    executionRepository: repositoryManager.getExecutionRepository(),
    improvementRepository: repositoryManager.getImprovementRepository(),
    evaluationRepository: repositoryManager.getEvaluationRepository()
  });
  let counter = 0;
  const scoredEval = (nodeId: string, criterionId: string, score: number, max: number): EvalResult => ({
    evalId: `eval_${counter++}`, rubricId: "rub", nodeId, subjectHash: "h",
    scores: [{ criterionId, score, max, evidence: "" }], normalizedScore: score / max, pass: score / max >= 0.7,
    judge: { mode: "mock", model: "m" }, createdAt: "2026-07-01T00:00:00.000Z"
  });

  it("is a no-op for a node with no criterion evidence", async () => {
    const result = await curatePlaybook({ nodeId: "narrative_movement", mode: "mock" }, realDeps());
    expect(result.curated).toBe(false);
    expect(result.reason).toContain("No criterion-level");
  });

  it("adds a pitfall lesson for the weakest criterion and persists the playbook", async () => {
    const evalRepo = repositoryManager.getEvaluationRepository();
    for (let index = 0; index < 3; index++) await evalRepo.recordResult(scoredEval("reader_insight", "clarity", 1, 5));
    const result = await curatePlaybook({ nodeId: "reader_insight", mode: "mock" }, realDeps());
    expect(result.curated).toBe(true);
    expect(result.mode).toBe("mock");
    expect(result.playbook!.items.some((item) => item.kind === "pitfall" && item.text.includes("clarity"))).toBe(true);
    // Persisted and idempotent: re-curating the same evidence dedups instead of stacking a duplicate.
    const again = await curatePlaybook({ nodeId: "reader_insight", mode: "mock" }, realDeps());
    expect(again.playbook!.items.filter((item) => item.text.includes("clarity"))).toHaveLength(1);
  });
});
