import { describe, expect, it } from "vitest";
import {
  APPLY_BRAND_IMAGERY_TOOL,
  BRAND_IMAGERY_PROPOSAL_ARTIFACT,
  SET_VISUAL_STANDARD_FIELDS_OP,
  buildVisualStandardBody,
  readBrandImageryProposal,
  readVisualStandardMaterializer,
  referenceIdFor,
  runVisualStandardMaterialization,
  visualStandardIdFor,
  type VisualStandardDeps
} from "../../../src/agent/workspace/visualStandardMaterialization.js";
import { visualIdentityNodes } from "../../../src/agent/workspace/visualIdentityNodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// C5 acceptance (BRIEF §3.5). Everything here is about the DETERMINISTIC half: what it writes, what it
// refuses to write, and — the part that matters most — that a refused apply is a reported outcome
// rather than a failure. There is no runner in this file and no model anywhere near it, which is the
// structural proof that the node costs $0.

const SITE_ID = "site_drlurie";
const PROJECT_ID = "acme-media"; // no executable policy hook: this file is about the module, not one client's policy.

const writerNode = visualIdentityNodes.find((node) => node.id === "brand_imagery_writer")!;
const materializerNode = visualIdentityNodes.find((node) => node.id === "visual_standard_materializer")!;

const configWith = (applyPermission: "allowed" | "blocked" | "needs_approval"): ProjectConnectionConfig =>
  ({
    projectId: PROJECT_ID,
    status: "active",
    allowedTools: [],
    defaultToolPolicy: "allowed",
    toolPolicies: { [APPLY_BRAND_IMAGERY_TOOL]: applyPermission },
    objectDialect: { siteObjectId: SITE_ID }
  }) as unknown as ProjectConnectionConfig;

const repositoryFor = (config: ProjectConnectionConfig) => ({ get: async () => config }) as unknown as ProjectRepository;

const PROPOSAL = {
  artifact: BRAND_IMAGERY_PROPOSAL_ARTIFACT,
  mode: "house",
  label: "Clinical daylight",
  rationale: "The board is uniformly daylit and low-contrast; the two greens are the site's own tokens.",
  confidence: "high",
  sampleSubjects: ["a dermatologist's consulting room in morning light", "a hand applying cream to a forearm"],
  brandImagery: {
    version: 1,
    medium: "photograph",
    styleSentence: "Warm, low-contrast editorial photography in soft directional daylight with shallow depth of field.",
    palette: ["#2E5C42", "#F4EFE7"],
    negative: ["text overlays", "visible logos"],
    aspectRatios: { article_header: "3:2", article_body: "1:1" },
    seedBase: 4711
  }
};

const REFERENCES = [
  { blobKey: "image/req_moodboard_01/aaaa1111.webp", note: "the palette, not the subject", weight: 1 },
  { blobKey: "image/req_moodboard_01/bbbb2222.webp", region: { x: 0, y: 0, w: 0.5, h: 0.5 } }
];

const runFixture = (overrides: { proposal?: unknown; initialInput?: unknown; executionMode?: string } = {}): WorkflowExecutionRecord =>
  ({
    runId: "run_visual_identity_1",
    workflowId: "visual_identity",
    projectId: PROJECT_ID,
    executionMode: overrides.executionMode ?? "openai",
    nodes: [],
    initialInput: overrides.initialInput ?? {},
    stageOutputs: { brand_imagery_writer: "proposal" in overrides ? overrides.proposal : PROPOSAL }
  }) as unknown as WorkflowExecutionRecord;

type Call = { tool: string; args: Record<string, unknown> };

/**
 * A client that answers the five verbs this module can reach. `exists` decides whether object_get
 * finds the standard already there (the patch path) or reports it missing (the create path);
 * `failTools` makes one named verb refuse, so a mid-sequence failure can be driven precisely.
 */
