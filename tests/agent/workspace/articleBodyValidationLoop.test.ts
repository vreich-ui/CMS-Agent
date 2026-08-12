import { describe, expect, it, vi } from "vitest";
import {
  MAX_ENGINE_REVALIDATION_CYCLES,
  applyMechanicalFixes,
  readBodyForValidation,
  runArticleBodyValidationLoop
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
