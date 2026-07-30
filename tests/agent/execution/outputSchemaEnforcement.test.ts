import { describe, expect, it, vi } from "vitest";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { mockValueFromSchema } from "../../../src/agent/execution/mockOutputFromSchema.js";
import { MockNodeRunner, mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// CHANGE-PLAN R-16 / R-17, both found by T-2.
//
// T-2 ran the full pipeline in mock mode and found `article_body` reporting `completed`, persisting an
// artifact, and handing downstream nodes a value that failed ALL SIX required fields of its own output
// schema — because the mock fixture was a hand-written literal left behind when the node was
// generalized, and because nothing validated a node's output against its schema. `publish_payload` had
// the same defect quietly: its schema requires `summary` and its literal never supplied one.
//
// These tests lock both halves: fixtures are derived from schemas, and a violation fails the node.

const run = (): WorkflowExecutionRecord => ({ stageOutputs: {} } as unknown as WorkflowExecutionRecord);

describe("mock fixtures are derived from each node's own schema (R-17)", () => {
  // The drift guard. If a node's schema gains a constraint the generator cannot express, this fails
  // with the exact issues rather than letting a dry run "pass" on an invalid value.
  it("every canonical node's mock output satisfies that node's outputSchema", () => {
    const failures: string[] = [];
    for (const node of listWorkspaceNodes()) {
      const result = validateOutput(mockOutputForNode(node, run()), node.outputSchema);
      if (!result.ok) failures.push(`${node.id}: ${result.errors.join("; ")}`);
    }
    expect(failures, `mock output does not satisfy the node's own schema:\n${failures.join("\n")}`).toEqual([]);
  });

  it("covers article_body, the node whose hand-written fixture was wrong", () => {
    const node = listWorkspaceNodes().find((candidate) => candidate.id === "article_body")!;
    const output = mockOutputForNode(node, run()) as Record<string, unknown>;
    expect(validateOutput(output, node.outputSchema).ok).toBe(true);

    // The old literal, verbatim. It satisfied neither the seeded schema (which requires artifact and
    // summary) nor the live contract-driven one (which requires four more) — yet the node reported
    // completed and persisted it. This is the regression, and it must stay failing.
    const oldLiteral = { schema_version: "article_body.v1", nodes: [{ id: "n_dryRunIntro", kind: "content", visibility: "public", public: { title: "Dry-run article", body: "…" } }] };
    const seeded = validateOutput(oldLiteral, node.outputSchema);
    expect(seeded.ok).toBe(false);
    expect(!seeded.ok && seeded.errors.join("; ")).toMatch(/artifact|summary/);
  });

  // NOTE, and it is the bigger half of this finding: the schema asserted above is the SEEDED one from
  // src/agent/workspace/nodes.ts, because `resolveConductorNodes` defaults to `static`. The LIVE
  // workspace's article_body carries the contract-driven envelope — artifact, summary, clientProjectId,
  // clientObjectType, contractSource, body — and requires a `contract_intelligence` input that does not
  // exist in the seeded set at all. A conductor run therefore does not exercise the live definitions
  // unless WORKSPACE_NODES_SOURCE=store. See CHANGE-PLAN R-22.
  it("fails the live contract-driven envelope too, not merely the seeded schema", () => {
    // The live shape, transcribed from the deployed workspace (v85).
    const liveEnvelopeSchema = {
      type: "object",
      required: ["artifact", "summary", "clientProjectId", "clientObjectType", "contractSource", "body"],
      additionalProperties: true,
      properties: {
        artifact: { const: "article_body.v1" },
        summary: { type: "string", minLength: 1 },
        clientProjectId: { type: "string", minLength: 1 },
        clientObjectType: { type: "string", minLength: 1 },
        contractSource: { type: "object", additionalProperties: true },
        body: { type: "object", minProperties: 1, additionalProperties: true }
      }
    };
    const oldLiteral = { schema_version: "article_body.v1", nodes: [{ id: "n_dryRunIntro" }] };
    expect(validateOutput(oldLiteral, liveEnvelopeSchema).ok).toBe(false);

    // And the generator satisfies the live envelope, so flipping to store-sourced nodes will not need a
    // new fixture — which is the point of deriving fixtures from schemas.
    const generated = mockValueFromSchema(liveEnvelopeSchema, { summary: "Dry-run mock output.", dryRun: true });
    expect(validateOutput(generated, liveEnvelopeSchema).ok).toBe(true);
  });

  // A deliberately strict composite schema — the class the first version of this generator failed on.
  // (It used to be the workspace-local {schema_version, nodes} article monolith; R-6/R-23 deleted that
  // schema, so the stress-test keeps its shape-class without resurrecting the contract.) It exercises
  // everything the generator has to handle at once: additionalProperties:false, a pattern, an enum,
  // minItems, nested objects, `anyOf` branches, and `dependentRequired`.
  it("satisfies a strict deeply-nested composite schema (pattern + enum + minItems + anyOf + dependentRequired)", () => {
    const strictCompositeSchema = {
      type: "object",
      required: ["marker", "entries"],
      additionalProperties: false,
      properties: {
        marker: { const: "strict_composite.v1" },
        entries: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "kind", "fields"],
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^n_[A-Za-z0-9]+$" },
              kind: { type: "string", enum: ["content", "action"] },
              fields: {
                type: "object",
                additionalProperties: false,
                anyOf: [{ required: ["title"] }, { required: ["ctaText"] }],
                dependentRequired: { ctaText: ["ctaLink"], ctaLink: ["ctaText"] },
                properties: { title: { type: "string", minLength: 1 }, ctaText: { type: "string", minLength: 1 }, ctaLink: { type: "string", minLength: 1 } }
              }
            }
          }
        }
      }
    };
    const generated = mockValueFromSchema(strictCompositeSchema, { dryRun: true, nodeId: "article_body" });
    const validation = validateOutput(generated, strictCompositeSchema);
    expect(validation.ok, !validation.ok ? validation.errors.join("; ") : "").toBe(true);
    // Proof the anyOf branch was actually resolved rather than left as an empty object.
    expect(generated).toMatchObject({ marker: "strict_composite.v1" });
    const first = (generated as { entries: Array<{ id: string; fields: Record<string, unknown> }> }).entries[0];
    expect(first.id).toMatch(/^n_[A-Za-z0-9]+$/);
    expect(Object.keys(first.fields).length).toBeGreaterThan(0);
  });

  it("covers publish_payload, whose fixture omitted the required summary", () => {
    const node = listWorkspaceNodes().find((candidate) => candidate.id === "publish_payload")!;
    const output = mockOutputForNode(node, run()) as Record<string, unknown>;
    expect(output.summary).toBeTypeOf("string");
    expect(output.artifact).toBe("dry_run_publish_payload.v1");
    expect(validateOutput(output, node.outputSchema).ok).toBe(true);
  });

  it("still carries the dry-run markers a reader expects", async () => {
    const node = listWorkspaceNodes().find((candidate) => candidate.id === "input_triage")!;
    const result = await new MockNodeRunner().run({ node, input: {} }, { run: run() } as never);
    expect(result.ok).toBe(true);
    expect(result.ok && result.output).toMatchObject({ dryRun: true, nodeId: "input_triage" });
  });
});

