import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { __test__, resetRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { findCanonicalNodeById, resolveNodeForExecution } from "../../../src/agent/workspace/nodeResolution.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { listVisualIdentityNodes } from "../../../src/agent/workspace/visualIdentityNodes.js";
import { CAPTURE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/captureConductorWorkflow.js";
import { CLONE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/cloneConductorWorkflow.js";
import { VISUAL_IDENTITY_WORKFLOW_ID } from "../../../src/agent/workspace/visualIdentityWorkflow.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// R1b — closes the defect verified against executor.ts:381: a run stamped with a workflowId nobody
// registered used to resolve, silently, to the FULL publishing_conductor node array — publish/release
// tail included — regardless of what the caller actually named. Real reachability: platform's
// run_workspace_workflow passes args.workflow_id straight through to workflow_start_dry_run with no
// catalog check of its own (platform commit 71789f4f, left unfixed there), so a chat request naming an
// unknown workflow id could start a publishing-path run on a live tenant.
//
// Uses a private RepositoryManager (real CAS-respecting in-memory repositories — MemoryExecutionRepository's
// createRun/saveRun, not a Map fake) per test so "no run record created" and "a persisted run" are
// checked against the SAME repository the assertions read back from, isolated from every other test file.

describe("R1b — unregistered explicit workflowId is refused, not silently substituted", () => {
  let repos: RepositoryManager;
  beforeEach(() => { repos = new RepositoryManager(); });

  const store = () => repos.getExecutionRepository();
  const workspace = () => repos.getWorkspaceRepository();
  const projects = () => repos.getProjectRepository();

  // 1. Refused at the boundary, before a run record exists.
  it("starting a run with an unregistered explicit workflowId is refused, names the registered ids, and creates no run record", async () => {
    await expect(
      startDryRun({ projectId: "project-a", input: {}, executionMode: "mock", workflowId: "money_page_v2" }, store(), workspace(), projects())
    ).rejects.toMatchObject({
      name: "WorkspaceToolError",
      code: "unknown_workflow",
      message: expect.stringContaining("money_page_v2"),
      details: expect.objectContaining({ requestedWorkflowId: "money_page_v2", registeredWorkflowIds: listRegisteredWorkflowIds() })
    });
    // The registered ids named in the refusal are real, current ones — not a stale/guessed list.
    expect(listRegisteredWorkflowIds()).toEqual(["publishing_conductor", "capture_conductor", "clone_conductor", "visual_identity", "pdf_template_studio", "image_template_revision_studio"]);

    // THE PART THAT MATTERS: no run record exists to clean up, retry, or accidentally resume.
    const { runs } = await store().listRunsPage({});
    expect(runs).toEqual([]);
  });

  // 2. Every registered non-publishing workflow is completely unaffected: it still starts and
  // resolves exactly its own canonical node set — this change narrows the unknown-id path, it does
  // not touch resolution for a real, registered id.
  it.each([
    [CAPTURE_CONDUCTOR_WORKFLOW_ID, listCaptureConductorNodes],
    [CLONE_CONDUCTOR_WORKFLOW_ID, listCloneConductorNodes],
    [VISUAL_IDENTITY_WORKFLOW_ID, listVisualIdentityNodes]
  ] as const)("%s still starts and resolves its own nodes unchanged", async (workflowId, canonicalNodes) => {
    const run = await startDryRun({ projectId: "project-a", input: {}, executionMode: "mock", workflowId }, store(), workspace(), projects());
    expect(run.workflowId).toBe(workflowId);
    expect(run.nodes.map((node) => node.nodeId).sort()).toEqual(canonicalNodes().map((node) => node.id).sort());
    // publishing_conductor's own AUTHORING nodes (unique to it) never leak into a non-publishing run.
    expect(run.nodes.some((node) => node.nodeId === "contract_intelligence")).toBe(false);
  });

  // 3. The legacy adapter still works: a genuinely ABSENT workflowId (never supplied) resolves to
  // publishing_conductor, byte-identical to every run before the registry existed.
  it("a legacy run with an absent workflowId still resolves to publishing_conductor", async () => {
    const run = await startDryRun({ projectId: "project-a", input: {}, executionMode: "mock" }, store(), workspace(), projects());
    expect(run.workflowId).toBe("publishing_conductor");
    expect(run.nodes.map((node) => node.nodeId).sort()).toEqual(listWorkspaceNodes().map((node) => node.id).sort());
  });

  // 4 & 5. Defense in depth for a run PERSISTED before this change: it can carry a full
  // publishing_conductor node array (the OLD, unsafe resolveConductorNodes' actual output) stamped
  // with an unregistered workflowId. Advancing it must refuse rather than dispatch through that
  // node array — including its publish_executor/release_executor tail — and node.execute's own
  // resolution path (which reads run.workflowId directly, bypassing resolveConductorNodes entirely)
  // must independently refuse to hand back those nodes' canonical definitions too.
  describe("a run persisted before this change, carrying an unregistered workflowId and the old (unsafe) full publishing node array", () => {
    const BOGUS_WORKFLOW_ID = "pre_r1b_legacy_stamp";

    const persistLegacyRun = async (): Promise<WorkflowExecutionRecord> => {
      const built = __test__.buildInitialRun(
        { projectId: "project-a", input: {}, executionMode: "mock", workflowId: BOGUS_WORKFLOW_ID },
        listWorkspaceNodes() // exactly what the pre-fix executor.ts:381 fallback would have handed this run
      );
      return store().createRun(built);
    };

    it("does not execute publishing nodes: advancing the run refuses instead of dispatching its (stale, full-publishing) node array", async () => {
      const persisted = await persistLegacyRun();
      expect(persisted.nodes[0]?.status).toBe("queued"); // nothing dispatched yet — the premise

      await expect(runNextNode(persisted.runId, { executionRepository: store(), workspaceRepository: workspace() })).rejects.toMatchObject({
        name: "WorkspaceToolError",
        code: "unknown_workflow",
        details: expect.objectContaining({ requestedWorkflowId: BOGUS_WORKFLOW_ID })
      });
      // The run is untouched: still queued, nothing dispatched, nothing published.
      const reread = await store().getRun(persisted.runId);
      expect(reread!.status).toBe("queued");
      expect(reread!.nodes.every((node) => node.status === "queued")).toBe(true);

      // resetRun reads the same resolveConductorNodes path and refuses identically.
      await expect(resetRun(persisted.runId, store())).rejects.toMatchObject({ code: "unknown_workflow" });
    });

    it("publish/release tail nodes are not reachable through the unknown-id path (nodeResolution.ts, single-node lookup)", async () => {
      await persistLegacyRun();
      // The exact call node.execute / toolResolver.ts make for a single node, given the RUN's own
      // (unregistered) workflowId — bypassing resolveConductorNodes entirely.
      expect(findCanonicalNodeById("publish_executor", BOGUS_WORKFLOW_ID)).toBeUndefined();
      expect(findCanonicalNodeById("release_executor", BOGUS_WORKFLOW_ID)).toBeUndefined();
      // resolveNodeForExecution checks the STORE first (by design — "store first, canonical second";
      // a governance-visible store row wins for ANY id, regardless of a run's workflowId, which is
      // correct and unrelated to this defect). An EMPTY store isolates the canonical-resolution path
      // this fix actually changes — the SAME store shape captureNodeResolution.test.ts uses for the
      // identical reason.
      const emptyStore = { getNode: async () => undefined } as unknown as WorkspaceRepository;
      expect(await resolveNodeForExecution("publish_executor", emptyStore, BOGUS_WORKFLOW_ID)).toBeUndefined();
      expect(await resolveNodeForExecution("release_executor", emptyStore, BOGUS_WORKFLOW_ID)).toBeUndefined();
      // Contrast: the identical lookup for a REGISTERED workflow still resolves the shared tail node —
      // this is a refusal of the unknown id, not a break of the shared-tail mechanism itself.
      expect(findCanonicalNodeById("publish_executor", "publishing_conductor")?.id).toBe("publish_executor");
      expect(findCanonicalNodeById("publish_executor", CAPTURE_CONDUCTOR_WORKFLOW_ID)?.id).toBe("publish_executor");
    });
  });
});
