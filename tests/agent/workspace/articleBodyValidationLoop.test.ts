import { describe, expect, it, vi } from "vitest";
import {
  MAX_ENGINE_REVALIDATION_CYCLES,
  applyMechanicalFixes,
  buildRevisionTarget,
  buildValidationFeedback,
  flattenValidationIssues,
  readBodyForValidation,
  runArticleBodyValidationLoop,
  type ArticleBodyValidationFeedback
} from "../../../src/agent/workspace/articleBodyValidation.js";
import { readRecordedValidation, runDeterministicPublishPayload, type PublishPayloadValidation } from "../../../src/agent/workspace/publishPayload.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// W3 part 1 (determinism program, 2026-08-12). The live defect: article_body ran the
// validate→fix→revalidate loop INSIDE its own agent loop, exhausted toolCallLimit:3 mid-validation,
// and deferred with `final_revalidation_not_completed_tool_call_limit_exceeded` — so the verdict
// downstream needed was never earned and publish_payload had to earn it again at 5× the cost.
//
// These tests lock the engine-owned replacement: the loop validates, fixes what is mechanically
// fixable, spends AT MOST one model revision turn, stops at its own bound, and records the verdict
// structurally so publish_payload can reuse it instead of re-validating.

const sampleBody = (overrides: Record<string, unknown> = {}) => ({
  slug: "governed-content-lifecycle",
  title: "Governed content lifecycle",
  nodes: [{ id: "n1", type: "paragraph", text: "Body." }],
  ...overrides
});

const sampleOutput = (body: Record<string, unknown> = sampleBody()) => ({
  artifact: "client_object.v1",
  summary: "Client object built to the fetched contract.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-12T08:00:00.000Z", fingerprint: "fp_sample" },
  body,
  blockers: []
});

const verdict = (overrides: Partial<PublishPayloadValidation> = {}): PublishPayloadValidation => ({
  attempted: true,
  tool: "object_validate",
  valid: true,
  issues: [],
  candidate_patch_summary: "2 ops: 1 set_article_meta + 1 upsert_node",
  ...overrides
});

const invalidVerdict = (issues: unknown[]) => verdict({ valid: false, issues });

describe("engine validate→fix→revalidate loop — validate-pass", () => {
  it("calls the client validator exactly once and records the pass, leaving the body untouched", async () => {
    const validate = vi.fn().mockResolvedValue(verdict());
    const revise = vi.fn();
    const body = sampleBody();
    const result = (await runArticleBodyValidationLoop(sampleOutput(body), { validate, revise }))!;

    expect(validate).toHaveBeenCalledTimes(1);
    expect(revise).not.toHaveBeenCalled();
    expect(result.validation.valid).toBe(true);
    expect(result.validation.source).toBe("engine_validation_loop");
    expect(result.validation.engineLoop).toMatchObject({ revalidations: 0, revisionTurns: 0, mechanicalFixes: [], outcome: "valid", boundedExhaustion: false });
    // Identity: a passing body is not re-derived, re-keyed, or cloned on its way out.
    expect(result.output.body).toBe(body);
    expect(result.warnings).toEqual([]);
  });

  it("treats the client's requires_existing_object refusal as a NORMAL deferral, not a retry trigger", async () => {
    const validate = vi.fn().mockResolvedValue(verdict({ valid: false, deferred: "requires_existing_object", issues: ["no such object"] }));
    const revise = vi.fn();
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate, revise }))!;

    expect(validate).toHaveBeenCalledTimes(1);
    expect(revise).not.toHaveBeenCalled();
    expect(result.validation.engineLoop.outcome).toBe("deferred");
    expect(result.warnings).toEqual([]);
  });

  it("does not re-call a client that could not be reached — an unreachable validator is never a pass", async () => {
    const validate = vi.fn().mockResolvedValue({ attempted: false, tool: "object_validate", valid: false, issues: [], error: "connect ECONNREFUSED" });
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate, revise: vi.fn() }))!;

    expect(validate).toHaveBeenCalledTimes(1);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.engineLoop.outcome).toBe("unavailable");
    expect(result.warnings).toEqual(["article_body_validation_unavailable:connect ECONNREFUSED"]);
  });

  it("returns undefined — and therefore changes nothing — when the output carries no usable body", async () => {
    const validate = vi.fn();
    expect(await runArticleBodyValidationLoop({ artifact: "client_object.v1", body: {} }, { validate })).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
    expect(readBodyForValidation({ body: "not an object" })).toBeUndefined();
  });
});