const client = (options: { exists?: boolean; failTools?: Record<string, string>; changedFields?: string[] } = {}) => {
  const calls: Call[] = [];
  const callTool = async (_config: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const failure = options.failTools?.[tool];
    if (failure) return { ok: false, error: failure };
    if (tool === "object_get") {
      return options.exists
        ? { ok: true, result: { structuredContent: { record: { object_id: args.object_id, body: { version: 1, kind: "house", status: "draft" } } } } }
        : { ok: true, result: { structuredContent: { record: { not_found: true } } } };
    }
    if (tool === "object_checkout") return { ok: true, result: { structuredContent: { lockToken: `lock_${String(args.object_id)}`, recordVersion: 7 } } };
    if (tool === APPLY_BRAND_IMAGERY_TOOL && args.dry_run === true) {
      return { ok: true, result: { structuredContent: { changedFields: options.changedFields ?? ["brandImagery"] } } };
    }
    return { ok: true, result: { structuredContent: { ok: true } } };
  };
  return { calls, callTool: callTool as unknown as NonNullable<VisualStandardDeps["callTool"]> };
};

const materialize = (run: WorkflowExecutionRecord, deps: ReturnType<typeof client>, config: ProjectConnectionConfig, node: WorkspaceNode = materializerNode) =>
  runVisualStandardMaterialization({ run, node }, { projectRepository: repositoryFor(config), callTool: deps.callTool });

const toolsCalled = (calls: Call[]) => calls.map((call) => call.tool);

