// Pure parsing/planning/refusal logic for scripts/applyNodeOps.ts, exercised against the real
// ops doc (a parsing-contract test) plus synthetic node fixtures (planning/erosion/drift tests) — no
// live repository, no process spawn. main() is guarded behind an isDirectRun check (mirroring
// scripts/reseedStoreFromCanonical.ts and scripts/seedNodesFromWorkspace.ts) so importing this module
// never touches the store or calls process.exit.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOpsDoc, planApply, type ParsedOp } from "../../../scripts/applyNodeOps.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const OPS_DOC_PATH = fileURLToPath(new URL("../../../docs/plan/brand-imagery-node-ops.md", import.meta.url));

const makeNode = (partial: Partial<WorkspaceNode> & { id: string }): WorkspaceNode => ({
  name: partial.id,
  kind: "test",
  description: "a test node",
  prompt: "base prompt text",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  allowedTools: [],
  assignedSkills: [],
  requiredInputs: [],
  produces: [],
  riskLevel: "read",
  dependsOn: [],
  status: "active",
  position: { x: 0, y: 0 },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...partial
});

describe("parseOpsDoc — the real brand-imagery-node-ops.md", () => {
  it("parses exactly 13 ops, in order, with the tools/nodes the doc's own op table names", async () => {
    const markdown = await readFile(OPS_DOC_PATH, "utf8");
    const ops = parseOpsDoc(markdown);
    expect(ops).toHaveLength(13);
    expect(ops.map((op) => op.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(ops.map((op) => op.tool)).toEqual([
      "workspace_update_node_input_schema",
      "workspace_update_node_output_schema",
      "workspace_update_node_prompt",
      "workspace_update_node_output_schema",
      "workspace_update_node_output_schema",
      "workspace_update_node_prompt",
      "workspace_update_node_metadata",
      "workspace_create_node",
      "workspace_create_node",
      "workspace_update_node_prompt",
      "workspace_update_node_prompt",
      "workspace_update_node_prompt",
      "workspace_update_node_output_schema"
    ]);
    expect(ops.map((op) => op.nodeId)).toEqual([
      "brief_architect",
      "brief_architect",
      "brief_architect",
      "contract_intelligence",
      "artifact_plan",
      "artifact_plan",
      "artifact_plan",
      "brand_imagery_writer",
      "visual_standard_materializer",
      "brand_imagery_writer",
      "brief_architect",
      "brand_imagery_writer",
      "contract_intelligence"
    ]);
  });

  it("picks the LAST fenced block in a section that prints an illustrative diff before the real payload (ops 11 and 12)", async () => {
    const markdown = await readFile(OPS_DOC_PATH, "utf8");
    const ops = parseOpsDoc(markdown);
    const op11 = ops.find((op) => op.index === 11)!;
    const op12 = ops.find((op) => op.index === 12)!;
    // The doc's own char counts for these ops (4,821 -> 5,706 and 8,393 -> 9,553) prove the FULL
    // replacement was picked, not the one-line diff snippet each section prints first.
    expect(op12.prompt!.length).toBeGreaterThan(9000);
    expect(op11.prompt!.length).toBeGreaterThan(5000);
    // And each full prompt actually contains the whole rest of the node's prompt, not just the
    // inserted sentence — a diff-only block would fail this.
    expect(op11.prompt).toContain("Objective: Convert upstream strategy and evidence");
    expect(op12.prompt).toContain("Objective: read a mood board");
  });

  it("op 8/9 create_node payloads unwrap the {\"node\": {...}} wrapper the doc says to send as-is", async () => {
    const markdown = await readFile(OPS_DOC_PATH, "utf8");
    const ops = parseOpsDoc(markdown);
    const op8 = ops.find((op) => op.index === 8)!;
    expect(op8.node?.id).toBe("brand_imagery_writer");
    expect(op8.node?.riskLevel).toBe("read");
  });
});

describe("planApply — idempotence and ordering", () => {
  it("plans a create then a prompt update for a fresh store", () => {
    const ops: ParsedOp[] = [
      { index: 1, tool: "workspace_create_node", nodeId: "n1", kind: "create_node", node: makeNode({ id: "n1", prompt: "short base" }) },
      { index: 2, tool: "workspace_update_node_prompt", nodeId: "n1", kind: "prompt", prompt: "short base with one clause added" }
    ];
    const plan = planApply(ops, []);
    expect(plan.refusals).toEqual([]);
    expect(plan.writes.map((w) => w.opIndex)).toEqual([1, 2]);
    expect(plan.writes[0].kind).toBe("create");
    expect(plan.writes[1].basis).toBe("chain_match"); // op 2 chains off op 1's create, per the doc's own op 8 -> 10 -> 12 shape
  });

  it("a second run against an already-applied store reports zero writes and zero refusals", () => {
    const ops: ParsedOp[] = [
      { index: 1, tool: "workspace_update_node_prompt", nodeId: "n1", kind: "prompt", prompt: "base prompt text plus one additive clause" }
    ];
    const applied = [makeNode({ id: "n1", prompt: "base prompt text plus one additive clause" })];
    const plan = planApply(ops, applied);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.upToDate).toEqual([{ opIndex: 1, nodeId: "n1", field: "prompt" }]);
  });

  it("running the full doc's ops (create -> update -> update on the same field) twice is a no-op the second time", () => {
    const ops: ParsedOp[] = [
      { index: 8, tool: "workspace_create_node", nodeId: "n1", kind: "create_node", node: makeNode({ id: "n1", prompt: "created prompt" }) },
      { index: 10, tool: "workspace_update_node_prompt", nodeId: "n1", kind: "prompt", prompt: "created prompt plus op 10's addition" },
      { index: 12, tool: "workspace_update_node_prompt", nodeId: "n1", kind: "prompt", prompt: "created prompt plus op 10's addition plus op 12's addition" }
    ];
    const firstRun = planApply(ops, []);
    expect(firstRun.refusals).toEqual([]);
    expect(firstRun.writes).toHaveLength(3);
    // Simulate the store after firstRun's writes landed.
    const afterFirstRun = [makeNode({ id: "n1", prompt: "created prompt plus op 10's addition plus op 12's addition" })];
    const secondRun = planApply(ops, afterFirstRun);
    expect(secondRun.writes).toEqual([]);
    expect(secondRun.refusals).toEqual([]);
    expect(secondRun.upToDate.map((u) => u.opIndex)).toEqual([8, 10, 12]);
  });
});

describe("planApply — erosion guard (reused from reseedStoreFromCanonical.ts's exported constants)", () => {
  it("refuses a prompt op that would shrink a prompt past the shared ceiling, naming the node and field", () => {
    const longBase = "x".repeat(1000);
    const shrunk = "x".repeat(100); // -90%, well past MAX_PROMPT_SHRINK (0.4)
    const ops: ParsedOp[] = [
      { index: 1, tool: "workspace_update_node_prompt", nodeId: "brief_architect", kind: "prompt", prompt: shrunk }
    ];
    const plan = planApply(ops, [makeNode({ id: "brief_architect", prompt: longBase })]);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].nodeId).toBe("brief_architect");
    expect(plan.refusals[0].field).toBe("prompt");
    expect(plan.refusals[0].reason).toMatch(/shrink/);
  });

  it("--allow-prompt-shrink lifts the refusal", () => {
    const longBase = "x".repeat(1000);
    const shrunk = "x".repeat(100);
    const ops: ParsedOp[] = [
      { index: 1, tool: "workspace_update_node_prompt", nodeId: "brief_architect", kind: "prompt", prompt: shrunk }
    ];
    const plan = planApply(ops, [makeNode({ id: "brief_architect", prompt: longBase })], { allowPromptShrink: true });
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
  });

  it("refuses a metadata op that would drop a metadata KEY the store carries (update_node_metadata replaces, it does not merge)", () => {
    // The concrete hazard: a doc op that names only the key it is adding, landing on a node whose
    // store row carries the conductor's prefetch declarations. Without this guard both are stripped
    // and the conductor silently stops prefetching for that node.
    const ops: ParsedOp[] = [
      { index: 7, tool: "workspace_update_node_metadata", nodeId: "brand_imagery_writer", kind: "metadata", metadataPatch: { contractPrefetch: true } }
    ];
    const store = [makeNode({ id: "brand_imagery_writer", metadata: { sitePrefetch: true, voicePrefetch: true } })];
    const plan = planApply(ops, store);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toContain("sitePrefetch");
    expect(plan.refusals[0].reason).toContain("voicePrefetch");

    // --allow-capability-loss (the sibling script's own flag) is what lifts it — and the prompt-shrink
    // flag deliberately does NOT: confirming a prompt cut must not also confirm a metadata deletion.
    expect(planApply(ops, store, { allowPromptShrink: true }).refusals).toHaveLength(1);
    const confirmed = planApply(ops, store, { allowCapabilityLoss: true });
    expect(confirmed.refusals).toEqual([]);
    expect(confirmed.writes).toHaveLength(1);
  });

  it("refuses a metadata op that would drop a canonicalRules entry", () => {
    const ops: ParsedOp[] = [
      { index: 7, tool: "workspace_update_node_metadata", nodeId: "artifact_plan", kind: "metadata", metadataPatch: { canonicalRules: ["rule A", "rule C"] } }
    ];
    const plan = planApply(ops, [makeNode({ id: "artifact_plan", metadata: { canonicalRules: ["rule A", "rule B", "rule C"] } })]);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/canonicalRule/);
    expect(plan.refusals[0].reason).toContain("rule B");
  });
});

