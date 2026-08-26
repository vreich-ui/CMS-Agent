import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";
import { describeOperatorDecisionSource, resolvePublishAuthority } from "../../../src/agent/workspace/publishDecision.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
// Side-effect imports: capture_conductor and clone_conductor register themselves. Without these the
// loop below would silently shrink to publishing_conductor and prove nothing about the other two —
// which is precisely the class of gap this file exists to close.
import "../../../src/agent/workspace/captureConductorWorkflow.js";
import "../../../src/agent/workspace/cloneConductorWorkflow.js";

// T4 (2026-08-26) — "the project's publishing policy must reach EVERY registered workflow, not just
// capture."
//
// WHAT THE HANDOFF REPORTED, AND WHAT IS ACTUALLY TRUE. The report was that project zilberman
// declares `publishingPolicy.operatorDefault: "approved"`, that capture_conductor runs pick it up as
// `operatorPublishDecision: "approved" / operatorDecisionSource: "project_policy_default"`, and that
// clone_conductor runs start at null and need a manual set_operator_publish_decision. The asymmetry
// was real; the mechanism named for it no longer exists. `publishingPolicy.operatorDefault` was
// REMOVED at T15.5 (ADR-2026-08-25-publish-autonomy §2.2), deliberately and with the defect stated:
// applyOperatorPublishPolicyDefault stamped run.operatorPublishDecision from a project default, so a
// receipt could claim a human decided when no human had. ADR invariant 4 is now that NOTHING but
// workflow.set_operator_publish_decision ever writes that field, in any mode. "project_policy_default"
// survives only as a legacy literal for runs persisted before T15.5 — which is what those capture
// runs were.
//
// The replacement is `publishingPolicy.autonomyMode`, snapshotted onto the run at CREATION by
// executor.capturePublishingPolicySnapshot — which is already workflow-agnostic: it runs inside
// startDryRun for every workflow, keyed on nothing but the run's projectId. So T4's goal is met by
// construction rather than by a new branch, and the honest fix for zilberman is a project-policy edit
// (autonomyMode: "autonomous") owned by the config lane, not a code change here.
//
// WHAT THIS FILE THEREFORE IS. Not a fix — a LOCK. It asserts T4's three acceptance criteria across
// `listRegisteredWorkflowIds()` rather than against one named workflow, so registering a fourth
// workflow that does not inherit the project's autonomy resolution fails here instead of on a live
// run. That is the property "same project, same policy, different result depending on workflow" was
// the symptom of, and nothing in the suite asserted it workflow-wide before.

const projectIdFor = (workflowId: string) => `autonomy-reach-${workflowId.replace(/_/g, "-")}`;

const makeProject = async (projectId: string, autonomyMode?: "autonomous" | "operator-gated") => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId,
      name: `Autonomy reach fixture ${projectId}`,
      mcpEndpointEnvVar: "AUTONOMY_REACH_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed"
    })
  );
  if (autonomyMode) await updateProject(repositoryManager.getProjectRepository(), projectId, projectUpdateSchema.parse({ autonomyMode }));
};

const startRun = async (workflowId: string, projectId: string) => {
  const store = repositoryManager.getExecutionRepository();
  const started = await startDryRun({ projectId, workflowId, executionMode: "mock", input: { targetProjectId: projectId, note: "autonomy reach fixture" } }, store);
  return { runId: started.runId, store };
};

describe("project publishing policy reaches every registered workflow", () => {
  beforeEach(() => { resetRepositoryManager(); });
  afterEach(() => { resetRepositoryManager(); });

  it("registers more than one workflow — otherwise the loops below prove nothing", () => {
    const ids = listRegisteredWorkflowIds();
    expect(ids).toContain("publishing_conductor");
    expect(ids).toContain("capture_conductor");
    expect(ids).toContain("clone_conductor");
  });

  it("an autonomous project authorizes a fresh run of EVERY workflow with no operator call at all", async () => {
    for (const workflowId of listRegisteredWorkflowIds()) {
      const projectId = projectIdFor(workflowId);
      await makeProject(projectId, "autonomous");
      const { runId, store } = await startRun(workflowId, projectId);
      const run = (await getRun(runId, store))!;

      expect(run.workflowId, workflowId).toBe(workflowId);
      expect(run.publishingPolicySnapshot?.autonomyMode, workflowId).toBe("autonomous");
      // ADR invariant 4: autonomy authorizes, it never fabricates an operator record.
      expect(run.operatorPublishDecision, workflowId).toBeUndefined();
      expect(run.operatorDecisionSource, workflowId).toBeUndefined();

      const authority = resolvePublishAuthority(run);
      expect(authority.authorized, workflowId).toBe(true);
      expect(authority.authorized && authority.source, workflowId).toBe("policy_autonomous");
    }
  });

  it("an explicit withheld still vetoes every workflow, and still reports source explicit", async () => {
    for (const workflowId of listRegisteredWorkflowIds()) {
      const projectId = projectIdFor(workflowId);
      await makeProject(projectId, "autonomous");
      const { runId, store } = await startRun(workflowId, projectId);
      await setOperatorPublishDecision(runId, "withheld", store);
      const run = (await getRun(runId, store))!;

      expect(run.operatorPublishDecision, workflowId).toBe("withheld");
      expect(run.operatorDecisionSource, workflowId).toBe("explicit");
      expect(describeOperatorDecisionSource(run), workflowId).toContain("explicit");

      const authority = resolvePublishAuthority(run);
      expect(authority.authorized, workflowId).toBe(false);
      expect(!authority.authorized && authority.code, workflowId).toBe("operator_withheld");
    }
  });

  it("an explicit approved authorizes every workflow even on a gated project, and reports source explicit", async () => {
    for (const workflowId of listRegisteredWorkflowIds()) {
      const projectId = projectIdFor(workflowId);
      await makeProject(projectId);
      const { runId, store } = await startRun(workflowId, projectId);
      await setOperatorPublishDecision(runId, "approved", store);
      const run = (await getRun(runId, store))!;

      expect(run.operatorDecisionSource, workflowId).toBe("explicit");
      const authority = resolvePublishAuthority(run);
      expect(authority.authorized, workflowId).toBe(true);
      expect(authority.authorized && authority.source, workflowId).toBe("operator_explicit");
    }
  });

  it("a project with no autonomyMode still gates every workflow, and still records no operator decision", async () => {
    for (const workflowId of listRegisteredWorkflowIds()) {
      const projectId = projectIdFor(workflowId);
      await makeProject(projectId);
      const { runId, store } = await startRun(workflowId, projectId);
      const run = (await getRun(runId, store))!;

      expect(run.publishingPolicySnapshot?.autonomyMode, workflowId).toBe("operator-gated");
      expect(run.operatorPublishDecision, workflowId).toBeUndefined();

      const authority = resolvePublishAuthority(run);
      expect(authority.authorized, workflowId).toBe(false);
      expect(!authority.authorized && authority.code, workflowId).toBe("operator_approval_absent");
    }
  });
});
