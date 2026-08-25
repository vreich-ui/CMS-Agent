import { describe, expect, it } from "vitest";
import { capturePublishStep, CaptureRefusal, __test__ } from "../../../src/agent/capture/captureEngine.js";
import { readCaptureStage, CAPTURE_STAGES } from "../../../src/agent/workspace/captureConductorRoutes.js";
import { PUBLISH_FORBIDDEN_VERBS } from "../../../src/agent/capture/engine/publish.mjs";
import { listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";

// T14.5 — the publish tail is the only path in this engine that reaches production. Wolf's ruling
// removed the HUMAN gate ("it needs to be assumed that the human is not involved"); it did not
// remove the machine's obligation to know what it is publishing. These are the refusals that keep
// "publish by default" from becoming "publish anything".

const AUTHORIZED_POLICY = {
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

const projectRepository = (overrides: Record<string, unknown> = {}) => ({
  list: async () => [],
  save: async (value: unknown) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} }),
  async get() {
    return {
      projectId: "zilberman",
      name: "Zilberman publish tail test",
      mcpEndpointEnvVar: "ZB_TEST_MCP_ENDPOINT",
      authMode: "none",
      allowedTools: [],
      defaultToolPolicy: "allowed",
      contentContract: { contentContract: "content_source.v1" },
      capturePolicy: structuredClone(AUTHORIZED_POLICY),
      publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, operatorDefault: "approved" },
      status: "active",
      ...overrides
    };
  }
}) as never;

const liveEmission = () => ({
  artifact: "capture_emission_run.v1",
  live: true,
  report: {
    target: "zilberman",
    reusedObjects: [{ objectType: "page", objectId: "page_home", mode: "patched" }],
    createdObjects: [],
    quarantines: [],
    validationStates: [{ phase: "postpatch", objectId: "page_home", valid: true, reason: null }]
  }
});

describe("the capture publish tail", () => {
  it("is a declared deterministic stage, wired to a node, and the report depends on it", () => {
    expect(CAPTURE_STAGES).toContain("publish");
    const nodes = listCaptureConductorNodes();
    const publish = nodes.find((node) => node.id === "capture_publish")!;
    expect(readCaptureStage(publish)).toBe("publish");
    // The one write-to-production node in the workflow.
    expect(publish.riskLevel).toBe("write");
    // The report is still terminal, and it now cannot run before the publish it reports on.
    const report = nodes.find((node) => node.id === "capture_report")!;
    expect(report.dependsOn).toContain("capture_publish");
    expect(nodes[nodes.length - 1].id).toBe("capture_report");
  });

  it("refuses when the project has publishing switched off", async () => {
    await expect(
      capturePublishStep(
        { targetProjectId: "zilberman", emission: liveEmission() },
        { projectRepository: projectRepository({ publishingPolicy: { publishEnabled: false, requiresExplicitPublish: false, operatorDefault: "approved" } }) }
      )
    ).rejects.toMatchObject({ code: "capture_publish_disabled" });
  });

  it("refuses to publish off a DRY emission — nothing was written, so there is nothing live to ship", async () => {
    const dry = { ...liveEmission(), live: false };
    await expect(
      capturePublishStep({ targetProjectId: "zilberman", emission: dry }, { projectRepository: projectRepository() })
    ).rejects.toMatchObject({ code: "capture_publish_emission_not_live" });
  });

  it("refuses when there is no emission report at all, rather than publishing whatever the site holds", async () => {
    await expect(
      capturePublishStep({ targetProjectId: "zilberman", emission: { live: true } }, { projectRepository: projectRepository() })
    ).rejects.toMatchObject({ code: "capture_publish_emission_missing" });
    await expect(
      capturePublishStep({ targetProjectId: "zilberman", emission: undefined }, { projectRepository: projectRepository() })
    ).rejects.toBeInstanceOf(CaptureRefusal);
  });

  it("keeps the BUILD verbs unreachable while permitting the two publish verbs", async () => {
    const transport = __test__.buildPublishTransport("zilberman", {} as never);
    // The two that would put capture in charge of a deploy are refused BEFORE any transport, so no
    // network call is attempted at all.
    await expect(transport.call("trigger_netlify_build", {})).rejects.toThrow(/Forbidden publish verb: trigger_netlify_build/);
    await expect(transport.call("deploy", {})).rejects.toThrow(/Forbidden publish verb: deploy/);
    // The two this stage exists to use are not in the ban set, so they reach the project adapter.
    // (Membership is the assertion here; actually calling them would need a live target.)
    expect(PUBLISH_FORBIDDEN_VERBS.has("object_publish")).toBe(false);
    expect(PUBLISH_FORBIDDEN_VERBS.has("release_to_production")).toBe(false);
  });

  it("the EMITTER's transport still bans both publish verbs — publishing may not happen mid-emission", async () => {
    const transport = __test__.buildAdapterTransport(
      "zilberman",
      new Set(["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]),
      {} as never
    );
    for (const verb of ["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]) {
      await expect(transport.call(verb, {})).rejects.toThrow(/Forbidden emission verb/);
    }
  });
});
