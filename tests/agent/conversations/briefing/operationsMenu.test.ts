import { describe, expect, it } from "vitest";
import {
  renderOperationLine,
  renderOperationsMenu,
  requiredInputsFor,
  resolveAutonomyMode
} from "../../../../src/agent/conversations/briefing/operationsMenu.js";
import { listOperations } from "../../../../src/agent/operations/operationCatalog.js";
// Side-effect import: the catalog is empty until the six built-ins register themselves. Mirrors the
// module under test's own import of this file.
import "../../../../src/agent/operations/registerOperations.js";
import type { OperationDescriptor } from "../../../../src/agent/operations/operationTypes.js";

const findOperation = (operationId: string): OperationDescriptor => {
  const descriptor = listOperations().find((entry) => entry.operationId === operationId);
  if (!descriptor) throw new Error(`Test setup: expected the catalog to carry "${operationId}"`);
  return descriptor;
};

describe("operationsMenu — the plan's acceptance", () => {
  // The plan's own acceptance test: one menu line per registered descriptor, no more, no fewer. A
  // menu that silently dropped or duplicated an operation would send the model into a turn believing
  // the house can (or cannot) do something the catalog actually says the opposite of.
  it("renders exactly one bullet line per registered operation descriptor", () => {
    const descriptors = listOperations();
    const menu = renderOperationsMenu("operator-gated", descriptors);
    const bulletLines = menu.split("\n").filter((line) => line.startsWith("- "));
    expect(bulletLines).toHaveLength(descriptors.length);
    expect(descriptors.length).toBeGreaterThan(0);
  });

  // Every registered operation id must be nameable from the menu itself — the whole point is that the
  // model never has to call the catalog to learn what exists.
  it("names every registered operation id, backtick-quoted", () => {
    const descriptors = listOperations();
    const menu = renderOperationsMenu("operator-gated", descriptors);
    for (const descriptor of descriptors) {
      expect(menu).toContain(`\`${descriptor.operationId}\``);
    }
  });

  // ProjectPublishingPolicy's own doc comment and genesisParity.ts both read an absent autonomyMode
  // as "operator-gated" — the cautious reading. A default that quietly resolved to "autonomous"
  // instead would let a tenant nobody has decided about run gate-free.
  it("resolves an unset autonomyMode to operator-gated, never the permissive value", () => {
    expect(resolveAutonomyMode(undefined)).toBe("operator-gated");
    expect(resolveAutonomyMode({})).toBe("operator-gated");
    expect(resolveAutonomyMode({ autonomyMode: undefined })).toBe("operator-gated");
  });

  // THE REVIEW FINDING THIS WALLS OFF. An earlier cut derived a per-operation approval sentence from
  // the descriptor's peak `effects[].riskLevel`, and it was already wrong for one of the six:
  // `image_template_revision` declares "write", but the workflow it binds to runs
  // `image_revision_apply` at riskLevel "publish" behind a registered gate — so the menu told the
  // model that operation starts freely on an autonomous tenant and the code then refused it. A
  // descriptor's declared effects are not the gate (operationTypes.ts's own header says so), so no
  // per-operation line may make an approval claim at all. The house's autonomy is stated ONCE, from
  // the project record, in the block header.
  it("makes no per-operation approval claim — not from riskLevel, not for any operation", () => {
    for (const descriptor of listOperations()) {
      const line = renderOperationLine(descriptor);
      expect(line).not.toMatch(/approv|without asking|propose it before/i);
    }
  });

  // The autonomy statement is a RECORD FACT and belongs to the block, not to a line. Both modes must
  // say something, and they must say opposite things — an operator-gated house that read as
  // autonomous is the failure that matters.
  it("states the house's autonomy once, in the block header, and says opposite things in the two modes", () => {
    const autonomous = renderOperationsMenu("autonomous");
    const gated = renderOperationsMenu("operator-gated");

    expect(autonomous).toContain("This house runs autonomously, so start these rather than proposing them.");
    expect(autonomous).toMatch(/that is a blockage to report — not a question to ask/);
    expect(autonomous).not.toMatch(/propose the work once/);

    expect(gated).toContain("This house is operator-gated, so propose the work once");
    expect(gated).not.toMatch(/start these rather than proposing them/);

    // Exactly once, not once per operation.
    expect(autonomous.split("This house runs autonomously").length - 1).toBe(1);
  });

  // A descriptor's `defaults` answers a required input on the editor's behalf; asking for it anyway
  // would contradict the descriptor's own declared behaviour (preflight echoes the default it applied
  // rather than demanding the caller supply it).
  it("drops a required input from the menu's 'Needs' line when the descriptor's own defaults already answer it", () => {
    const descriptor: OperationDescriptor = {
      operationId: "test_op",
      version: 1,
      title: "Test operation",
      summary: "A synthetic descriptor for requiredInputsFor's drop-if-defaulted rule.",
      inputSchema: { type: "object", required: ["tenantId", "locale", "familyId"], properties: {} },
      defaults: { locale: "en-US" },
      requiredCapabilities: [],
      effects: [],
      completion: [],
      intentKeywords: []
    };
    expect(requiredInputsFor(descriptor)).toEqual(["tenantId", "familyId"]);

    const line = renderOperationLine(descriptor);
    expect(line).toContain("Needs: tenantId, familyId.");
    expect(line).not.toContain("locale");
  });

  // The zero-required-inputs case renders a phrase, never an empty "Needs:" the editor has to parse.
  it("reports 'nothing the editor has to supply' when every required input is defaulted or none exist", () => {
    const descriptor: OperationDescriptor = {
      operationId: "no_inputs_op",
      version: 1,
      title: "No inputs",
      summary: "Everything this operation needs is a default.",
      inputSchema: { type: "object", required: ["locale"], properties: {} },
      defaults: { locale: "en-US" },
      requiredCapabilities: [],
      effects: [],
      completion: [],
      intentKeywords: []
    };
    expect(requiredInputsFor(descriptor)).toEqual([]);
    expect(renderOperationLine(descriptor)).toContain("Needs: nothing the editor has to supply.");
  });
});