describe("visual_standard_materializer — the deterministic half of the writer pair", () => {
  it("is opted in by metadata, exactly like every sibling deterministic route", () => {
    expect(readVisualStandardMaterializer(materializerNode)).toBe(true);
    expect(readVisualStandardMaterializer(writerNode)).toBe(false);
  });

  it("HOUSE CREATE: files vis_<site> with derivedFrom.method 'writer', as a draft, and applies nothing", async () => {
    const deps = client();
    const outcome = await materialize(runFixture({ initialInput: { references: REFERENCES } }), deps, configWith("allowed"));

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.visualStandardId).toBe("vis_drlurie");
    expect(outcome.output.kind).toBe("house");
    expect(outcome.output.created).toBe(true);
    expect(outcome.output.status).toBe("draft");
    // The apply was never requested, so it never happened — and the site is still the style source.
    expect(outcome.output.applied).toBe(false);
    expect(outcome.output.styleSource).toBe("site");
    expect(outcome.output.reason).toContain("apply_not_requested");

    // One read, one create, and NOTHING else: no checkout, no apply, no publish.
    expect(toolsCalled(deps.calls)).toEqual(["object_get", "object_create"]);
    const create = deps.calls[1].args;
    expect(create.object_type).toBe("visual_standard");
    expect(create.site).toBe(SITE_ID);
    expect(create.requested_id).toBe("vis_drlurie");
    const body = create.body as Record<string, unknown>;
    expect(body.version).toBe(1);
    expect(body.kind).toBe("house");
    expect(body.status).toBe("draft");
    expect(body.derivedFrom).toEqual({ method: "writer" });
    expect(body.brandImagery).toEqual(PROPOSAL.brandImagery);
    expect(body.sampleSubjects).toEqual(PROPOSAL.sampleSubjects);
    // Reference ids are derived from the blobKey, never from position — a reordered board must not
    // repoint an existing note/region onto a different image (BRIEF §3.1).
    expect(body.references).toEqual([
      { id: referenceIdFor(REFERENCES[0].blobKey), blobKey: REFERENCES[0].blobKey, note: "the palette, not the subject", weight: 1 },
      { id: referenceIdFor(REFERENCES[1].blobKey), blobKey: REFERENCES[1].blobKey, region: { x: 0, y: 0, w: 0.5, h: 0.5 } }
    ]);
  });

  it("TEMPLATE CREATE: files vis_<site>_<slug>, and refuses rather than filing a template under the house id", async () => {
    const proposal = { ...PROPOSAL, mode: "template", label: "Field notes", whenToUse: "Use for reader-submitted case write-ups." };
    const deps = client();
    const outcome = await materialize(runFixture({ proposal, initialInput: { templateSlug: "field-notes", references: REFERENCES } }), deps, configWith("allowed"));

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.visualStandardId).toBe("vis_drlurie_field_notes");
    expect(outcome.output.kind).toBe("template");
    const body = deps.calls[1].args.body as Record<string, unknown>;
    expect(body.kind).toBe("template");
    expect(body.whenToUse).toBe("Use for reader-submitted case write-ups.");

    // The same proposal with no slug anywhere is a REFUSAL, not a silent fall back to vis_<site>:
    // overwriting the house standard with a template's look is the one mistake this id scheme exists
    // to make impossible.
    const noSlug = client();
    const refused = await materialize(runFixture({ proposal, initialInput: { references: REFERENCES } }), noSlug, configWith("allowed"));
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.code).toBe("visual_standard_id_unresolvable");
    expect(refused.message).toContain("templateSlug");
    expect(noSlug.calls).toHaveLength(0);
  });

  // REVIEW: `apply` was correctly read from the run and never from the model, but `mode` was read
  // only from the writer's OUTPUT — and mode is what selects the write TARGET. A writer that returned
  // mode 'house' on a run that asked for a template redirected the write onto the site's singleton
  // `vis_<site>`, and with apply:true under an "allowed" policy carried that look onto the live site:
  // a model choosing an object the run never named. The run's declared mode now wins, and a
  // disagreement is a refusal before any client call.
  it("MODE IS THE RUN'S, NOT THE MODEL'S: a proposal whose mode contradicts the run's writes nothing", async () => {
    const houseProposal = { ...PROPOSAL, mode: "house" };
    const deps = client();
    const outcome = await materialize(
      runFixture({ proposal: houseProposal, initialInput: { mode: "template", templateSlug: "field-notes", apply: true, references: REFERENCES } }),
      deps,
      configWith("allowed")
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("visual_standard_mode_mismatch");
    // Nothing reached the client at all — not the create, and certainly not the apply.
    expect(deps.calls).toHaveLength(0);

    // The agreeing case is untouched, and a run that declares no mode still takes the proposal's word.
    const agreeing = client();
    const ok = await materialize(
      runFixture({ proposal: houseProposal, initialInput: { mode: "house", references: REFERENCES } }),
      agreeing,
      configWith("allowed")
    );
    expect(ok.kind).toBe("completed");
    if (ok.kind !== "completed") return;
    expect(ok.output.visualStandardId).toBe("vis_drlurie");
  });

  it("APPLY ALLOWED: runs the verb's DRY RUN first, then the apply under the site's own checkout, then releases the lease", async () => {
    const deps = client({ changedFields: ["brandImagery"] });
    const outcome = await materialize(runFixture({ initialInput: { apply: true, references: REFERENCES } }), deps, configWith("allowed"));

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.applied).toBe(true);
    expect(outcome.output.styleSource).toBe("visual_standard");
    expect(outcome.output.changedFields).toEqual(["brandImagery"]);
    // An applied standard is the site's active look, so it stops being a draft.
    expect(outcome.output.status).toBe("active");

    expect(toolsCalled(deps.calls)).toEqual([
      "object_get",
      "object_create",
      APPLY_BRAND_IMAGERY_TOOL, // dry run
      "object_checkout",        // the SITE's lease
      APPLY_BRAND_IMAGERY_TOOL, // the apply itself
      "object_checkin",
      "object_checkout",        // the standard's own lease, to promote it to active
      "object_patch",
      "object_checkin"
    ]);
    const [dryRun, apply] = deps.calls.filter((call) => call.tool === APPLY_BRAND_IMAGERY_TOOL);
    // Order is the assertion, not decoration: the preview is what produces changedFields, and it
    // needs neither lock nor record version.
    expect(dryRun.args).toEqual({ site_id: SITE_ID, visual_standard_id: "vis_drlurie", dry_run: true });
    expect(apply.args).toEqual({ site_id: SITE_ID, visual_standard_id: "vis_drlurie", lock_token: `lock_${SITE_ID}`, expected_record_version: 7 });
    expect(deps.calls.find((call) => call.tool === "object_patch")!.args.ops).toEqual([{ op: SET_VISUAL_STANDARD_FIELDS_OP, fields: { status: "active" } }]);
  });

  it("APPLY BLOCKED BY POLICY: the standard still exists, applied is false, and the reason names the permission", async () => {
    for (const permission of ["blocked", "needs_approval"] as const) {
      const deps = client();
      const outcome = await materialize(runFixture({ initialInput: { apply: true, references: REFERENCES } }), deps, configWith(permission));

      expect(outcome.kind, permission).toBe("completed");
      if (outcome.kind !== "completed") return;
      expect(outcome.output.applied, permission).toBe(false);
      expect(outcome.output.styleSource, permission).toBe("site");
      expect(outcome.output.status, permission).toBe("draft");
      expect(outcome.output.reason, permission).toContain(`apply_policy_${permission}`);
      // "needs_approval" is NOT "allowed": a deterministic node has no turn in which to ask, so it
      // must not act on an approval nobody granted.
      expect(toolsCalled(deps.calls), permission).toEqual(["object_get", "object_create"]);
      expect(deps.calls.some((call) => call.tool === APPLY_BRAND_IMAGERY_TOOL), permission).toBe(false);
    }
  });

  it("APPLY THAT FAILS AT THE WIRE is still a completed node with a draft standard and a named reason — and never leaks the site lease", async () => {
    const dryRunFailed = client({ failTools: { [APPLY_BRAND_IMAGERY_TOOL]: "422 theme carries no brandImagery preset" } });
    const first = await materialize(runFixture({ initialInput: { apply: true } }), dryRunFailed, configWith("allowed"));
    expect(first.kind).toBe("completed");
    if (first.kind !== "completed") return;
    expect(first.output.applied).toBe(false);
    expect(first.output.reason).toContain("apply_dry_run_failed");
    // The dry run failed, so no lease was ever taken.
    expect(dryRunFailed.calls.some((call) => call.tool === "object_checkout")).toBe(false);

    // ...and when the APPLY itself fails after the lease is held, the lease is still released.
    let applyCalls = 0;
    const applyFailed = client();
    const wrapped = {
      calls: applyFailed.calls,
      callTool: (async (config: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => {
        if (tool === APPLY_BRAND_IMAGERY_TOOL && args.dry_run !== true) {
          applyCalls += 1;
          applyFailed.calls.push({ tool, args });
          return { ok: false, error: "423 site lock expired" };
        }
        return applyFailed.callTool(config, tool, args);
      }) as unknown as NonNullable<VisualStandardDeps["callTool"]>
    };
    const second = await materialize(runFixture({ initialInput: { apply: true } }), wrapped, configWith("allowed"));
    expect(second.kind).toBe("completed");
    if (second.kind !== "completed") return;
    expect(applyCalls).toBe(1);
    expect(second.output.applied).toBe(false);
    expect(second.output.reason).toContain("apply_failed");
    expect(applyFailed.calls.filter((call) => call.tool === "object_checkin")).toHaveLength(1);
  });

  it("PATCHES an existing standard through checkout -> set_visual_standard_fields -> checkin, never a second create", async () => {
    const deps = client({ exists: true });
    const outcome = await materialize(runFixture({ initialInput: { references: REFERENCES } }), deps, configWith("allowed"));

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.created).toBe(false);
    expect(toolsCalled(deps.calls)).toEqual(["object_get", "object_checkout", "object_patch", "object_checkin"]);
    const ops = deps.calls[2].args.ops as Array<Record<string, unknown>>;
    expect(ops[0].op).toBe(SET_VISUAL_STANDARD_FIELDS_OP);
    // The WHOLE body is sent, not a diff: set_visual_standard_fields is an open deep merge, so a
    // partial send would leave a re-run additive instead of convergent.
    expect(Object.keys(ops[0].fields as Record<string, unknown>).sort()).toEqual(["brandImagery", "derivedFrom", "kind", "label", "references", "sampleSubjects", "status", "version"]);
  });

  it("REFUSES rather than inventing: no proposal, an unknown project, a site-less project, a mock run", async () => {
    const config = configWith("allowed");

    const noProposal = client();
    const a = await materialize(runFixture({ proposal: { artifact: "something_else.v1" } }), noProposal, config);
    expect(a.kind === "refused" && a.code).toBe("brand_imagery_proposal_absent");
    expect(noProposal.calls).toHaveLength(0);

    const unknownProject = client();
    const b = await runVisualStandardMaterialization(
      { run: runFixture(), node: materializerNode },
      { projectRepository: { get: async () => undefined } as unknown as ProjectRepository, callTool: unknownProject.callTool }
    );
    expect(b.kind === "refused" && b.code).toBe("visual_standard_project_unresolved");

    const siteless = client();
    const c = await materialize(runFixture(), siteless, { ...config, objectDialect: undefined } as unknown as ProjectConnectionConfig);
    expect(c.kind === "refused" && c.code).toBe("visual_standard_site_unconfigured");

    // A mock run reaches no client at all: it refuses, and the executor falls through to the
    // MockNodeRunner placeholder so CI graph traversal keeps working.
    const mock = client();
    const d = await materialize(runFixture({ executionMode: "mock" }), mock, config);
    expect(d.kind === "refused" && d.code).toBe("not_live");
    expect(mock.calls).toHaveLength(0);

    // A proposal with no sampleSubjects cannot make a schema-valid body, and this node never invents
    // a subject to fill the gap.
    const noSubjects = client();
    const e = await materialize(runFixture({ proposal: { ...PROPOSAL, sampleSubjects: [] } }), noSubjects, config);
    expect(e.kind === "refused" && e.code).toBe("visual_standard_sample_subjects_absent");
    expect(noSubjects.calls).toHaveLength(0);
  });

  it("a client refusal on the create/patch is a NODE refusal — there is no half-filed standard to report", async () => {
    const createFailed = client({ failTools: { object_create: "422 body failed validation: palette[0]" } });
    const outcome = await materialize(runFixture(), createFailed, configWith("allowed"));
    expect(outcome.kind === "refused" && outcome.code).toBe("visual_standard_create_failed");
    expect(outcome.kind === "refused" && outcome.message).toContain("palette[0]");
  });

  it("emits an envelope its own node outputSchema accepts", async () => {
    const deps = client();
    const outcome = await materialize(runFixture({ initialInput: { apply: true, references: REFERENCES } }), deps, configWith("allowed"));
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(validateOutput(outcome.output, materializerNode.outputSchema)).toEqual({ ok: true, value: outcome.output });
  });
});

