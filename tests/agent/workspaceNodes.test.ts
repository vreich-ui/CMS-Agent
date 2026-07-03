import { describe, expect, it } from "vitest";
import { listWorkspaceNodes, validateWorkspaceGraph } from "../../src/agent/workspace/nodes.js";

describe("Publishing Conductor workspace nodes", () => {
  it("defines the full 18-node graph", () => {
    expect(listWorkspaceNodes()).toHaveLength(18);
  });

  it("has no duplicate ids", () => {
    const ids = listWorkspaceNodes().map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has valid dependencies and graph invariants", () => {
    expect(validateWorkspaceGraph()).toEqual({ valid: true, issues: [] });
  });

  it("marks article_body as the canonical article_body.v1 producer", () => {
    expect(listWorkspaceNodes().find((node) => node.id === "article_body")?.produces).toContain("article_body.v1");
  });

  it("connects publish_payload after article_body", () => {
    expect(listWorkspaceNodes().find((node) => node.id === "publish_payload")?.dependsOn).toContain("article_body");
  });

  it("marks publication_controller as publish risk", () => {
    expect(listWorkspaceNodes().find((node) => node.id === "publication_controller")?.riskLevel).toBe("publish");
  });
});