describe("engine validate→fix→revalidate loop — fix-then-pass", () => {
  it("applies the mechanical id fix the client's own issues asked for and revalidates without a model turn", async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce(invalidVerdict(["nodes[0].id must match pattern ^[a-z0-9_]+$ (ids are lowercase)"]))
      .mockResolvedValueOnce(verdict());
    const revise = vi.fn();
    const result = (await runArticleBodyValidationLoop(sampleOutput(sampleBody({ nodes: [{ id: "N1_Intro", type: "paragraph" }] })), { validate, revise }))!;

    expect(validate).toHaveBeenCalledTimes(2);
    // The whole point: the fix cost no model call at all.
    expect(revise).not.toHaveBeenCalled();
    expect(result.validation.valid).toBe(true);
    expect(result.validation.engineLoop).toMatchObject({ revalidations: 1, revisionTurns: 0, mechanicalFixes: ["id_casing:nodes[0].id"], outcome: "valid" });
    expect((result.output.body as { nodes: Array<{ id: string }> }).nodes[0].id).toBe("n1_intro");
  });

  // W3a (run_1788769566432_5qnafb): the live run's exact two failure classes, on the live run's exact
  // node indices/ids — a strategy/intent conflation on n_p14 (index 24) and [label, text] item pairs
  // on n_box (index 28). Both are mechanical; the loop must resolve both in one pass and never reach
  // for the model revision turn that, on the live run, burned the loop's whole budget and still failed.
  it("applies BOTH W3a mechanical fixes (strategy enum + items[] shape) in one pass and revalidates without a model turn", async () => {
    const nodes: Array<Record<string, unknown>> = Array.from({ length: 29 }, (_, index) => ({ id: `n_filler_${index}`, type: "paragraph" }));
    nodes[24] = { id: "n_p14", type: "paragraph", private: { intent: "reassure", strategy: "reassurance" }, public: { text: "You're covered by our 30-day guarantee." } };
    nodes[28] = { id: "n_box", type: "action", public: { items: [["Free shipping", "On orders over $50"], ["Easy returns", "30-day policy"]] } };

    const issues = [
      'nodes.24.private.strategy: Invalid option: expected one of "hook"|"agitation"|"context"|"explanation"|"proof"|"example"|"comparison"|"myth"|"step"|"recommendation"|"resolution"|"summary"',
      "nodes.28.public.items.0: Invalid input: expected string, received array",
      "nodes.28.public.items.1: Invalid input: expected string, received array"
    ];
    const validate = vi.fn().mockResolvedValueOnce(invalidVerdict(issues)).mockResolvedValueOnce(verdict());
    const revise = vi.fn();
    const result = (await runArticleBodyValidationLoop(sampleOutput(sampleBody({ nodes })), { validate, revise }))!;

    expect(validate).toHaveBeenCalledTimes(2);
    expect(revise).not.toHaveBeenCalled(); // the whole point of W3a: zero revision turns for these two classes.
    expect(result.validation.valid).toBe(true);
    expect(result.validation.engineLoop).toMatchObject({
      revalidations: 1,
      revisionTurns: 0,
      outcome: "valid",
      mechanicalFixes: ["strategy_enum:nodes[24]:reassurance→resolution", "items_join:nodes[28].items[0]", "items_join:nodes[28].items[1]"]
    });
    const fixedNodes = (result.output.body as { nodes: Array<{ private?: Record<string, unknown>; public?: Record<string, unknown> }> }).nodes;
    expect(fixedNodes[24].private).toEqual({ intent: "reassure", strategy: "resolution" });
    expect(fixedNodes[28].public).toEqual({ items: ["Free shipping — On orders over $50", "Easy returns — 30-day policy"] });
  });

  it("spends exactly ONE model revision turn when the failure is not mechanical, then revalidates", async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce(invalidVerdict(["field `excerpt` is required by the object contract"]))
      .mockResolvedValueOnce(verdict());
    const revised = sampleOutput(sampleBody({ excerpt: "A one-line summary." }));
    const revise = vi.fn().mockResolvedValue({ ok: true, output: revised });
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate, revise }))!;

    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0][0]).toMatchObject({ attempt: 1, issues: ["field `excerpt` is required by the object contract"] });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(result.validation.valid).toBe(true);
    expect(result.validation.engineLoop).toMatchObject({ revalidations: 1, revisionTurns: 1, outcome: "valid" });
    expect((result.output.body as { excerpt: string }).excerpt).toBe("A one-line summary.");
  });

  it("keeps the pre-revision envelope when the revision turn fails or comes back without a body", async () => {
    const validate = vi.fn().mockResolvedValue(invalidVerdict(["field `excerpt` is required"]));
    const original = sampleOutput();
    const failed = (await runArticleBodyValidationLoop(original, { validate, revise: async () => ({ ok: false, code: "model_timeout", message: "timed out" }) }))!;
    expect(failed.output.body).toBe(original.body);
    expect(failed.warnings).toContain("article_body_revision_failed:model_timeout");

    const unusable = (await runArticleBodyValidationLoop(original, { validate, revise: async () => ({ ok: true, output: { artifact: "client_object.v1" } }) }))!;
    expect(unusable.output.body).toBe(original.body);
    expect(unusable.warnings).toContain("article_body_revision_unusable:no_body");
  });
});

