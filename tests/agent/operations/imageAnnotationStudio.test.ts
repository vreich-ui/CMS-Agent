import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperationWorkflowBinding, resolveBindingInputContract, UNBOUND_OPERATION_IMPLEMENTING_TASK } from "../../../src/agent/operations/operationWorkflowBindings.js";
import { preflightOperation } from "../../../src/agent/operations/operationPreflight.js";
import { applyWorkflowInitialInput } from "../../../src/agent/workspace/workflowInitialInput.js";
import { IMAGE_ANNOTATION_WORKFLOW_ID } from "../../../src/agent/workspace/imageAnnotationWorkflow.js";
import { listImageAnnotationNodes } from "../../../src/agent/workspace/imageAnnotationNodes.js";
import { runCloneStage } from "../../../src/agent/workspace/cloneConductorRoutes.js";
import { buildImageAnnotationBrief } from "../../../src/agent/capture/imageAnnotationBriefBuilder.js";
import { chooseAnnotationPlacements, type ImageAnnotationGridCell } from "../../../src/agent/capture/imageAnnotationEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { TenantCapabilityFacts } from "../../../src/agent/operations/capabilityReadiness.js";

// =================================================================================================
// T5 (2026-09-16 annotate-bridge plan) — image_annotation, end to end, and the binding that closes
// the gap T3 (#368) opened deliberately and T4 left open.
//
// OFFLINE AND WRITE-FREE: the tenant's MCP surface is a fetch double, exactly as A5's and A8's own
// suites do it. No tenant is called, no artifact is written, and no annotated image is produced —
// what is asserted is the SHAPE of the three bridge calls this workflow would make and, above all,
// that the completion criterion is read from the check_image_text receipt rather than assumed. The
// unhappy paths are the point: a missing string, a verdict-less receipt and an unreadable layout all
// report the criterion UNMET while the annotated artifact still exists.
// =================================================================================================

const TARGET = "zilberman-t5-annotate";
const MCP_ENV_VAR = "ZILBERMAN_T5_ANNOTATE_MCP_ENDPOINT";
const REQUEST_ID = "req_t5_hero";
const BASE_SHA = "a".repeat(64);
const ANNOTATED_SHA = "b".repeat(64);
const BASE_PATH = `/img/${REQUEST_ID}/${BASE_SHA}.webp`;
const ANNOTATED_PATH = `/img/${REQUEST_ID}/${ANNOTATED_SHA}.png`;

type WireCall = { verb: string; args: Record<string, unknown> };
let wire: WireCall[];
let analyzeResponse: Record<string, unknown>;
let annotateResponse: Record<string, unknown>;
let checkResponse: Record<string, unknown>;

// A REAL grid, in the shape analyze_image_layout actually returns (hints.image + hints.grid.cells +
// hints.safeZones). The numbers are chosen so the quiet/busy split is unambiguous: row 4 is the busy
// band, everything else is quiet, and no two cells tie.
const cell = (id: string, lum: number, busy: number) => ({ id, lum, busy, color: "#ffffff" });
const COLUMNS = ["A", "B", "C", "D", "E", "F"];
const gridCells = () =>
  COLUMNS.flatMap((column, columnIndex) =>
    [1, 2, 3, 4, 5, 6].map((row) =>
      cell(`${column}${row}`, row === 4 ? 0.2 : 0.9, row === 4 ? 0.5 + columnIndex / 1000 : 0.001 + columnIndex / 1000 + row / 10000)
    )
  );

const ANALYZE_OK = () => ({
  siteId: `site_${TARGET}`,
  requestId: REQUEST_ID,
  source_public_path: BASE_PATH,
  public_path: BASE_PATH,
  hints: {
    image: { w: 1536, h: 1024 },
    grid: { cols: 6, rows: 6, cells: gridCells() },
    safeZones: [{ rect: { x: 0, y: 0, w: 0.5, h: 1 }, score: 0.6 }],
    faces: [],
    subject: null,
    dominant: ["#ffffff"]
  }
});