describe("planApply — drift refusal (current stored state doesn't match what the doc expects as its base)", () => {
  it("refuses a chained op (op-11-off-op-3 shape) when the store holds a third value that is neither op's payload, because the predecessor op itself was refused this run", () => {
    // A store that has been edited by something outside this doc to unrelated, much longer content.
    // Applying op 3's (much shorter, purely additive) payload over it would itself be a huge shrink,
    // so op 3 refuses via the erosion guard — leaving the store genuinely unresolved for op 11, which
    // must then refuse too rather than silently accepting whatever is sitting there as a valid base.
    const driftedValue = "unrelated ".repeat(200); // 2000 chars of content nothing in this doc wrote
    const op3Payload = "Objective: do the thing. Policy: be careful and additionally check twice.";
    const op11Payload = "Objective: do the thing. Policy: be careful and additionally check twice and also log it.";
    const ops: ParsedOp[] = [
      { index: 3, tool: "workspace_update_node_prompt", nodeId: "brief_architect", kind: "prompt", prompt: op3Payload },
      { index: 11, tool: "workspace_update_node_prompt", nodeId: "brief_architect", kind: "prompt", prompt: op11Payload }
    ];
    const plan = planApply(ops, [makeNode({ id: "brief_architect", prompt: driftedValue })]);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(2);
    const op3Refusal = plan.refusals.find((r) => r.opIndex === 3)!;
    const op11Refusal = plan.refusals.find((r) => r.opIndex === 11)!;
    expect(op3Refusal.reason).toMatch(/shrink/);
    expect(op11Refusal.reason).toMatch(/does not match what op 11 expects as its base/);
  });

  it("refuses workspace_create_node when the store already has a same-id node that disagrees, field for field", () => {
    const ops: ParsedOp[] = [
      { index: 8, tool: "workspace_create_node", nodeId: "n1", kind: "create_node", node: makeNode({ id: "n1", prompt: "the canonical prompt this op wants", riskLevel: "read" }) }
    ];
    const plan = planApply(ops, [makeNode({ id: "n1", prompt: "some other prompt an operator wrote by hand", riskLevel: "write" })]);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toMatch(/differs from this op's payload/);
    expect(plan.refusals[0].reason).toContain("prompt");
    expect(plan.refusals[0].reason).toContain("riskLevel");
  });

  it("does NOT refuse workspace_create_node when the store's existing node already matches field-for-field (the documented 409-is-fine case)", () => {
    const node = makeNode({ id: "n1", prompt: "already seeded" });
    const ops: ParsedOp[] = [
      { index: 8, tool: "workspace_create_node", nodeId: "n1", kind: "create_node", node }
    ];
    const plan = planApply(ops, [{ ...node, updatedAt: "2026-05-01T00:00:00.000Z" }]);
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.upToDate).toEqual([{ opIndex: 8, nodeId: "n1", field: "node" }]);
  });
});