describe("engine validate→fix→revalidate loop — bounded exhaustion", () => {
  it("stops at MAX_ENGINE_REVALIDATION_CYCLES with a client that never accepts the object", async () => {
    const validate = vi.fn().mockResolvedValue(invalidVerdict(["nodes[0].id must match pattern ^[a-z0-9_]+$", "field `excerpt` is required"]));
    // Each revision comes back with a body that still needs the same mechanical fix, so the loop has
    // BOTH remedies available every cycle and would spin forever if it were not bounded.
    const revise = vi.fn().mockImplementation(async () => ({ ok: true, output: sampleOutput(sampleBody({ nodes: [{ id: "N_AGAIN" }] })) }));
    const result = (await runArticleBodyValidationLoop(sampleOutput(sampleBody({ nodes: [{ id: "N_FIRST" }] })), { validate, revise }))!;

    // One initial verdict plus at most MAX revalidations: three validator calls, never more.
    expect(validate).toHaveBeenCalledTimes(MAX_ENGINE_REVALIDATION_CYCLES + 1);
    expect(result.validation.engineLoop.revalidations).toBe(MAX_ENGINE_REVALIDATION_CYCLES);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.engineLoop.outcome).toBe("invalid");
    expect(result.validation.engineLoop.boundedExhaustion).toBe(true);
    expect(result.warnings).toContain("article_body_validation_loop_exhausted");
    // The last errors are recorded, so the failure is legible downstream without re-validating.
    expect(result.validation.issues).toEqual(["nodes[0].id must match pattern ^[a-z0-9_]+$", "field `excerpt` is required"]);
  });

  it("never spends more than one model revision turn", async () => {
    const validate = vi.fn().mockResolvedValue(invalidVerdict(["field `excerpt` is required"]));
    const revise = vi.fn().mockImplementation(async () => ({ ok: true, output: sampleOutput() }));
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate, revise }))!;

    expect(revise).toHaveBeenCalledTimes(1);
    expect(result.validation.engineLoop).toMatchObject({ revisionTurns: 1, revalidations: 1, boundedExhaustion: true });
  });

  it("reports an invalid verdict it had no remedy for as invalid, NOT as bounded exhaustion", async () => {
    const validate = vi.fn().mockResolvedValue(invalidVerdict(["field `excerpt` is required"]));
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate }))!;

    expect(validate).toHaveBeenCalledTimes(1);
    expect(result.validation.engineLoop).toMatchObject({ revalidations: 0, revisionTurns: 0, boundedExhaustion: false, outcome: "invalid" });
    expect(result.warnings).toContain("article_body_validation_invalid");
  });
});

