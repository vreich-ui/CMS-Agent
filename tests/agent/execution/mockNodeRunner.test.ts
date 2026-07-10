import { describe, expect, it } from "vitest";
import { MockNodeRunner } from "../../../src/agent/execution/runners/MockNodeRunner.js";

describe("MockNodeRunner", () => {
  it("remains functional", async () => {
    const runner = new MockNodeRunner();
    const result = await runner.run({ node: { id:"n", name:"N", kind:"test", description:"", prompt:"", inputSchema:{}, outputSchema:{}, allowedTools:[], requiredInputs:[], produces:["x"], riskLevel:"read", dependsOn:[], status:"active", position:{x:0,y:0}, updatedAt:new Date().toISOString() }, input: {} }, { run: { runId:"r", workflowId:"w", projectId:"p", status:"running", startedAt:"", updatedAt:"", nodes:[], artifacts:[], errors:[], approvalsRequired:[], stageOutputs:{}, dryRun:true }, executionRepository: {} as any });
    expect(result.ok).toBe(true);
  });
});