describe("the executor enforces the schema (R-16)", () => {
  it("fails the node, and writes neither stage output nor artifact, when output violates its schema", async () => {
    // Force a runner that returns the exact literal T-2 caught in production. Before R-16 this reported
    // `completed`, persisted an artifact, and handed the value downstream.
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async () => ({ ok: true as const, output: { schema_version: "article_body.v1", nodes: [] } })
    } as never);

    try {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "x" }, store);
      const advanced = await runNextNode(started.runId, { executionRepository: store });
      const node = advanced.nodes.find((candidate) => candidate.nodeId === "input_triage")!;

      expect(node.status).toBe("failed");
      // The issues are named, so an operator sees which fields were missing rather than "it failed".
      expect(node.errors).toEqual(["output_schema_violation", "$.artifact is required", "$.summary is required"]);
      expect(advanced.status).toBe("failed");
      // Failing closed is the point: a malformed value must not reach a downstream node or the ledger.
      expect("input_triage" in advanced.stageOutputs).toBe(false);
      expect(advanced.artifacts).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("mockValueFromSchema", () => {
  it("honours const and enum over generated values", () => {
    expect(mockValueFromSchema({ const: "x.v1" })).toBe("x.v1");
    expect(mockValueFromSchema({ enum: ["first", "second"] })).toBe("first");
  });

  it("satisfies minLength rather than emitting a short string", () => {
    expect((mockValueFromSchema({ type: "string", minLength: 40 }) as string).length).toBeGreaterThanOrEqual(40);
  });

  it("fills required properties recursively", () => {
    const value = mockValueFromSchema({
      type: "object",
      required: ["outer"],
      properties: { outer: { type: "object", required: ["inner"], properties: { inner: { type: "string", minLength: 1 } } } }
    }) as { outer: { inner: string } };
    expect(value.outer.inner.length).toBeGreaterThan(0);
  });

  it("satisfies minProperties, which required alone does not cover", () => {
    // The live article_body schema declares `body: {type: object, minProperties: 1}`.
    const value = mockValueFromSchema({ type: "object", minProperties: 2 }) as Record<string, unknown>;
    expect(Object.keys(value).length).toBeGreaterThanOrEqual(2);
  });

  it("satisfies minItems", () => {
    expect(mockValueFromSchema({ type: "array", minItems: 2, items: { type: "string", minLength: 1 } })).toHaveLength(2);
  });

  it("does not pollute a strict object with undeclared hint keys", () => {
    // A hint must never be the reason a strict schema fails.
    const value = mockValueFromSchema(
      { type: "object", additionalProperties: false, required: ["declared"], properties: { declared: { type: "string", minLength: 1 } } },
      { dryRun: true, nodeId: "x" }
    ) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["declared"]);
  });

  it("applies hints where the schema is open", () => {
    const value = mockValueFromSchema({ type: "object", additionalProperties: true }, { dryRun: true }) as Record<string, unknown>;
    expect(value.dryRun).toBe(true);
  });

  it("takes the first member of a type union", () => {
    expect(mockValueFromSchema({ type: ["object", "boolean"] })).toEqual({});
  });

  it("handles boolean schemas", () => {
    expect(mockValueFromSchema(true)).toEqual({});
    expect(mockValueFromSchema(false)).toBeUndefined();
  });

  it("makes a best effort at a declared pattern", () => {
    expect(mockValueFromSchema({ type: "string", pattern: "^n_[A-Za-z0-9]+$" })).toMatch(/^n_[A-Za-z0-9]+$/);
  });

  it("resolves anyOf by generating a candidate per branch and keeping one that validates", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["title"] }, { required: ["body"] }],
      properties: { title: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 } }
    };
    const value = mockValueFromSchema(schema);
    expect(validateOutput(value, schema).ok).toBe(true);
    expect(Object.keys(value as object).length).toBeGreaterThan(0);
  });

  it("respects dependentRequired when choosing an anyOf branch", () => {
    // ctaText and ctaLink require each other, so a branch naming only one of them must be rejected in
    // favour of a branch that validates. Guessing the first branch would produce an invalid value.
    const schema = {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["ctaText"] }, { required: ["title"] }],
      dependentRequired: { ctaText: ["ctaLink"], ctaLink: ["ctaText"] },
      properties: { ctaText: { type: "string", minLength: 1 }, ctaLink: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 } }
    };
    const value = mockValueFromSchema(schema);
    expect(validateOutput(value, schema).ok).toBe(true);
  });

  it("treats oneOf the same way", () => {
    const schema = { oneOf: [{ type: "string", minLength: 3 }, { type: "number" }] };
    expect(validateOutput(mockValueFromSchema(schema), schema).ok).toBe(true);
  });

  it("merges allOf branches, since all of them apply at once", () => {
    const schema = {
      allOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string", minLength: 1 } } },
        { required: ["b"], properties: { b: { type: "integer", minimum: 5 } } }
      ]
    };
    const value = mockValueFromSchema(schema) as { a: string; b: number };
    expect(value.a.length).toBeGreaterThan(0);
    expect(value.b).toBeGreaterThanOrEqual(5);
    expect(validateOutput(value, schema).ok).toBe(true);
  });
});