describe("applyMechanicalFixes — evidence-gated, never a content rewrite", () => {
  it("fixes id/slug casing and whitespace only when the client complained about an id's FORM", () => {
    const body = sampleBody({ slug: "  Governed-Content  ", nodes: [{ id: "N1", type: "paragraph" }] });
    const fixed = applyMechanicalFixes(body, ["slug does not match pattern ^[a-z0-9-]+$"]);
    expect(fixed.fixes).toEqual(["id_casing:slug", "id_casing:nodes[0].id"]);
    expect(fixed.body.slug).toBe("governed-content");
    // Copy-on-write: the body publish_payload carries BY REFERENCE is never mutated in place.
    expect(body.slug).toBe("  Governed-Content  ");
  });

  it("does nothing when the complaint is about something other than an id's form", () => {
    const body = sampleBody({ slug: "Governed-Content" });
    const fixed = applyMechanicalFixes(body, ["field `excerpt` is required by the object contract"]);
    expect(fixed.fixes).toEqual([]);
    expect(fixed.body).toBe(body);
  });

  it("does not touch prose fields even when an id complaint is present", () => {
    const body = sampleBody({ title: "Governed Content Lifecycle", slug: "governed-content" });
    const fixed = applyMechanicalFixes(body, ["id must be lowercase"]);
    expect(fixed.fixes).toEqual([]);
    expect((fixed.body as { title: string }).title).toBe("Governed Content Lifecycle");
  });
});

// W3a (run_1788769566432_5qnafb): the two failure classes the live run's client validator rejected —
// a strategy/intent enum conflation and [label, text] pairs where the contract wants plain strings —
// neither of which the id/casing fixers above were ever meant to catch (the issue text names neither
// an id nor a casing/pattern complaint), so each is its own evidence-gated class.
describe("applyMechanicalFixes — strategy enum and items[] shape (W3a)", () => {
  it("remaps a synonym strategy value and records the fix, leaving the rest of the node untouched", () => {
    const body = sampleBody({
      nodes: [{ id: "n_p14", type: "paragraph", private: { intent: "reassure", strategy: "reassurance" }, public: { text: "unchanged" } }]
    });
    const issue = 'nodes.0.private.strategy: Invalid option: expected one of "hook"|"agitation"|"context"|"explanation"|"proof"|"example"|"comparison"|"myth"|"step"|"recommendation"|"resolution"|"summary"';
    const fixed = applyMechanicalFixes(body, [issue]);

    expect(fixed.fixes).toEqual(["strategy_enum:nodes[0]:reassurance→resolution"]);
    const node = (fixed.body as { nodes: Array<{ id: string; private: Record<string, unknown>; public: Record<string, unknown> }> }).nodes[0];
    expect(node.private).toEqual({ intent: "reassure", strategy: "resolution" });
    expect(node.public).toEqual({ text: "unchanged" });
    // Copy-on-write: the caller's body and node objects are never mutated.
    expect(fixed.body).not.toBe(body);
    expect((body.nodes as unknown as Array<{ private: Record<string, unknown> }>)[0].private).toEqual({ intent: "reassure", strategy: "reassurance" });
  });

  it("drops the optional strategy key outright when no synonym maps it, and touches nothing else on the node", () => {
    const body = sampleBody({
      nodes: [{ id: "n_x", type: "paragraph", private: { intent: "hook", strategy: "inspiration" }, public: { text: "unchanged" } }]
    });
    const issue = 'nodes.0.private.strategy: Invalid option: expected one of "hook"|"agitation"|"context"|"explanation"|"proof"|"example"|"comparison"|"myth"|"step"|"recommendation"|"resolution"|"summary"';
    const fixed = applyMechanicalFixes(body, [issue]);

    expect(fixed.fixes).toEqual(["strategy_enum_dropped:nodes[0]"]);
    const node = (fixed.body as { nodes: Array<{ id: string; private: Record<string, unknown>; public: Record<string, unknown> }> }).nodes[0];
    expect(node.private).toEqual({ intent: "hook" });
    expect("strategy" in node.private).toBe(false);
    expect(node.public).toEqual({ text: "unchanged" });
    expect(node.id).toBe("n_x");
    // Copy-on-write, same discipline as every other fixer in this file.
    expect((body.nodes as unknown as Array<{ private: Record<string, unknown> }>)[0].private).toEqual({ intent: "hook", strategy: "inspiration" });
  });

  it("joins a [label, text] items pair into a single string per the client's array-of-string contract", () => {
    const body = sampleBody({
      nodes: [{ id: "n_box", type: "action", public: { items: [["Free shipping", "On orders over $50"], ["Easy returns", "30-day policy"]] } }]
    });
    const issues = ["nodes.0.public.items.0: Invalid input: expected string, received array", "nodes.0.public.items.1: Invalid input: expected string, received array"];
    const fixed = applyMechanicalFixes(body, issues);

    expect(fixed.fixes).toEqual(["items_join:nodes[0].items[0]", "items_join:nodes[0].items[1]"]);
    expect((fixed.body as { nodes: Array<{ public: { items: string[] } }> }).nodes[0].public.items).toEqual([
      "Free shipping — On orders over $50",
      "Easy returns — 30-day policy"
    ]);
  });

  it("leaves an items[] array untouched when any of its elements is not a string", () => {
    const body = sampleBody({
      nodes: [{ id: "n_box", type: "action", public: { items: [["Label", 42], "already fine"] } }]
    });
    const issue = "nodes.0.public.items.0: Invalid input: expected string, received array";
    const fixed = applyMechanicalFixes(body, [issue]);

    expect(fixed.fixes).toEqual([]);
    expect(fixed.body).toBe(body);
    expect((body.nodes as unknown as Array<{ public: { items: unknown[] } }>)[0].public.items[0]).toEqual(["Label", 42]);
  });
});