const ANNOTATE_OK = () => ({
  ok: true,
  public_path: ANNOTATED_PATH,
  source_public_path: BASE_PATH,
  artifact: { assetId: "asset_1", blobKey: `image/${REQUEST_ID}/${ANNOTATED_SHA}.png`, sha256: ANNOTATED_SHA, contentType: "image/png", sizeBytes: 40000, widthPx: 1536, heightPx: 1024, format: "png" },
  renderReport: { warnings: [] }
});

const installFetchDouble = () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }) }) as unknown as Response;
    if (request.method !== "tools/call") return ok({});
    const verb = String(request.params?.name);
    wire.push({ verb, args: (request.params?.arguments ?? {}) as Record<string, unknown> });
    if (verb === "analyze_image_layout") return ok(analyzeResponse);
    if (verb === "annotate_image") return ok(annotateResponse);
    if (verb === "check_image_text") return ok(checkResponse);
    throw new Error(`Unexpected verb in this fixture: ${verb}`);
  }) as unknown as typeof fetch;
};

const nodes = new Map(listImageAnnotationNodes().map((node) => [node.id, node]));

const runWith = (initialInput: Record<string, unknown>): WorkflowExecutionRecord =>
  ({ projectId: TARGET, workflowId: IMAGE_ANNOTATION_WORKFLOW_ID, initialInput, stageOutputs: {} }) as unknown as WorkflowExecutionRecord;

const stage = async (run: WorkflowExecutionRecord, nodeId: string) => {
  const node = nodes.get(nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  const outcome = await runCloneStage({ run, node, stage: nodeId as never });
  if (outcome.kind === "completed") run.stageOutputs[nodeId] = outcome.output;
  return outcome;
};

const ANNOTATIONS = [
  { text: "Dermatologist-reviewed", role: "title" },
  { text: "Photo: in-clinic, 2026", role: "caption" }
];

const briefRun = (over: Record<string, unknown> = {}) =>
  runWith({
    targetProjectId: TARGET,
    imageAnnotationBrief: { tenantId: TARGET, image: { requestId: REQUEST_ID, sha256: BASE_SHA }, annotations: ANNOTATIONS, ...over }
  });

const runAll = async (over: Record<string, unknown> = {}) => {
  const run = briefRun(over);
  const analyze = await stage(run, "image_annotation_analyze");
  const draw = await stage(run, "image_annotation_draw");
  const verify = await stage(run, "image_annotation_verify");
  return { run, analyze, draw, verify };
};

// The capability facts shape operationPreflight reads, matching imageAnnotationDescriptor.test.ts's
// own fixture: image_annotate derives from the tenant's `annotate_image` grant.
const capableFacts = (overrides: Partial<TenantCapabilityFacts> = {}): TenantCapabilityFacts => ({
  tenantId: "dr-lurie",
  projectStatus: "active",
  objectDialectConfigured: true,
  registeredToolNames: ["annotate_image"],
  ...overrides
});

const capabilitySourceFor = (facts: TenantCapabilityFacts) => ({ capabilitySource: (tenantId: string) => (tenantId === facts.tenantId ? facts : undefined) });

beforeEach(async () => {
  resetRepositoryManager();
  wire = [];
  analyzeResponse = ANALYZE_OK();
  annotateResponse = ANNOTATE_OK();
  checkResponse = { ok: true, textCheck: { mode: "expect", detected: ["Dermatologist-reviewed", "Photo: in-clinic, 2026"], ok: true, warnings: [], matched: ["Dermatologist-reviewed", "Photo: in-clinic, 2026"], missing: [] } };
  process.env[MCP_ENV_VAR] = `https://${TARGET}.example/mcp`;
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "T5 annotate fixture", mcpEndpointEnvVar: MCP_ENV_VAR, authMode: "none", defaultToolPolicy: "allowed" })
  );
  await updateProject(
    repositoryManager.getProjectRepository(),
    TARGET,
    projectUpdateSchema.parse({ objectDialect: { siteObjectId: `site_${TARGET}`, taxonomyRegistryObjectId: `tax_${TARGET}`, objectIdSource: "server_minted" } })
  );
  installFetchDouble();
});