describe("ids, bodies and proposals — the pure halves", () => {
  it("derives vis_<site> / vis_<site>_<slug> from the SITE, not the project", () => {
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "house" })).toBe("vis_drlurie");
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "template", templateSlug: "Field Notes" })).toBe("vis_drlurie_field_notes");
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "template" })).toBeUndefined();
    expect(visualStandardIdFor({ siteObjectId: "site_", mode: "house" })).toBeUndefined();
  });

  it("mints reference ids that survive a reorder and match the platform's own ref_ shape", () => {
    const id = referenceIdFor("image/req_x/aaaa.webp");
    expect(id).toMatch(/^ref_[a-z0-9]{8}$/);
    expect(referenceIdFor("image/req_x/aaaa.webp")).toBe(id);
    expect(referenceIdFor("image/req_x/bbbb.webp")).not.toBe(id);
  });

  it("reads only a real proposal, and never a partial one", () => {
    expect(readBrandImageryProposal({ stageOutputs: { brand_imagery_writer: PROPOSAL } })?.label).toBe("Clinical daylight");
    expect(readBrandImageryProposal({ stageOutputs: {} })).toBeUndefined();
    expect(readBrandImageryProposal({ stageOutputs: { brand_imagery_writer: { ...PROPOSAL, brandImagery: undefined } } })).toBeUndefined();
    expect(readBrandImageryProposal({ stageOutputs: { brand_imagery_writer: { ...PROPOSAL, mode: "sideways" } } })).toBeUndefined();
  });

  it("always stamps derivedFrom.method 'writer' — nothing else reaches this module", () => {
    const body = buildVisualStandardBody({ proposal: readBrandImageryProposal({ stageOutputs: { brand_imagery_writer: PROPOSAL } })!, references: [], status: "draft" });
    expect(body.derivedFrom.method).toBe("writer");
  });
});