describe("publish_payload consumes the engine's verdict instead of re-validating it (W3 part 1 → W0)", () => {
  // A repository that throws if anyone reaches for it: proof the validator was NOT called again.
  const refusingRepository = { get: async () => { throw new Error("project repository must not be reached: the verdict was already earned"); } } as unknown as ProjectRepository;

  const engineValidated = async (overrides: Record<string, unknown> = {}) => {
    const loop = (await runArticleBodyValidationLoop(sampleOutput(), { validate: async () => verdict() }))!;
    return { ...loop.output, ...overrides };
  };

  it("reuses a fingerprint-matched engine verdict and makes no object_validate call at all", async () => {
    const articleBody = await engineValidated();
    const built = await runDeterministicPublishPayload(
      { projectId: "platform", clientProjectId: "platform", articleBody, artifactPlan: { artifact: "artifact_plan.v1", requestId: "req_x_20260812_01" } },
      { projectRepository: refusingRepository }
    );
    expect(built.ok, built.ok ? "" : `${built.code}: ${built.error}`).toBe(true);
    if (!built.ok) return;
    expect(built.payload.clientValidation.valid).toBe(true);
    expect(built.payload.blockers).toEqual([]);
    expect(built.payload.validationAssumptions.join(" ")).toMatch(/earned by the engine's own validate→fix→revalidate loop/);
    // And it still satisfies publish_payload's own schema, engineLoop record and all.
    expect(validateOutput(built.payload, getWorkspaceNode("publish_payload")!.outputSchema).ok).toBe(true);
  });

  it("refuses to reuse a verdict whose body was touched after the verdict was earned", async () => {
    const articleBody = await engineValidated();
    const tampered = { ...articleBody, body: { ...(articleBody.body as Record<string, unknown>), title: "Quietly edited after validation" } };
    expect(readRecordedValidation(tampered, tampered.body as Record<string, unknown>)).toBeUndefined();
  });

  it("refuses to reuse a clientValidation a model typed, or one whose call never landed", async () => {
    const body = sampleBody();
    expect(readRecordedValidation({ clientValidation: { attempted: true, tool: "object_validate", valid: true } }, body)).toBeUndefined();
    const loop = (await runArticleBodyValidationLoop(sampleOutput(body), { validate: async () => ({ attempted: false, tool: "object_validate", valid: false, issues: [], error: "unreachable" }) }))!;
    expect(readRecordedValidation(loop.output, body)).toBeUndefined();
  });

  it("carries the engine's INVALID verdict through to publish_payload's own blocker, unre-validated", async () => {
    const loop = (await runArticleBodyValidationLoop(sampleOutput(), { validate: async () => invalidVerdict(["field `excerpt` is required"]) }))!;
    const built = await runDeterministicPublishPayload(
      { projectId: "platform", clientProjectId: "platform", articleBody: loop.output },
      { projectRepository: refusingRepository }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.blockers.join(" ")).toMatch(/client_validation_failed/);
  });
});

describe("applyMechanicalFixes — unrecognized ROOT keys named by the client are stripped (run_1786549907145_hf4wgb)", () => {
  it("removes exactly the root key the client named, copy-on-write, and records the fix", () => {
    const body = { object_type: "content_item", title: "T", slug: "t", nodes: [] };
    const fixed = applyMechanicalFixes(body, ['(root): Unrecognized key: "object_type"']);
    expect(fixed.fixes).toContain("unrecognized_root_key:object_type");
    expect("object_type" in fixed.body).toBe(false);
    expect(fixed.body).not.toBe(body);
    expect(body.object_type).toBe("content_item");
    expect(fixed.body.title).toBe("T");
  });

  it("does not strip a key from a NESTED unrecognized-key complaint", () => {
    const body = { title: "T", private: "x" };
    const fixed = applyMechanicalFixes(body, ['nodes[0].public: Unrecognized key: "private"']);
    expect(fixed.fixes).toEqual([]);
    expect(fixed.body).toBe(body);
  });

  it("does not strip a named key that is absent from the body root", () => {
    const body = { title: "T" };
    const fixed = applyMechanicalFixes(body, ['(root): Unrecognized key: "object_type"']);
    expect(fixed.fixes).toEqual([]);
    expect(fixed.body).toBe(body);
  });
});

// W1 (run_1788769566432_5qnafb) — THE REVISION TURN'S INPUT.
//
// The live defect: the client validator answers with ONE issue object whose `message` concatenates
// every problem it found with "; ", and that object reached the model unflattened, beside
// `previousOutput` — the whole ~29-30K-character envelope the client had just rejected — under an
// instruction to emit the same envelope again. The turn came back with neither flagged defect fixed
// and a summary claiming it had fixed one of them.
//
// Note on the issue class used below. W3's mechanical fixers now repair that run's two ACTUAL
// failures (strategy enum, items[] shape) with zero revision turns, which is the better outcome and
// is not weakened here. So these tests reproduce the live defect's SHAPE — several real problems
// concatenated into one client issue object — on a class no mechanical fixer touches, which is what
// the revision turn exists for.
const clientIssueObject = (...problems: string[]) => ({
  id: "schema_zod",
  label: "Per-type schema",
  status: "missing",
  message: problems.join("; ")
});

const OVERLONG_TEXT = "Barrier repair takes time. ".repeat(11).trim(); // 296 chars: over the client's 280 cap, under revisionTarget's own.
const TOO_LONG_ISSUE = "nodes.2.public.text: Too big: expected string to have <=280 characters";
const MISSING_EXCERPT_ISSUE = "excerpt: Invalid input: expected string, received undefined";

const twoIssueBody = () => sampleBody({
  nodes: [
    { id: "n_h1", type: "heading", public: { text: "Barrier repair" } },
    { id: "n_p1", type: "paragraph", public: { text: "Short enough." } },
    { id: "n_lead", type: "paragraph", public: { text: OVERLONG_TEXT } }
  ]
});

// A stand-in for the revising model that works ONLY from the feedback it is handed — no test-local
// knowledge of what is wrong. That is the point: with the old one-object-three-problems shape it
// could see one issue and fix at most one thing, which is what the live run did.
const stubReviser = (captured: ArticleBodyValidationFeedback[]) => async ({ issues, body, attempt }: { issues: unknown[]; body: Record<string, unknown>; attempt: number }) => {
  const feedback = buildValidationFeedback({ issues, body, attempt });
  captured.push(feedback);

  const revised = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const issue of feedback.issues) {
    const path = feedback.revisionTarget.paths.find((candidate) => issue.startsWith(`${candidate}:`));
    if (!path) continue;
    const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    const leaf = segments.pop()!;
    let cursor: Record<string, unknown> = revised;
    for (const segment of segments) cursor = (Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment]) as Record<string, unknown>;
    const cap = /have <=(\d+) characters/.exec(issue);
    if (cap) cursor[leaf] = String(feedback.revisionTarget.currentValues[path]).slice(0, Number(cap[1]));
    else if (/received undefined/.test(issue)) cursor[leaf] = "A one-line summary.";
  }
  return { ok: true as const, output: sampleOutput(revised) };
};

