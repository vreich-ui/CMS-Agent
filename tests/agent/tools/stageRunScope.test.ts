import { beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../../../src/agent/tools/toolExecutor.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// T1 (wave1-scoping-policy-hygiene): reproduces the live leak in run_1786557897658_elj34j
// (2026-08-12) — publish_executor called stage.get_output and got back publication_controller's
// output belonging to a DIFFERENT run, run_1786468126136. "external_test" is not a real workspace
// node (no node.allowedTools gate applies), and maxRiskLevel:"write" plus runAuthorizedTools clears
// the remaining policy checks, isolating the stage.* handlers' OWN cross-run refusal from node-level
// policy — the same isolation toolRuntime.test.ts and projectReadTool.test.ts use.
const RUN_A = "run_1786557897658_elj34j";
const RUN_B = "run_1786468126136";
const authorizedTools = ["stage.get_output", "stage.list_outputs", "stage.save_output"];
const ctxFor = (runId: string) => ({ runId, nodeId: "external_test", maxRiskLevel: "write" as const, runAuthorizedTools: authorizedTools });

describe("stage.* tools are run-scoped", () => {
  beforeEach(() => resetRepositoryManager());

  it("refuses a cross-run stage.get_output read, naming both run ids", async () => {
    // publication_controller in run B saves its output under the id the real executor assigns:
    // `${run.runId}:${nodeId}` (executor.ts).
    const targetId = `${RUN_B}:publication_controller`;
    const saved = await executeTool("stage.save_output", { id: targetId, stage: "publication_controller", value: { decision: "publish" } }, ctxFor(RUN_B));
    expect(saved.ok).toBe(true);

    // publish_executor in run A asks for that same id — this is exactly the live defect.
    const leaked = await executeTool("stage.get_output", { id: targetId }, ctxFor(RUN_A));

    expect(leaked.ok).toBe(false);
    const message = (leaked as any).error.message as string;
    expect(message).toContain("stage_cross_run_read_refused");
    expect(message).toContain(RUN_A);
    expect(message).toContain(RUN_B);
  });

  it("still allows a same-run stage.get_output read", async () => {
    const targetId = `${RUN_A}:publication_controller`;
    await executeTool("stage.save_output", { id: targetId, stage: "publication_controller", value: { decision: "publish" } }, ctxFor(RUN_A));

    const result = await executeTool("stage.get_output", { id: targetId }, ctxFor(RUN_A));

    expect(result.ok).toBe(true);
    expect((result as any).output.data.output).toMatchObject({ id: targetId, stage: "publication_controller" });
  });

  it("still allows an unscoped id (no run prefix) from any run", async () => {
    const saved = await executeTool("stage.save_output", { stage: "shared_lookup", value: { any: true } }, ctxFor(RUN_B));
    expect(saved.ok).toBe(true);
    const unscopedId = (saved as any).output.data.output.id as string;
    expect(unscopedId).not.toMatch(/^run_/);

    const result = await executeTool("stage.get_output", { id: unscopedId }, ctxFor(RUN_A));

    expect(result.ok).toBe(true);
    expect((result as any).output.data.output).toMatchObject({ id: unscopedId, stage: "shared_lookup" });
  });

  it("refuses stage.save_output when the caller supplies an explicit id owned by a different run", async () => {
    const targetId = `${RUN_B}:publication_controller`;
    await executeTool("stage.save_output", { id: targetId, stage: "publication_controller", value: { decision: "publish" } }, ctxFor(RUN_B));
    const clobber = await executeTool("stage.save_output", { id: targetId, stage: "publication_controller", value: { decision: "tampered" } }, ctxFor(RUN_A));

    expect(clobber.ok).toBe(false);
    const message = (clobber as any).error.message as string;
    expect(message).toContain("stage_cross_run_read_refused");
    expect(message).toContain(RUN_A);
    expect(message).toContain(RUN_B);
  });

  it("stage.save_output with no id is unaffected by run scoping", async () => {
    const result = await executeTool("stage.save_output", { stage: "draft", value: { text: "hello" } }, ctxFor(RUN_A));
    expect(result.ok).toBe(true);
  });

  it("stage.list_outputs filters out a foreign run's output when runId context is present", async () => {
    await executeTool("stage.save_output", { id: `${RUN_A}:publication_controller`, stage: "publication_controller", value: { mine: true } }, ctxFor(RUN_A));
    await executeTool("stage.save_output", { id: `${RUN_B}:publication_controller`, stage: "publication_controller", value: { theirs: true } }, ctxFor(RUN_B));
    await executeTool("stage.save_output", { stage: "publication_controller", value: { unscoped: true } }, ctxFor(RUN_B));

    const listed = await executeTool("stage.list_outputs", { stage: "publication_controller" }, ctxFor(RUN_A));

    expect(listed.ok).toBe(true);
    const ids = ((listed as any).output.data.outputs as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(`${RUN_A}:publication_controller`);
    expect(ids).not.toContain(`${RUN_B}:publication_controller`);
    expect(ids.some((outputId) => !outputId.startsWith(RUN_B))).toBe(true);
  });

  it("stage.list_outputs returns everything, including other runs' outputs, when no runId context is present", async () => {
    await executeTool("stage.save_output", { id: `${RUN_A}:publication_controller`, stage: "publication_controller", value: { mine: true } }, ctxFor(RUN_A));
    await executeTool("stage.save_output", { id: `${RUN_B}:publication_controller`, stage: "publication_controller", value: { theirs: true } }, ctxFor(RUN_B));

    // Direct MCP admin call shape: no runId in context at all.
    const listed = await executeTool("stage.list_outputs", { stage: "publication_controller" }, { runId: "", nodeId: "external_test", maxRiskLevel: "write", runAuthorizedTools: authorizedTools });

    expect(listed.ok).toBe(true);
    const ids = ((listed as any).output.data.outputs as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(`${RUN_A}:publication_controller`);
    expect(ids).toContain(`${RUN_B}:publication_controller`);
  });
});
