import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  advanceCapturePreview,
  capturePreviewConfig,
  previewSiteDirFor,
  readCapturePreviewState,
  CAPTURE_PREVIEW_MAX_WAIT_MS,
  CAPTURE_PREVIEW_REPORT_BLOB_ARTIFACT_PREFIX,
  CAPTURE_SCORE_PREVIEW_STAGE_KEY,
  type CapturePreviewConfig
} from "../../../src/agent/workspace/capturePreviewDispatch.js";
import { runCaptureStage } from "../../../src/agent/workspace/captureConductorRoutes.js";
import { listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { captureMapStep, captureScoreStep, captureThemeStep, graftExternalVisualEvidence } from "../../../src/agent/capture/captureEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// W2.1/G6-T2 — THE SCORE STAGE'S DRAFT-PREVIEW LEG.
//
// The conductor called captureScoreStep with no previewManifest and no screenshotRoot, so every
// visual pair read `unavailable` and the run reported `visual 0 scored / N unavailable` while
// completing normally. It was not a bug in the scorer: this process holds NEITHER side of the diff
// (no Chromium, no Astro, and the source screenshots live in pdf-tool's own store), so the
// rendering and the pixel diff happen on the platform repo's CI and the report comes back here.
//
// What this file pins, in order of how much damage getting it wrong would do:
//
//   1. A GRAFT IS CHECKED, NEVER TRUSTED. A visual block from a report that scored a different
//      target, a different mapping, or a different schema is REFUSED and named. Grafting a foreign
//      report would make the run state a fidelity number about pixels it never captured — a lie
//      that looks exactly like success.
//   2. The stage waits the way its siblings wait: `pending` under its own stage key, re-queued by
//      the continuation tick, never spinning inside one deterministic-stage claim.
//   3. EVERY failure degrades to a NAMED reason and a normal score, so a capture run is never
//      blocked by a preview job — and never silently claims the evidence is fine either.

const fixture = async (name: string) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../../fixtures/capture/${name}`, import.meta.url)), "utf8"));

const TARGET = "zilberman-preview-dispatch";

const CAPTURE_POLICY: ProjectConnectionConfig["capturePolicy"] = {
  maxPages: 20,
  allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
  allowedPathPrefixes: ["/"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 0,
  authenticatedAccess: "prohibited",
  rights: { content: "retain_allowed_origin_content", media: "prohibited" },
  designReferences: [],
  fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
};

const stubRepository = (config: ProjectConnectionConfig): ProjectRepository => ({
  list: async () => [config],
  get: async (projectId: string) => (config.projectId === projectId ? config : undefined),
  save: async (value) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} } as never)
});

const stubProject = (): ProjectConnectionConfig => ({
  projectId: TARGET,
  name: "Zilberman preview dispatch",
  mcpEndpointEnvVar: "ZB_PREVIEW_DISPATCH_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  contentContract: { contentContract: "content_source.v1" },
  capturePolicy: CAPTURE_POLICY,
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
  status: "active"
});

const CONFIG: CapturePreviewConfig = {
  token: "ghp-test",
  repository: "vreich-ui/platform",
  workflow: "capture-preview.yaml",
  ref: "main",
  apiBaseUrl: "https://api.github.test"
};

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const blobSha = (seed: string) => seed.repeat(40).slice(0, 40);

/** A scripted GitHub: blob writes, a dispatch, a run listing, a run read, an artifact listing. */
function githubDouble(script: {
  run?: { id: number; name: string; status: string; conclusion?: string | null };
  artifacts?: Array<{ name: string }>;
  blobs?: Record<string, unknown>;
  onDispatch?: (body: Record<string, unknown>) => void;
}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let written = 0;
  const fetchImpl = (async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (method === "POST" && url.endsWith("/git/blobs")) return json({ sha: blobSha(String(written++)) });
    if (method === "POST" && url.includes("/dispatches")) {
      script.onDispatch?.(body as Record<string, unknown>);
      return { ok: true, status: 204, json: async () => undefined, text: async () => "" };
    }
    if (url.includes("/actions/workflows/") && url.includes("/runs?")) {
      return json({ workflow_runs: script.run ? [script.run] : [] });
    }
    if (/\/actions\/runs\/\d+\/artifacts/.test(url)) return json({ artifacts: script.artifacts ?? [] });
    if (/\/actions\/runs\/\d+$/.test(url)) return json(script.run ?? {});
    const blobMatch = /\/git\/blobs\/([0-9a-f]{40})$/.exec(url);
    if (blobMatch) {
      const document = script.blobs?.[blobMatch[1]];
      if (!document) return json({ message: "Not Found" }, 404);
      return json({ content: Buffer.from(JSON.stringify(document), "utf8").toString("base64"), encoding: "base64" });
    }
    return json({ message: `unscripted ${method} ${url}` }, 500);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("W2.1/G6-T2: configuration is explicit, and a missing one is a legitimate state", () => {
  it("reads no config without a token, and defaults the rest around one", () => {
    expect(capturePreviewConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(capturePreviewConfig({ CAPTURE_PREVIEW_GITHUB_TOKEN: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(capturePreviewConfig({ CAPTURE_PREVIEW_GITHUB_TOKEN: "t" } as NodeJS.ProcessEnv)).toEqual({
      token: "t",
      repository: "vreich-ui/platform",
      workflow: "capture-preview.yaml",
      ref: "main",
      apiBaseUrl: "https://api.github.com"
    });
  });

  it("derives the tenant's site directory from the registry, and refuses to guess when it cannot", () => {
    expect(previewSiteDirFor("site_zilberman")).toBe("sites/zilberman");
    expect(previewSiteDirFor(" site_drlurie ")).toBe("sites/drlurie");
    // Previewing the WRONG tenant's site would produce a confident, meaningless score.
    for (const bad of [undefined, "", "zilberman", "site_", "site_../escape", "site_a/b"]) {
      expect(previewSiteDirFor(bad)).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("W2.1/G6-T2: the dispatch/collect lifecycle", () => {
  it("first pass writes one blob per document, dispatches with a correlation id, and returns pending", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const { fetchImpl, calls } = githubDouble({ onDispatch: (body) => { dispatched = body; } });
    const outcome = await advanceCapturePreview(
      {
        runId: "run-1",
        nodeId: "capture_score",
        targetProjectId: TARGET,
        siteDir: "sites/zilberman",
        captureJobId: "job-9",
        config: CONFIG,
        documents: { snapshot: { a: 1 }, mapping: { b: 2 }, plan: { c: 3 }, theme: { d: 4 } }
      },
      { fetchImpl }
    );
    expect(outcome.kind).toBe("pending");
    if (outcome.kind !== "pending") throw new Error("unreachable");
    expect(outcome.state.status).toBe("dispatched");
    expect(outcome.state.correlationId).toContain("run-1:capture_score:");

    // Four blobs: the documents are far past a dispatch payload's ceiling, so only shas travel.
    expect(calls.filter((call) => call.url.endsWith("/git/blobs")).length).toBe(4);
    const inputs = dispatched?.inputs as Record<string, string>;
    expect(dispatched?.ref).toBe("main");
    expect(inputs.target).toBe(TARGET);
    expect(inputs.site).toBe("sites/zilberman");
    expect(inputs.capture_job_id).toBe("job-9");
    expect(inputs.cms_run_id).toBe(outcome.state.correlationId);
    for (const key of ["snapshot_blob", "mapping_blob", "plan_blob", "theme_blob"]) {
      expect(inputs[key]).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("waits while the run is queued or running, then collects the report off the marker artifact", async () => {
    const state = {
      status: "dispatched" as const,
      correlationId: "run-1:capture_score:abc",
      dispatchedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0
    };
    const base = {
      runId: "run-1",
      nodeId: "capture_score",
      targetProjectId: TARGET,
      siteDir: "sites/zilberman",
      config: CONFIG,
      documents: { snapshot: {}, mapping: {}, plan: {}, theme: {} }
    };

    // Not listed yet — a dispatch is asynchronous; this is normal, not a failure.
    const notYet = await advanceCapturePreview({ ...base, state }, githubDouble({}));
    expect(notYet.kind).toBe("pending");

    // Listed but still running.
    const running = await advanceCapturePreview(
      { ...base, state },
      githubDouble({ run: { id: 55, name: `capture-preview ${TARGET} ${state.correlationId}`, status: "in_progress", conclusion: null } })
    );
    expect(running.kind).toBe("pending");
    if (running.kind !== "pending") throw new Error("unreachable");
    expect(running.state.workflowRunId).toBe(55);

    // Completed: the sha is the marker artifact's NAME, and the report is read as a git blob —
    // no archive download, no unzip, no new dependency in this image.
    const sha = blobSha("a");
    const report = { schemaVersion: "capture-fidelity-report.v1", target: TARGET, visual: { scoredCount: 12 } };
    const done = await advanceCapturePreview(
      { ...base, state: { ...state, workflowRunId: 55 } },
      githubDouble({
        run: { id: 55, name: "x", status: "completed", conclusion: "success" },
        artifacts: [{ name: "capture-fidelity-123" }, { name: `${CAPTURE_PREVIEW_REPORT_BLOB_ARTIFACT_PREFIX}${sha}` }],
        blobs: { [sha]: report }
      })
    );
    expect(done.kind).toBe("collected");
    if (done.kind !== "collected") throw new Error("unreachable");
    expect(done.report).toEqual(report);
    expect(done.state.reportBlobSha).toBe(sha);
  });

  it("stops waiting at a ceiling, and names every refusal instead of retrying forever", async () => {
    const base = {
      runId: "run-1",
      nodeId: "capture_score",
      targetProjectId: TARGET,
      siteDir: "sites/zilberman",
      config: CONFIG,
      documents: { snapshot: {}, mapping: {}, plan: {}, theme: {} }
    };
    const stale = {
      status: "dispatched" as const,
      correlationId: "run-1:capture_score:old",
      dispatchedAt: new Date(Date.now() - CAPTURE_PREVIEW_MAX_WAIT_MS - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 40
    };
    const timedOut = await advanceCapturePreview({ ...base, state: stale }, githubDouble({}));
    expect(timedOut.kind).toBe("unavailable");
    if (timedOut.kind !== "unavailable") throw new Error("unreachable");
    expect(timedOut.reason).toContain("capture_preview_timed_out_after_");

    // A finished run that published no report is terminal and named — never polled again.
    const noReport = await advanceCapturePreview(
      { ...base, state: { status: "dispatched", correlationId: "c", dispatchedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, workflowRunId: 7 } },
      githubDouble({ run: { id: 7, name: "x", status: "completed", conclusion: "failure" }, artifacts: [] })
    );
    expect(noReport.kind).toBe("unavailable");
    if (noReport.kind !== "unavailable") throw new Error("unreachable");
    expect(noReport.reason).toBe("capture_preview_report_absent:failure");

    // A refused dispatch is reported, not thrown into the run's face.
    const refusedDispatch = (async (url: string, init: { method?: string } = {}) =>
      (init.method === "POST" && String(url).endsWith("/git/blobs")
        ? json({ sha: blobSha("b") })
        : { ok: false, status: 403, json: async () => ({}), text: async () => "workflow dispatch forbidden" })) as unknown as typeof fetch;
    const refused = await advanceCapturePreview(base, { fetchImpl: refusedDispatch });
    expect(refused.kind).toBe("unavailable");
    if (refused.kind !== "unavailable") throw new Error("unreachable");
    expect(refused.reason).toContain("capture_preview_dispatch_refused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("W2.1/G6-T2: a grafted visual block is checked, never trusted", () => {
  let local: Awaited<ReturnType<typeof captureScoreStep>>;

  beforeEach(async () => {
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    const deps = { projectRepository: stubRepository(stubProject()) };
    const mapping = await captureMapStep({ targetProjectId: TARGET, snapshot, suggestions: [] }, deps);
    const theme = await captureThemeStep({ targetProjectId: TARGET, snapshot }, deps);
    local = await captureScoreStep({ targetProjectId: TARGET, snapshot, mapping: mapping.mapping, theme: theme.theme }, deps);
  });

  const ciReport = (over: Record<string, unknown> = {}) => ({
    schemaVersion: "capture-fidelity-report.v1",
    target: TARGET,
    visual: {
      ...local.report.visual,
      comparisons: local.report.visual.comparisons.map((comparison) => ({ ...comparison, status: "scored", score: 0.87 })),
      scoredCount: local.report.visual.comparisons.length,
      unavailableCount: 0,
      aggregateScore: 0.87,
      defects: [],
      defectCount: 0,
      evidenceComplete: true,
      pagesWithoutScoredComparison: []
    },
    ...over
  });

  it("grafts a report scored over THIS run's own mapping, and stamps its provenance", () => {
    const grafted = graftExternalVisualEvidence(local.report, ciReport(), { workflowRunId: 55 });
    expect(grafted.grafted).toBe(true);
    expect(grafted.visual.scoredCount).toBe(local.report.visual.comparisons.length);
    expect(grafted.visual.evidenceComplete).toBe(true);
    expect(grafted.visual.provenance).toEqual({ plane: "platform_ci", workflowRunId: 55 });
  });

  it("refuses a foreign, stale or malformed report with a named reason, keeping the local block", () => {
    const cases: Array<[unknown, string]> = [
      [null, "external_visual_report_not_an_object"],
      [{ ...ciReport(), schemaVersion: "capture-fidelity-report.v0" }, "external_visual_report_wrong_schema"],
      [{ ...ciReport(), target: "some-other-tenant" }, "external_visual_report_targets_another_project"],
      [{ schemaVersion: "capture-fidelity-report.v1", target: TARGET }, "external_visual_report_has_no_comparisons"],
      [
        // The killer case: a real report, of the right shape, for the right project — but scored
        // over a DIFFERENT capture of the same site. Its numbers describe other pixels.
        { ...ciReport(), visual: { ...ciReport().visual, comparisons: [{ pageRef: "page_that_is_not_ours", blockRef: "b", viewportId: "desktop", status: "scored", score: 1 }] } },
        "external_visual_report_scored_a_different_mapping"
      ]
    ];
    for (const [external, reason] of cases) {
      const refused = graftExternalVisualEvidence(local.report, external);
      expect(refused.grafted).toBe(false);
      expect(refused.reason).toBe(reason);
      expect(refused.visual).toBe(local.report.visual);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("W2.1/G6-T2: the score stage itself", () => {
  const ORIGINAL = process.env.CAPTURE_PREVIEW_GITHUB_TOKEN;

  beforeEach(() => {
    resetRepositoryManager();
    delete process.env.CAPTURE_PREVIEW_GITHUB_TOKEN;
  });
  afterEach(() => {
    resetRepositoryManager();
    vi.unstubAllGlobals();
    if (ORIGINAL === undefined) delete process.env.CAPTURE_PREVIEW_GITHUB_TOKEN;
    else process.env.CAPTURE_PREVIEW_GITHUB_TOKEN = ORIGINAL;
  });

  const scoreNode = () => listCaptureConductorNodes().find((candidate) => candidate.id === "capture_score")!;

  async function buildRun(extraStageOutputs: Record<string, unknown> = {}) {
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Zilberman preview dispatch",
        mcpEndpointEnvVar: "ZB_PREVIEW_DISPATCH_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed",
        capturePolicy: CAPTURE_POLICY
      })
    );
    await updateProject(
      repositoryManager.getProjectRepository(),
      TARGET,
      projectUpdateSchema.parse({ objectDialect: { siteObjectId: "site_zilberman", taxonomyRegistryObjectId: "tax_zilberman", objectIdSource: "server_minted" } })
    );
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    const deps = { projectRepository: repositoryManager.getProjectRepository() };
    const mapping = await captureMapStep({ targetProjectId: TARGET, snapshot, suggestions: [] }, deps);
    const theme = await captureThemeStep({ targetProjectId: TARGET, snapshot }, deps);
    const run = {
      runId: "run-preview-1",
      projectId: TARGET,
      initialInput: {},
      stageOutputs: {
        capture_crawl: { artifact: "capture_snapshot.v1", snapshot },
        capture_map_refine: { artifact: "capture_map_refined.v1", mapping: mapping.mapping },
        capture_theme: { artifact: "capture_theme.v1", theme: theme.theme },
        capture_emit_live: { artifact: "capture_emission_run.v1", live: true, plan: { schemaVersion: "capture-emission-plan.v1", pages: [] }, report: {} },
        ...extraStageOutputs
      }
    } as unknown as WorkflowExecutionRecord;
    return { run, snapshot, mapping, theme };
  }

  it("scores with a NAMED reason and no preview when this deployment is not wired to a platform CI", async () => {
    const { run } = await buildRun();
    const outcome = await runCaptureStage({ run, node: scoreNode(), stage: "score" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    // The run still scores — a capture is never blocked because a preview job could not start.
    expect(outcome.output.artifact).toBe("capture_fidelity.v1");
    expect(outcome.output.capturePreview).toEqual({ attempted: false, evidence: "unavailable", reason: "capture_preview_not_configured" });
    // ...and W2.1/G6-T3 says out loud that the evidence is incomplete.
    const evidence = outcome.output.visualEvidence as { evidenceComplete: boolean; dominantReason: string | null };
    expect(evidence.evidenceComplete).toBe(false);
    expect(evidence.dominantReason).toBe("source_screenshot_binary_not_available");
  });

  it("dispatches and returns PENDING under its own stage key — the shape capture_crawl already uses", async () => {
    process.env.CAPTURE_PREVIEW_GITHUB_TOKEN = "ghp-test";
    const { fetchImpl } = githubDouble({});
    vi.stubGlobal("fetch", fetchImpl);
    const { run } = await buildRun();

    const outcome = await runCaptureStage({ run, node: scoreNode(), stage: "score" });
    expect(outcome.kind).toBe("pending");
    if (outcome.kind !== "pending") throw new Error("unreachable");
    // Its OWN key, so it can never collide with a node id or with the crawl/emit ledgers.
    expect(outcome.jobStateKey).toBe(CAPTURE_SCORE_PREVIEW_STAGE_KEY);
    expect(outcome.jobStateKey).toContain(":");
    expect(outcome.warning).toContain("capture_score_preview_dispatched:");
    // Nothing is in flight in THIS process: the node is re-queued and the continuation tick /
    // conductor job advance it, exactly as the deterministic-stage claim contract requires.
    const persisted = readCapturePreviewState({ stageOutputs: { [CAPTURE_SCORE_PREVIEW_STAGE_KEY]: outcome.jobState } } as unknown as WorkflowExecutionRecord);
    expect(persisted?.status).toBe("dispatched");
  });

  it("collects the CI report on a later advance and scores REAL visual comparisons from it", async () => {
    process.env.CAPTURE_PREVIEW_GITHUB_TOKEN = "ghp-test";
    const { run } = await buildRun();

    // What the local scorer WOULD have produced with no evidence — the comparison triples the CI
    // run is expected to have scored.
    const baseline = await runCaptureStage({ run, node: scoreNode(), stage: "score" });
    expect(baseline.kind).toBe("completed");
    if (baseline.kind !== "completed") throw new Error("unreachable");
    const localReport = (baseline.output.report as { visual: { comparisons: Array<Record<string, unknown>> } }).visual.comparisons;
    expect(localReport.length).toBeGreaterThan(0);

    const sha = blobSha("c");
    const correlationId = "run-preview-1:capture_score:xyz";
    const { fetchImpl } = githubDouble({
      run: { id: 77, name: `capture-preview ${TARGET} ${correlationId}`, status: "completed", conclusion: "success" },
      artifacts: [{ name: `${CAPTURE_PREVIEW_REPORT_BLOB_ARTIFACT_PREFIX}${sha}` }],
      blobs: {
        [sha]: {
          schemaVersion: "capture-fidelity-report.v1",
          target: TARGET,
          visual: {
            comparisons: localReport.map((comparison) => ({ ...comparison, status: "scored", score: 0.91 })),
            aggregateScore: 0.91,
            scoredCount: localReport.length,
            unavailableCount: 0,
            pagesWithoutScoredComparison: [],
            defects: [],
            defectCount: 0,
            evidenceComplete: true
          }
        }
      }
    });
    vi.stubGlobal("fetch", fetchImpl);

    const resumed = {
      ...run,
      stageOutputs: {
        ...run.stageOutputs,
        [CAPTURE_SCORE_PREVIEW_STAGE_KEY]: {
          status: "dispatched",
          correlationId,
          dispatchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attempts: 2,
          workflowRunId: 77
        }
      }
    } as unknown as WorkflowExecutionRecord;

    const outcome = await runCaptureStage({ run: resumed, node: scoreNode(), stage: "score" });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");

    // THE ACCEPTANCE CRITERION: N scored / 0 unavailable, with a real aggregate score.
    const report = outcome.output.report as { visual: { scoredCount: number; unavailableCount: number; aggregateScore: number | null; provenance?: Record<string, unknown> } };
    expect(report.visual.scoredCount).toBe(localReport.length);
    expect(report.visual.unavailableCount).toBe(0);
    expect(report.visual.aggregateScore).toBe(0.91);
    expect(report.visual.provenance).toMatchObject({ plane: "platform_ci", workflowRunId: 77, reportBlobSha: sha });

    // The stage now says the evidence is complete, and the summary stops carrying a warning.
    const evidence = outcome.output.visualEvidence as { evidenceComplete: boolean; warning: string | null };
    expect(evidence.evidenceComplete).toBe(true);
    expect(evidence.warning).toBeNull();
    expect(String(outcome.output.summary)).not.toContain("WARNING");
    expect(outcome.output.capturePreview).toMatchObject({ attempted: true, evidence: "collected", workflowRunId: 77 });

    // The rubric is still LOCAL — only the visual block came from CI.
    expect(outcome.output.rubric).toEqual((baseline.output.report as { rubric: unknown }).rubric);
  });
});