describe("W1 acceptance 1 — the revision turn is handed one string per real problem", () => {
  it("flattens the client's concatenated message, dispatches ONE revision, and the stub reviser's fixes validate", async () => {
    const captured: ArticleBodyValidationFeedback[] = [];
    const rawIssue = clientIssueObject(TOO_LONG_ISSUE, MISSING_EXCERPT_ISSUE);
    const validate = vi.fn().mockResolvedValueOnce(invalidVerdict([rawIssue])).mockResolvedValueOnce(verdict());
    const result = (await runArticleBodyValidationLoop(sampleOutput(twoIssueBody()), { validate, revise: stubReviser(captured) }))!;

    // ONE revision turn, and the feedback it carried names BOTH problems as separate verbatim strings.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.issues).toEqual([TOO_LONG_ISSUE, MISSING_EXCERPT_ISSUE]);
    expect(captured[0]!.attempt).toBe(1);

    // And applying exactly those two, from the feedback alone, is enough to pass the client.
    expect(result.validation.valid).toBe(true);
    expect(result.validation.engineLoop).toMatchObject({ revalidations: 1, revisionTurns: 1, outcome: "valid", boundedExhaustion: false, revisionChangedBody: true });
    const revisedNodes = (result.output.body as { nodes: Array<{ public: { text: string } }>; excerpt: string });
    expect(revisedNodes.nodes[2]!.public.text).toHaveLength(280);
    expect(revisedNodes.excerpt).toBe("A one-line summary.");
  });

  it("carries a compact revisionTarget — node ids, paths, current values — and no previous envelope", async () => {
    const captured: ArticleBodyValidationFeedback[] = [];
    const rawIssue = clientIssueObject(TOO_LONG_ISSUE, MISSING_EXCERPT_ISSUE);
    const validate = vi.fn().mockResolvedValueOnce(invalidVerdict([rawIssue])).mockResolvedValueOnce(verdict());
    await runArticleBodyValidationLoop(sampleOutput(twoIssueBody()), { validate, revise: stubReviser(captured) });

    const feedback = captured[0]!;
    // The body's own id for the node the client named by POSITION — the model edits by name.
    expect(feedback.revisionTarget.nodeIds).toEqual(["n_lead"]);
    expect(feedback.revisionTarget.paths).toEqual(["nodes.2.public.text", "excerpt"]);
    expect(feedback.revisionTarget.currentValues).toEqual({ "nodes.2.public.text": OVERLONG_TEXT });
    // `excerpt` is named but absent, so it has no current value — the path still travels.
    expect("excerpt" in feedback.revisionTarget.currentValues).toBe(false);

    // The client's untransformed answer is kept, so the flattening can never be a lossy rewrite.
    expect(feedback.rawIssues).toEqual([rawIssue]);
    expect((feedback.rawIssues[0] as { message: string }).message).toBe(`${TOO_LONG_ISSUE}; ${MISSING_EXCERPT_ISSUE}`);

    // The ~30K-character envelope the client had just rejected is gone, under any name.
    expect("previousOutput" in feedback).toBe(false);
    expect(JSON.stringify(feedback)).not.toContain(sampleOutput().summary);
    expect(feedback.instruction).toMatch(/previous envelope is deliberately not attached/);
  });
});

