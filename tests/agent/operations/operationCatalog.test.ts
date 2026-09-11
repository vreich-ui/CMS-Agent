import { afterEach, describe, expect, it } from "vitest";
import {
  __resetOperationCatalogForTests,
  getOperation,
  listOperationIds,
  listOperations,
  listOperationVersions,
  registerOperation
} from "../../../src/agent/operations/operationCatalog.js";
import type { OperationDescriptor } from "../../../src/agent/operations/operationTypes.js";

const descriptor = (overrides: Partial<OperationDescriptor> = {}): OperationDescriptor => ({
  operationId: "fixture_op",
  version: 1,
  title: "Fixture operation",
  summary: "A fixture used only by operationCatalog.test.ts.",
  surface: null,
  inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
  defaults: {},
  requiredCapabilities: [],
  effects: [],
  completion: [],
  intentKeywords: ["fixture"],
  ...overrides
});

describe("operationCatalog", () => {
  afterEach(() => {
    __resetOperationCatalogForTests();
  });

  it("throws registering the same operationId@version twice", () => {
    registerOperation(descriptor());
    expect(() => registerOperation(descriptor())).toThrow(/already registered: fixture_op@1/);
  });

  it("allows a second version of the same operationId", () => {
    registerOperation(descriptor({ version: 1 }));
    registerOperation(descriptor({ version: 2, title: "Fixture v2" }));
    expect(listOperationVersions("fixture_op").map((d) => d.version)).toEqual([1, 2]);
  });

  it("getOperation with no version returns the highest registered version", () => {
    registerOperation(descriptor({ version: 1 }));
    registerOperation(descriptor({ version: 3, title: "Fixture v3" }));
    registerOperation(descriptor({ version: 2, title: "Fixture v2" }));
    const lookup = getOperation("fixture_op");
    expect(lookup.found).toBe(true);
    if (lookup.found) expect(lookup.descriptor.version).toBe(3);
  });

  it("getOperation with an explicit version returns exactly that version", () => {
    registerOperation(descriptor({ version: 1 }));
    registerOperation(descriptor({ version: 2, title: "Fixture v2" }));
    const lookup = getOperation("fixture_op", 1);
    expect(lookup.found).toBe(true);
    if (lookup.found) expect(lookup.descriptor.version).toBe(1);
  });

  it("listOperations is sorted by operationId and deterministic across calls", () => {
    registerOperation(descriptor({ operationId: "zeta_op" }));
    registerOperation(descriptor({ operationId: "alpha_op" }));
    registerOperation(descriptor({ operationId: "mid_op" }));
    const first = listOperations().map((d) => d.operationId);
    const second = listOperations().map((d) => d.operationId);
    expect(first).toEqual(["alpha_op", "mid_op", "zeta_op"]);
    expect(second).toEqual(first);
  });

  it("listOperationIds matches listOperations and is sorted", () => {
    registerOperation(descriptor({ operationId: "beta_op" }));
    registerOperation(descriptor({ operationId: "alpha_op" }));
    expect(listOperationIds()).toEqual(["alpha_op", "beta_op"]);
  });

  it("an unregistered operationId returns a structured unknown-operation result naming the registered alternatives, never echoing the caller's string as a usable id", () => {
    registerOperation(descriptor({ operationId: "real_op" }));
    const lookup = getOperation("totally_made_up_id_12345");
    expect(lookup.found).toBe(false);
    if (!lookup.found) {
      expect(lookup.operationId).toBe("totally_made_up_id_12345");
      expect(lookup.registeredOperationIds).toEqual(["real_op"]);
    }
    // The unknown id is echoed back only as data describing what was ASKED for — never turned into
    // something resolvable. Confirm the catalog genuinely has no entry under it, in any version.
    expect(listOperationVersions("totally_made_up_id_12345")).toEqual([]);
  });

  it("an unregistered operationId with an empty catalog still returns a structured result (empty alternatives, not a throw)", () => {
    const lookup = getOperation("nothing_registered_yet");
    expect(lookup.found).toBe(false);
    if (!lookup.found) expect(lookup.registeredOperationIds).toEqual([]);
  });

  it("rejects a non-snake_case operationId at registration", () => {
    expect(() => registerOperation(descriptor({ operationId: "NotSnakeCase" }))).toThrow(/snake_case/);
  });

  it("rejects a non-positive-integer version at registration", () => {
    expect(() => registerOperation(descriptor({ version: 0 }))).toThrow(/version/);
    expect(() => registerOperation(descriptor({ version: 1.5 }))).toThrow(/version/);
  });
});