afterEach(() => {
  delete process.env[MCP_ENV_VAR];
  resetRepositoryManager();
});

describe("T5 — the binding", () => {
  it("image_annotation is no longer in the unbound map (which is empty again), and is bound to a REGISTERED workflow", () => {
    expect(UNBOUND_OPERATION_IMPLEMENTING_TASK.image_annotation).toBeUndefined();
    expect(UNBOUND_OPERATION_IMPLEMENTING_TASK).toEqual({});
    expect(getOperationWorkflowBinding("image_annotation")).toEqual({
      operationId: "image_annotation",
      workflowId: "image_annotation_studio",
      inputMapping: {},
      initialInputBuilder: {
        builderId: "image_annotation_brief_builder.v1",
        providesInitialInputFields: ["imageAnnotationBrief"],
        requiredOperationFields: ["tenantId", "image", "annotations"]
      }
    });
  });

  it("the binding's input contract is SATISFIED for a checked reason — the entry node names the brief and the builder is verified to supply exactly that", () => {
    const status = resolveBindingInputContract(getOperationWorkflowBinding("image_annotation")!);
    expect(status.resolved).toBe(true);
    expect(status.contract!.satisfied).toBe(true);
    expect(status.contract!.unsatisfiedBuilderOperationFields).toEqual([]);
    expect(status.contract!.builderProvidedTargetFields).toEqual(["imageAnnotationBrief"]);
    const entryNodeCheck = status.contract!.entryNodeChecks.find((check) => check.nodeId === "image_annotation_analyze");
    expect(entryNodeCheck!.satisfiedAnyOfBranchIndex).toBe(0);
    expect(entryNodeCheck!.unsupportedConstructs).toEqual([]);
    expect(entryNodeCheck!.satisfied).toBe(true);
  });

  // THE ACCEPTANCE THIS TASK EXISTS FOR — the exact flip of imageAnnotationDescriptor.test.ts's own
  // T3-era assertion: preflight reported executable:false and a not_supported workflow_binding gap
  // naming T4, and now reports a real binding it would genuinely run.
  it("preflight reports executable:true and a non-null binding on a capable tenant — no workflow_binding gap anywhere", () => {
    const result = preflightOperation(
      {
        operationId: "image_annotation",
        tenantId: "dr-lurie",
        input: { tenantId: "dr-lurie", image: { requestId: REQUEST_ID, sha256: BASE_SHA }, annotations: [{ text: "Dermatologist-reviewed", role: "badge" }] }
      },
      capabilitySourceFor(capableFacts())
    );
    expect(result.executable).toBe(true);
    expect(result.binding).toMatchObject({ operationId: "image_annotation", workflowId: "image_annotation_studio", inputMapping: {} });
    expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
    expect(result.capabilityGaps.some((gap) => gap.reason === "not_supported")).toBe(false);
  });

  it("a tenant without the annotate_image grant is still not executable — but for a CAPABILITY reason, never 'no implementation exists'", () => {
    const result = preflightOperation(
      {
        operationId: "image_annotation",
        tenantId: "dr-lurie",
        input: { tenantId: "dr-lurie", image: { requestId: REQUEST_ID, sha256: BASE_SHA }, annotations: [{ text: "Hello", role: "label" }] }
      },
      capabilitySourceFor(capableFacts({ registeredToolNames: [] }))
    );
    expect(result.executable).toBe(false);
    expect(result.capabilityGaps.some((gap) => gap.capability === "image_annotate")).toBe(true);
    expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
  });

  it("a Platform-shaped dispatch is CONSTRUCTED into the nested brief, and a publicPath is resolved into the requestId every bridge verb needs", () => {
    const built = applyWorkflowInitialInput(IMAGE_ANNOTATION_WORKFLOW_ID, {
      tenantId: TARGET,
      image: { publicPath: BASE_PATH },
      annotations: [{ text: "Step one", role: "badge" }],
      deviceScaleFactor: 2
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.input as Record<string, unknown>).imageAnnotationBrief).toEqual({
      tenantId: TARGET,
      image: { requestId: REQUEST_ID, sha256: BASE_SHA, publicPath: BASE_PATH },
      annotations: [{ text: "Step one", role: "badge" }],
      deviceScaleFactor: 2
    });
  });

  it("a publicPath that is not the bridge's own addressing form is refused BY NAME, never sent to the bridge to fail there", () => {
    const refused = buildImageAnnotationBrief({ tenantId: TARGET, image: { publicPath: "/images/hero.png" }, annotations: [{ text: "Hi", role: "label" }] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("image_annotation_brief_public_path_unaddressable");
  });

  it("two names for one artifact must agree — a requestId that contradicts the publicPath is refused, neither silently preferred", () => {
    const refused = buildImageAnnotationBrief({
      tenantId: TARGET,
      image: { requestId: "req_something_else", publicPath: BASE_PATH },
      annotations: [{ text: "Hi", role: "label" }]
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("image_annotation_brief_image_ref_conflict");
  });

  it("a duplicate annotation string is refused — the completion check matches substrings and could never tell one copy from two", () => {
    const refused = buildImageAnnotationBrief({
      tenantId: TARGET,
      image: { requestId: REQUEST_ID, sha256: BASE_SHA },
      annotations: [{ text: "Repeat", role: "label" }, { text: "repeat", role: "caption" }]
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("image_annotation_brief_annotation_duplicate");
  });
});

describe("T5 — the placement is READ, never hardcoded", () => {
  it("favours low busyness, keeps a title in the top band and a caption in the bottom band, and never stacks two strings on one cell", () => {
    const cells = gridCells() as ImageAnnotationGridCell[];
    const placements = chooseAnnotationPlacements(cells, [
      { text: "Title", role: "title" },
      { text: "Caption", role: "caption" },
      { text: "Label", role: "label" }
    ]);
    expect(placements.map((placement) => placement.cell)).toHaveLength(3);
    expect(new Set(placements.map((placement) => placement.cell)).size).toBe(3);
    expect(Number.parseInt(placements[0].cell.slice(1), 10)).toBeLessThanOrEqual(2);
    expect(Number.parseInt(placements[1].cell.slice(1), 10)).toBeGreaterThanOrEqual(5);
    // Row 4 is this fixture's busy band; nothing is placed there while quiet cells remain.
    expect(placements.every((placement) => !placement.cell.endsWith("4"))).toBe(true);
    // The text colour comes from the chosen cell's OWN luminance (0.9 here — a light cell).
    expect(placements.every((placement) => placement.textColor === "#111111")).toBe(true);
  });

  it("is deterministic — the same grid and the same annotations produce the same picture", () => {
    const cells = gridCells() as ImageAnnotationGridCell[];
    const first = chooseAnnotationPlacements(cells, ANNOTATIONS as never);
    const second = chooseAnnotationPlacements(cells, ANNOTATIONS as never);
    expect(first).toEqual(second);
  });

  it("a dark cell gets light text — the contrast decision is made from lum, not from a default", () => {
    const placements = chooseAnnotationPlacements([{ id: "C3", lum: 0.1, busy: 0.001, color: null }], [{ text: "Over a dark photo", role: "title" }]);
    expect(placements[0].textColor).toBe("#ffffff");
  });
});

describe("T5 — the run (happy path)", () => {
  it("reads the layout, draws one element per annotation, and verifies the drawn strings — annotation_text_verified met", async () => {
    const { run, verify } = await runAll();
    if (verify.kind !== "completed") throw new Error(`expected a completed verify stage, got ${JSON.stringify(verify)}`);

    expect(wire.map((call) => call.verb)).toEqual(["analyze_image_layout", "annotate_image", "check_image_text"]);

    // Every bridge call is site-scoped from the PROJECT RECORD, never from the tenantId.
    expect(wire.every((call) => call.args.site_id === `site_${TARGET}`)).toBe(true);
    expect(wire.every((call) => call.args.request_id === REQUEST_ID)).toBe(true);

    // The analyze stage placed both strings from the reported numbers.
    const analyze = run.stageOutputs.image_annotation_analyze as Record<string, unknown>;
    expect(analyze.canvas).toEqual({ w: 1536, h: 1024 });
    expect((analyze.placements as unknown[]).length).toBe(2);

    // ONE element per entry in annotations[], each carrying its own role as the AnnotationSpec text
    // style, positioned at the cell the layout read chose.
    const annotate = wire.find((call) => call.verb === "annotate_image")!;
    const spec = annotate.args.spec as { version: number; canvas: { w: number; h: number }; elements: Array<Record<string, unknown>> };
    expect(spec.version).toBe(1);
    expect(spec.canvas).toEqual({ w: 1536, h: 1024 });
    expect(spec.elements.map((element) => [element.content, element.style])).toEqual([
      ["Dermatologist-reviewed", "title"],
      ["Photo: in-clinic, 2026", "caption"]
    ]);
    expect(spec.elements.every((element) => typeof element.at === "string" && /^[A-F][1-6]$/.test(element.at as string))).toBe(true);
    // `base` is deliberately omitted — the bridge fills it in from the artifact the call names.
    expect("base" in spec).toBe(false);

    // The completion evidence is check_image_text {mode:"expect"} with EXACTLY the drawn strings,
    // over the NEW artifact — never the base image.
    const check = wire.find((call) => call.verb === "check_image_text")!;
    expect(check.args.mode).toBe("expect");
    expect(check.args.expect).toEqual(["Dermatologist-reviewed", "Photo: in-clinic, 2026"]);
    expect(check.args.public_path).toBe(ANNOTATED_PATH);

    expect(verify.output.annotationTextVerified).toBe(true);
    expect(verify.output.completed).toBe(true);
    expect(verify.output.missing).toEqual([]);
    expect(verify.output.evidence).toMatchObject({ kind: "image_text_check", textCheckOk: true });
  });

  it("the optional slot and deviceScaleFactor travel to annotate_image only when the operation asked for them", async () => {
    await runAll({ slot: "hero_annotated", deviceScaleFactor: 2 });
    const annotate = wire.find((call) => call.verb === "annotate_image")!;
    expect(annotate.args.slot).toBe("hero_annotated");
    expect(annotate.args.device_scale_factor).toBe(2);

    wire = [];
    await runAll();
    const plain = wire.find((call) => call.verb === "annotate_image")!;
    expect("slot" in plain.args).toBe(false);
    expect("device_scale_factor" in plain.args).toBe(false);
  });

  it("renderReport warnings ride along with a SUCCESSFUL render and never block — the descriptor forbids inventing a gate out of them", async () => {
    annotateResponse = { ...ANNOTATE_OK(), renderReport: { warnings: ["TEXT_SHRUNK", "CONTRAST_LOW"] } };
    const { draw, verify } = await runAll();
    expect(draw.kind).toBe("completed");
    if (draw.kind !== "completed" || verify.kind !== "completed") throw new Error("expected completed stages");
    expect(draw.output.warnings).toEqual(["TEXT_SHRUNK", "CONTRAST_LOW"]);
    // Still verified: a warning is information, not a verdict about what the pixels say.
    expect(verify.output.annotationTextVerified).toBe(true);
    expect(verify.output.warnings).toEqual(expect.arrayContaining(["TEXT_SHRUNK", "CONTRAST_LOW"]));
  });
});

describe("T5 — the run (the completion contract under failure)", () => {
  it("a missing string reports annotation_text_verified FALSE and names it — the annotated artifact still exists", async () => {
    checkResponse = {
      ok: true,
      textCheck: { mode: "expect", detected: ["Dermatologist-reviewed"], ok: false, warnings: [], matched: ["Dermatologist-reviewed"], missing: ["Photo: in-clinic, 2026"] }
    };
    const { verify } = await runAll();
    if (verify.kind !== "completed") throw new Error("expected a completed verify stage");
    expect(verify.output.annotationTextVerified).toBe(false);
    expect(verify.output.completed).toBe(false);
    expect(verify.output.missing).toEqual(["Photo: in-clinic, 2026"]);
    expect(verify.output.matched).toEqual(["Dermatologist-reviewed"]);
    // The render itself succeeded and is reported as such — this is the completion criterion, not
    // the render. The warn-only check never turned into a stage failure.
    expect(verify.output.annotatedPublicPath).toBe(ANNOTATED_PATH);
    expect(String(verify.output.summary)).toContain("annotation_text_verified is NOT met");
  });

  it("a receipt with NO verdict is not a pass — an absent ok is reported as unverified with the reason stated", async () => {
    checkResponse = { ok: true, textCheck: { mode: "expect", detected: [], warnings: [] } };
    const { verify } = await runAll();
    if (verify.kind !== "completed") throw new Error("expected a completed verify stage");
    expect(verify.output.annotationTextVerified).toBe(false);
    expect((verify.output.evidence as { textCheckOk: boolean | null }).textCheckOk).toBeNull();
    // `missing` is DERIVED by subtraction when the receipt names none — never assumed empty.
    expect(verify.output.missing).toEqual(["Dermatologist-reviewed", "Photo: in-clinic, 2026"]);
  });

  it("no textCheck receipt at all reports unverified, with the absence named rather than defaulted away", async () => {
    checkResponse = { ok: true };
    const { verify } = await runAll();
    if (verify.kind !== "completed") throw new Error("expected a completed verify stage");
    expect(verify.output.annotationTextVerified).toBe(false);
    expect(String((verify.output.evidence as { source: string }).source)).toContain("no verdict");
  });
});

describe("T5 — the refusals that keep this honest", () => {
  it("a layout report with no image dimensions is refused by name — the canvas is never guessed, and nothing is drawn", async () => {
    analyzeResponse = { ...ANALYZE_OK(), hints: { grid: { cells: gridCells() }, safeZones: [] } };
    const run = briefRun();
    const outcome = await stage(run, "image_annotation_analyze");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("image_annotation_canvas_unknown");
    expect(wire.map((call) => call.verb)).toEqual(["analyze_image_layout"]);
  });

  it("a layout report with no usable cells is refused by name — a default cell would be exactly the guess the read exists to prevent", async () => {
    analyzeResponse = { ...ANALYZE_OK(), hints: { image: { w: 800, h: 600 }, grid: { cells: [] }, safeZones: [] } };
    const run = briefRun();
    const outcome = await stage(run, "image_annotation_analyze");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("image_annotation_layout_unreadable");
    expect(wire.some((call) => call.verb === "annotate_image")).toBe(false);
  });

  it("an annotate_image result with no addressable public_path is refused — there would be nothing to read the completion evidence out of", async () => {
    annotateResponse = { ok: true, artifact: { sha256: ANNOTATED_SHA }, renderReport: { warnings: [] } };
    const run = briefRun();
    await stage(run, "image_annotation_analyze");
    const outcome = await stage(run, "image_annotation_draw");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("image_annotation_artifact_unaddressable");
    expect(wire.some((call) => call.verb === "check_image_text")).toBe(false);
  });

  it("a run with no brief is refused by name at the dispatch boundary, and calls nothing", async () => {
    const run = runWith({ targetProjectId: TARGET });
    const outcome = await stage(run, "image_annotation_analyze");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("image_annotation_brief_missing");
    expect(wire).toEqual([]);
  });

  it("the draw stage never builds on a placeholder or malformed upstream envelope", async () => {
    const run = briefRun();
    run.stageOutputs.image_annotation_analyze = { artifact: "something.else.v1", summary: "not the layout read" };
    const outcome = await stage(run, "image_annotation_draw");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("clone_upstream_artifact_invalid");
    expect(wire).toEqual([]);
  });
});