describe("W1 acceptance 2 — an unfixable issue still fails honestly, and the record says whether the body moved", () => {
  it("exhausts the loop with valid:false and records a revision that DID change the body", async () => {
    const validate = vi.fn().mockResolvedValue(invalidVerdict([clientIssueObject("excerpt: the client will never accept this object")]));
    // A revision that edits something — just not something that helps.
    const revise = vi.fn().mockImplementation(async () => ({ ok: true, output: sampleOutput(sampleBody({ excerpt: "A different but equally unacceptable excerpt." })) }));
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate, revise }))!;

    expect(result.validation.valid).toBe(false);
    expect(result.validation.engineLoop).toMatchObject({ revisionTurns: 1, outcome: "invalid", boundedExhaustion: true, revisionChangedBody: true });
    // The warning is the honest outcome and is never engineered away.
    expect(result.warnings).toContain("article_body_validation_loop_exhausted");
  });

  // The live run's own signature, and the fact its record could not express: a revision turn was
  // spent, the model claimed a fix in its summary, and the body it returned was identical.
  it("records revisionChangedBody:false when the revision returned the same body it was given", async () => {
    const unchanged = sampleOutput();
    const validate = vi.fn().mockResolvedValue(invalidVerdict([clientIssueObject("excerpt: is required by the object contract")]));
    const revise = vi.fn().mockImplementation(async () => ({ ok: true, output: { ...unchanged, summary: "Re-emitted after validation feedback with the rejected fields corrected." } }));
    const result = (await runArticleBodyValidationLoop(unchanged, { validate, revise }))!;

    expect(revise).toHaveBeenCalledTimes(1);
    expect(result.validation.engineLoop).toMatchObject({ revisionTurns: 1, revisionChangedBody: false, boundedExhaustion: true, outcome: "invalid" });
    expect(result.warnings).toContain("article_body_validation_loop_exhausted");
  });

  it("records revisionChangedBody:false when no revision ran at all — read it WITH revisionTurns", async () => {
    const mechanical = (await runArticleBodyValidationLoop(sampleOutput(sampleBody({ nodes: [{ id: "N1_Intro", type: "paragraph" }] })), {
      validate: vi.fn().mockResolvedValueOnce(invalidVerdict(["nodes[0].id must match pattern ^[a-z0-9_]+$ (ids are lowercase)"])).mockResolvedValueOnce(verdict())
    }))!;
    expect(mechanical.validation.engineLoop).toMatchObject({ revisionTurns: 0, revisionChangedBody: false, outcome: "valid" });

    // A revision that failed outright never changed anything either.
    const failed = (await runArticleBodyValidationLoop(sampleOutput(), {
      validate: vi.fn().mockResolvedValue(invalidVerdict(["excerpt: is required"])),
      revise: async () => ({ ok: false, code: "model_timeout", message: "timed out" })
    }))!;
    expect(failed.validation.engineLoop).toMatchObject({ revisionTurns: 1, revisionChangedBody: false });
  });
});