describe("brand_imagery_writer — the node contract the materializer trusts", () => {
  // The fixture a live writer turn would produce. It validates against the node's OWN outputSchema,
  // which is what makes the materializer's "read the proposal and file it" safe: a malformed proposal
  // fails at the writer, cheaply and by name, not as a 422 out of object_create.
  it("a writer output fixture validates against brand_imagery_proposal.v1", () => {
    expect(validateOutput(PROPOSAL, writerNode.outputSchema)).toEqual({ ok: true, value: PROPOSAL });
  });

  it("rejects the four failures the prompt spends the most words on", () => {
    const invalid = (patch: Record<string, unknown>) => validateOutput({ ...PROPOSAL, brandImagery: { ...PROPOSAL.brandImagery, ...patch } }, writerNode.outputSchema);
    // an invented medium; a non-hex swatch; more than 12 negatives; an aspect-ratio key that is not
    // a lowercase snake_case context, and a ratio that is not "W:H".
    expect(invalid({ medium: "oil_painting" }).ok).toBe(false);
    expect(invalid({ palette: ["forest green"] }).ok).toBe(false);
    expect(invalid({ negative: Array.from({ length: 13 }, (_, index) => `no ${index}`) }).ok).toBe(false);
    expect(invalid({ aspectRatios: { "Article Header": "3:2" } }).ok).toBe(false);
    expect(invalid({ aspectRatios: { article_header: "wide" } }).ok).toBe(false);
    // …and a style sentence over 400 chars, the one bound a model is most likely to run past.
    expect(invalid({ styleSentence: "x".repeat(401) }).ok).toBe(false);
    // sampleSubjects is 1..6, never 0 and never 7.
    expect(validateOutput({ ...PROPOSAL, sampleSubjects: [] }, writerNode.outputSchema).ok).toBe(false);
    expect(validateOutput({ ...PROPOSAL, sampleSubjects: Array.from({ length: 7 }, () => "a subject") }, writerNode.outputSchema).ok).toBe(false);
  });

  it("writes nothing and spends one turn: allowedTools empty, budget $0.25, 1500 output tokens, vision on, both prefetches declared", () => {
    expect(writerNode.allowedTools).toEqual([]);
    expect(writerNode.riskLevel).toBe("read");
    expect(writerNode.modelConfig).toMatchObject({ budgetUsd: 0.25, maxOutputTokens: 1500, vision: true, maxTurns: 1 });
    expect(writerNode.metadata).toMatchObject({ sitePrefetch: true, voicePrefetch: true });
    // §3.5: at least one of references / brief. The node's own inputSchema is what enforces it.
    expect(validateOutput({ mode: "house" }, writerNode.inputSchema).ok).toBe(false);
    expect(validateOutput({ mode: "house", brief: "make it feel like a clinic, not a spa" }, writerNode.inputSchema).ok).toBe(true);
    expect(validateOutput({ mode: "house", references: REFERENCES }, writerNode.inputSchema).ok).toBe(true);
  });
});

