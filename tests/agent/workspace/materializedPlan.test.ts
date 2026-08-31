import { describe, expect, it } from "vitest";
import { MATERIALIZED_PLAN_NODE_IDS, firstMaterializedPlanValue, materializedPlanOf } from "../../../src/agent/workspace/materializedPlan.js";
import { buildRunContext } from "../../../src/agent/workspace/runContext.js";
import { readContentItemShell } from "../../../src/agent/workspace/contentItemShell.js";
import { artifactPlanVerifiedMediaRefsOf } from "../../../src/agent/projects/readinessContentChecks.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W8.3 — the binding the W8 plan assumed was untouched. `artifact_plan.v1` keeps its shape, but three
// readers keyed on the NODE ID that produced it, and that id moved to artifact_materializer. This file
// pins the preference order and, more importantly, the FALLBACK: a run recorded before the split, and a
// late-stage entrypoint run that seeds artifact_plan's output directly, must keep working unchanged.

const planEnvelope = (requestId: string) => ({
  artifact: "artifact_plan.v1",
  summary: "one slot",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  artifactProtocol: "agent_artifact_jobs",
  requestId,
  media_slots: [{ slotId: "hero", purpose: "hero image", status: "has_trusted_artifact", publicPath: `/img/${requestId}/hero.webp`, artifactReference: { blobKey: `image/${requestId}/hero.webp` } }],
  artifactReferences: [{ slotId: "hero", verified: true, publicPath: `/img/${requestId}/hero.webp`, artifactReference: { blobKey: `image/${requestId}/hero.webp` } }]
});

const shellState = (nodeId: string, objectId: string) => ({ nodeId, input: { contentItemShell: { objectId, created: true, objectType: "content_item", requestId: objectId } } });

describe("materializedPlan — which node holds the run's artifact_plan.v1", () => {
  it("prefers the materializer and falls back to the planner, never merging the two", () => {
    expect([...MATERIALIZED_PLAN_NODE_IDS]).toEqual(["artifact_materializer", "artifact_plan"]);

    const fresh = planEnvelope("req_new_20260831_01");
    const legacy = planEnvelope("req_old_20260812_01");
    expect(materializedPlanOf({ artifact_materializer: fresh, artifact_plan: legacy })).toBe(fresh);
    expect(materializedPlanOf({ artifact_plan: legacy })).toBe(legacy);
    expect(materializedPlanOf({})).toBeUndefined();
    expect(materializedPlanOf(undefined)).toBeUndefined();
    // A non-object under the preferred id is not a plan, so the search continues rather than
    // returning something no node asserted.
    expect(materializedPlanOf({ artifact_materializer: "skipped", artifact_plan: legacy })).toBe(legacy);
  });

  it("carries the publish request id from whichever node authored the plan", () => {
    expect(buildRunContext({ clientProjectId: "dr-lurie", stageOutputs: { artifact_materializer: planEnvelope("req_new_20260831_01") } }).requestId).toBe("req_new_20260831_01");
    // The late-stage entrypoint / pre-W8 run: still lifted, unchanged.
    expect(buildRunContext({ clientProjectId: "dr-lurie", stageOutputs: { artifact_plan: planEnvelope("req_old_20260812_01") } }).requestId).toBe("req_old_20260812_01");
    // The materializer wins when both exist.
    expect(buildRunContext({ clientProjectId: "dr-lurie", stageOutputs: { artifact_materializer: planEnvelope("req_new_20260831_01"), artifact_plan: planEnvelope("req_old_20260812_01") } }).requestId).toBe("req_new_20260831_01");
  });

  it("finds the W6 media evidence under either id", () => {
    expect(artifactPlanVerifiedMediaRefsOf({ artifact_materializer: planEnvelope("req_new_20260831_01") })).toContain("/img/req_new_20260831_01/hero.webp");
    expect(artifactPlanVerifiedMediaRefsOf({ artifact_plan: planEnvelope("req_old_20260812_01") })).toContain("/img/req_old_20260812_01/hero.webp");
    expect(artifactPlanVerifiedMediaRefsOf({})).toEqual([]);
  });

  it("finds the content-item shell under either id, and keeps searching when the preferred node carries none", () => {
    const withMaterializer = { nodes: [shellState("artifact_materializer", "req_new_20260831_01")] } as unknown as WorkflowExecutionRecord;
    expect(readContentItemShell(withMaterializer)?.objectId).toBe("req_new_20260831_01");

    const legacyOnly = { nodes: [shellState("artifact_plan", "req_old_20260812_01")] } as unknown as WorkflowExecutionRecord;
    expect(readContentItemShell(legacyOnly)?.objectId).toBe("req_old_20260812_01");

    // The case a plain "find the node state, then read it" would get wrong: the materializer ran but
    // its shell create failed (a warning, not an error), and the planner's state still holds one.
    const materializerWithoutShell = {
      nodes: [{ nodeId: "artifact_materializer", input: {} }, shellState("artifact_plan", "req_old_20260812_01")]
    } as unknown as WorkflowExecutionRecord;
    expect(readContentItemShell(materializerWithoutShell)?.objectId).toBe("req_old_20260812_01");

    expect(readContentItemShell({ nodes: [] } as unknown as WorkflowExecutionRecord)).toBeUndefined();
  });

  it("firstMaterializedPlanValue short-circuits on the first defined value", () => {
    const seen: string[] = [];
    const value = firstMaterializedPlanValue((nodeId) => {
      seen.push(nodeId);
      return nodeId === "artifact_materializer" ? "hit" : undefined;
    });
    expect(value).toBe("hit");
    expect(seen).toEqual(["artifact_materializer"]);
  });
});