describe("flattenValidationIssues / buildRevisionTarget — the pieces, on their own", () => {
  it("splits only on the client's own joiner and keeps each problem verbatim", () => {
    expect(flattenValidationIssues([clientIssueObject(TOO_LONG_ISSUE, MISSING_EXCERPT_ISSUE)])).toEqual([TOO_LONG_ISSUE, MISSING_EXCERPT_ISSUE]);
    // The live run's enum issue carries "|"-separated values and internal colons: one problem, intact.
    const enumIssue = 'nodes.24.private.strategy: Invalid option: expected one of "hook"|"agitation"|"resolution"|"summary"';
    expect(flattenValidationIssues([clientIssueObject(enumIssue)])).toEqual([enumIssue]);
    // Plain-string issues (every other caller in this file) pass through unchanged, and repeats collapse.
    expect(flattenValidationIssues(["excerpt: is required", "excerpt: is required"])).toEqual(["excerpt: is required"]);
    // An issue in a shape nobody anticipated is preserved as its own JSON, never dropped.
    expect(flattenValidationIssues([{ id: "x", detail: "no message field" }])).toEqual(['{"id":"x","detail":"no message field"}']);
  });

  it("names paths without inventing them, and omits a value too large to be a hint", () => {
    const body = { title: "T", nodes: [{ id: "n_box", public: { items: Array.from({ length: 40 }, (_, index) => `item ${index} — a decision line long enough to matter`) } }] };
    const target = buildRevisionTarget(body, [
      "nodes.0.public.items: Invalid input: expected string, received array",
      "nodes[0].id: must be lowercase",
      "field `excerpt` is required by the object contract" // no path — nothing is invented from prose.
    ]);
    expect(target.nodeIds).toEqual(["n_box"]);
    expect(target.paths).toEqual(["nodes.0.public.items", "nodes[0].id"]);
    // The 40-element array is named but NOT re-attached; the small value beside it is.
    expect(target.currentValues).toEqual({ "nodes[0].id": "n_box" });
  });
});