// REVIEW — the one path that could produce a receipt for a write that never happened.
//
// node.execute (nodeRuntime.ts's executeNode) dispatches a node runner directly; it takes no
// deterministic route, so nothing in it would ever reach runVisualStandardMaterialization. A live
// node.execute of the materializer was therefore a MODEL turn against an output schema that REQUIRES
// visualStandardId/applied/created, on a run whose projectId is the literal "workspace" — a
// fabricated receipt for a standard nobody created, on a client nobody could reach. The node's own
// prompt asked the model not to; that is guidance, not a control.
describe("visual_standard_materializer is not independently executable through node.execute", () => {
  it("refuses a live node.execute by name, and still allows a mock dry-run traversal", async () => {
    const { executeNode } = await import("../../../src/agent/workspace/nodeRuntime.js");
    const { resetRepositoryManager } = await import("../../../src/agent/runtime/repositories.js");
    resetRepositoryManager();

    await expect(executeNode({ nodeId: "visual_standard_materializer", input: {}, executionMode: "openai" }))
      .rejects.toThrow(/deterministic_node_not_independently_executable/);

    // Mock traversal is untouched: the dry-run placeholder is what it is for, and nothing reads it
    // as a receipt. (It still needs its dependency satisfied like any other node.)
    const mock = await executeNode({
      nodeId: "visual_standard_materializer",
      input: {},
      executionMode: "mock",
      dependencyOutputs: { brand_imagery_writer: { artifact: BRAND_IMAGERY_PROPOSAL_ARTIFACT, mode: "house", label: "L" } }
    });
    expect((mock as { execution: { status: string } }).execution.status).toBe("completed");
    resetRepositoryManager();
  });
});

