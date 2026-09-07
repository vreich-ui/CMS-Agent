import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";

// W1.2 (run_1788769566432_5qnafb) — WHAT THE REVISION DISPATCH ACTUALLY PUTS IN `input`.
//
// articleBodyValidationLoop.test.ts proves the SHAPE buildValidationFeedback produces. This file
// proves the wiring: that the executor's own revise callback is what hands that shape to the runner,
// on a real dispatch, with the rejected envelope genuinely gone from `input`.
//
// It has to be observed here and nowhere else. `previousOutput` was never a field anyone chose to
// keep — it was the model's entire ~29-30K-character prior envelope, spread into the revision's
// `input` at the one seam that no bound applies to (the runner strips only `dependencies` and
// `imageRefs` before prompting, and boundDependencyOutput covers `dependencyOutputs`). A unit test of
// the builder cannot fail if someone re-adds it at the call site; this one can.

type Dispatch = { input: Record<string, unknown> };
const dispatches: Dispatch[] = [];

// A body with real bulk in it. The point of this change is that the revision no longer carries the
// envelope, and "no longer carries it" is only a claim worth testing against an envelope big enough
// to be worth carrying — the live one was ~29-30K characters.
const REJECTED_BODY = {
  slug: "barrier-repair",
  title: "Barrier repair",
  nodes: [
    { id: "n_h1", type: "heading", public: { text: "Barrier repair" } },
    { id: "n_p1", type: "paragraph", private: { intent: "reassure" }, public: { text: "Give it time." } },
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `n_p${index + 2}`,
      type: "paragraph",
      private: { intent: "explanation", strategy: "context", agentNotes: "Carries the reviewer-requested guidance for reactive, rosacea-prone and eczema-prone readers." },
      public: { text: "The barrier rebuilds on its own schedule, and the fastest route through is usually the least eventful one: fewer actives, a bland moisturiser, and the patience to let a fortnight pass before judging the result." }
    }))
  ]
};

// The model's envelope: deliberately carrying a long, distinctive prose field, so a test can prove
// the whole thing is not being handed back to the revision under any name.
const PREVIOUS_SUMMARY = "Built the dr-lurie content_item body in the fetched client contract shape, with verified rendered image paths and conservative copy revisions from review.";
const modelOutput = { artifact: "client_object.v1", summary: PREVIOUS_SUMMARY, clientObjectType: "content_item", body: REJECTED_BODY, blockers: [] };

vi.mock("../../../src/agent/execution/runnerRegistry.js", () => ({
  getNodeRunner: () => ({
    run: async (request: Dispatch) => {
      dispatches.push({ input: request.input });
      return { ok: true, output: modelOutput };
    }
  })
}));

vi.mock("../../../src/agent/workspace/articleBodyValidation.js", async (importOriginal) => ({
  // Everything real — the loop, the builder, the mechanical fixers — except which node owns the
  // loop, so one runNextNode reaches it without driving the whole conductor.
  ...(await importOriginal<typeof import("../../../src/agent/workspace/articleBodyValidation.js")>()),
  ownsValidationLoop: () => true
}));

// The client's own verdict, in the live shape: ONE issue object naming two problems, joined by "; ".
// Neither is a class W3's mechanical fixers touch, so the loop reaches for its revision turn — which
// is the dispatch under test.
const PROBLEM_A = "nodes.1.private.agentNotes: Invalid input: expected string, received undefined";
const PROBLEM_B = "excerpt: Invalid input: expected string, received undefined";
const clientIssue = { id: "schema_zod", label: "Per-type schema", status: "missing", message: `${PROBLEM_A}; ${PROBLEM_B}` };

vi.mock("../../../src/agent/workspace/publishPayload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/agent/workspace/publishPayload.js")>()),
  validateClientObjectOnce: async () => ({ attempted: true, tool: "object_validate", valid: false, issues: [clientIssue] })
}));

describe("W1.2 — the revision dispatch carries flat issues and a compact target, not the rejected envelope", () => {
  it("puts buildValidationFeedback's shape into the revision input and leaves previousOutput out entirely", async () => {
    const { startDryRun, runNextNode } = await import("../../../src/agent/workspace/executor.js");
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "openai", projectId: "revision-input-proj", input: "x" }, store);

    await runNextNode(started.runId, { executionRepository: store });

    // Two dispatches through the runner: the node's own, then the engine's one revision turn.
    expect(dispatches).toHaveLength(2);
    const feedback = dispatches[1]!.input.validationFeedback as Record<string, unknown>;
    expect(feedback, "the revision dispatch must carry validationFeedback").toBeDefined();

    // 1. ONE STRING PER REAL PROBLEM — the client's concatenated message, split on its own joiner.
    expect(feedback.issues).toEqual([PROBLEM_A, PROBLEM_B]);

    // 2. NOTHING LOST — the client's untransformed answer travels beside it.
    expect(feedback.rawIssues).toEqual([clientIssue]);

    // 3. A COMPACT TARGET instead of the envelope: the ids and paths the issues name.
    expect(feedback.revisionTarget).toEqual({ nodeIds: ["n_p1"], paths: ["nodes.1.private.agentNotes", "excerpt"], currentValues: {} });

    // 4. THE REJECTED ENVELOPE IS GONE — not under `previousOutput`, not under any other key. The
    //    prose field it carried appears nowhere in the feedback the model is handed.
    expect("previousOutput" in feedback).toBe(false);
    expect(JSON.stringify(feedback)).not.toContain(PREVIOUS_SUMMARY);
    //    And the whole feedback — instruction, issues, raw issues and target together — is a small
    //    fraction of the envelope it replaced, rather than a rename of it.
    expect(JSON.stringify(modelOutput).length).toBeGreaterThan(4_000);
    expect(JSON.stringify(feedback).length).toBeLessThan(JSON.stringify(modelOutput).length / 2);

    // 5. And the first dispatch was never given feedback at all — this is a revision, not a retry.
    expect(dispatches[0]!.input).not.toHaveProperty("validationFeedback");
  });
});