// REVIEW — every apply-gate case above is driven through a config THIS FILE builds, which proves the
// branch and nothing about the projects that actually exist. `effectiveToolPermission` falls through
// to the client-wide `defaultToolPolicy` for any tool with no row of its own, and platform's default
// is "allowed" — so an undeclared `site_apply_brand_imagery` made the SECOND of this node's two
// gates answer "allowed" on the one project BRIEF §3.3 names by name, leaving the run's own
// `apply: true` as the only thing between a written look and the live site. This asserts the row on
// the real registered config, and then drives the node with it.
describe("the apply gate has something to bite on for the projects that really exist", () => {
  it("platform declares site_apply_brand_imagery as needs_approval (BRIEF §3.3), like its own recipe verb site_apply_theme", async () => {
    const { platformProjectConfig } = await import("../../../src/agent/projects/platform/definition.js");
    const { effectiveToolPermission } = await import("../../../src/agent/projects/projectTypes.js");

    expect(effectiveToolPermission(platformProjectConfig, APPLY_BRAND_IMAGERY_TOOL)).toBe("needs_approval");
    // The verb it mirrors (R6: "Recipe is site_apply_theme") carries the same posture, so the two
    // privileged whole-block site writes cannot drift apart by omission again.
    expect(effectiveToolPermission(platformProjectConfig, "site_apply_theme")).toBe("needs_approval");

    // And the node really is reading THAT: a run that asks to apply gets a draft and a named reason.
    const deps = client();
    const outcome = await materialize(
      runFixture({ initialInput: { apply: true, references: REFERENCES } }),
      deps,
      platformProjectConfig
    );
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    expect(outcome.output.visualStandardId).toBe("vis_platform");
    expect(outcome.output.applied).toBe(false);
    expect(outcome.output.reason).toContain("apply_policy_needs_approval");
    // Nothing on the site was touched — not even the dry run.
    expect(toolsCalled(deps.calls)).toEqual(["object_get", "object_create"]);
  });
});
